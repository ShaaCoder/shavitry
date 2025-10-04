/**
 * Order by ID API Routes
 * 
 * GET /api/orders/[id] - Get order by ID
 */

import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/nextauth';
import connectDB from '@/lib/mongodb';
import Order from '@/models/Order';
import User from '@/models/User';
import {
  createSuccessResponse,
  createErrorResponse,
  handleApiError,
  rateLimit,
  getClientIP,
  withAuth
} from '@/lib/api-helpers';
import { emitOrderEvent } from '@/lib/sse';
import { validateObjectId } from '@/lib/validations';
import { OrderResponse } from '@/types/order';
import emailService from '@/lib/email-service';
import Product from '@/models/Product';


interface RouteParams {
  params: {
    id: string;
  };
}

/**
 * PATCH /api/orders/[id]
 * Admin: update order status/payment/shipping
 */
export async function PATCH(
  request: NextRequest,
  { params }: RouteParams
) {
  return withAuth(async (req, currentUser) => {
    try {
      await connectDB();

      const clientIP = getClientIP(req);
      const rl = rateLimit(`order_patch_${clientIP}`, 30, 60000);
      if (!rl.allowed) {
        return createErrorResponse('Too many requests', 429, 'Rate limit exceeded');
      }

      // Admin only
      if (currentUser.role !== 'admin') {
        return createErrorResponse('Insufficient permissions', 403, 'Authorization Error');
      }

      const idValidation = validateObjectId(params.id);
      const findQuery = idValidation.isValid ? { _id: params.id } : { orderNumber: params.id };

      const body = await req.json();
      const {
        // status/payment/tracking updates (existing behavior)
        status, paymentStatus, trackingNumber, carrier, expectedDeliveryAt, shippedAt, deliveredAt, paymentAt, confirmedAt,
        // admin edit fields
        items: newItems,
        shippingAddress: newShippingAddress,
        shipping: newShippingCost,
        discount: newDiscount,
        reason: adminReason
      } = body || {};

      // Fetch current order first (needed for both paths)
      const currentOrder = await Order.findOne(findQuery);
      if (!currentOrder) {
        return createErrorResponse('Order not found', 404, 'Not Found');
      }

      // If admin is editing order details (items/address/prices) handle that branch
      const isAdminEdit = newItems || newShippingAddress || newShippingCost !== undefined || newDiscount !== undefined;
      if (isAdminEdit) {
        // Guard: only allow before shipment
        const hasShipment = Boolean(currentOrder.status === 'shipped' || currentOrder.status === 'delivered' || currentOrder.trackingNumber || (currentOrder as any).shippingDetails?.shipmentId);
        if (hasShipment) {
          return createErrorResponse('Order cannot be edited after shipment has been created or shipped', 400, 'Invalid State');
        }

        // Build updated fields
        const updateDoc: any = {};
        const changes: string[] = [];

        // Items editing with inventory adjustments
        if (Array.isArray(newItems)) {
          // Normalize items and validate
          const normalizedItems = newItems.map((it: any) => ({
            productId: String(it.productId),
            name: String(it.name),
            price: Number(it.price),
            image: String(it.image),
            quantity: Number(it.quantity),
            variant: it.variant ? String(it.variant) : undefined,
          }));

          // Compute deltas by productId between current and new items
          const currentQuantities: Record<string, number> = {};
          (currentOrder.items as any[]).forEach((it: any) => {
            currentQuantities[it.productId] = (currentQuantities[it.productId] || 0) + Number(it.quantity);
          });
          const newQuantities: Record<string, number> = {};
          normalizedItems.forEach((it: any) => {
            newQuantities[it.productId] = (newQuantities[it.productId] || 0) + Number(it.quantity);
          });

          const productIds = Array.from(new Set([...Object.keys(currentQuantities), ...Object.keys(newQuantities)]));

          // Apply stock adjustments atomically-ish: check availability for increases
          for (const pid of productIds) {
            const oldQty = currentQuantities[pid] || 0;
            const newQty = newQuantities[pid] || 0;
            const delta = newQty - oldQty; // positive means need to deduct stock
            if (delta !== 0) {
              const product = await Product.findById(pid);
              if (!product) {
                return createErrorResponse(`Product ${pid} not found while editing order`, 400, 'Validation Error');
              }
              if (delta > 0 && product.stock < delta) {
                return createErrorResponse(`Insufficient stock for product ${pid}. Required ${delta}, available ${product.stock}`, 400, 'Validation Error');
              }
            }
          }

          // All checks passed: apply stock updates
          for (const pid of productIds) {
            const oldQty = currentQuantities[pid] || 0;
            const newQty = newQuantities[pid] || 0;
            const delta = newQty - oldQty;
            if (delta !== 0) {
              await Product.updateOne({ _id: pid }, { $inc: { stock: -delta } }); // if delta negative, -delta adds back stock
            }
          }

          updateDoc.items = normalizedItems;
          changes.push('items');
        }

        if (newShippingAddress) {
          updateDoc.shippingAddress = newShippingAddress;
          changes.push('shippingAddress');
        }
        if (newShippingCost !== undefined) {
          updateDoc.shipping = Math.max(0, Number(newShippingCost));
          changes.push('shipping');
        }
        if (newDiscount !== undefined) {
          updateDoc.discount = Math.max(0, Number(newDiscount));
          changes.push('discount');
        }

        // Recalculate totals (since findOneAndUpdate won't trigger pre-save)
        const itemsForCalc = updateDoc.items || (currentOrder.items as any[]);
        const subtotal = itemsForCalc.reduce((sum: number, it: any) => sum + (Number(it.price) * Number(it.quantity)), 0);
        const shipping = updateDoc.shipping !== undefined ? updateDoc.shipping : currentOrder.shipping;
        const discount = updateDoc.discount !== undefined ? updateDoc.discount : currentOrder.discount;
        updateDoc.subtotal = subtotal;
        updateDoc.total = Math.max(0, subtotal + Number(shipping) - Number(discount));

        // Append audit log entry
        const auditEntry = {
          byUserId: String(currentUser._id || (currentUser as any).id || ''),
          byName: (currentUser as any).name || 'Admin',
          byEmail: (currentUser as any).email || '',
          at: new Date(),
          reason: adminReason || 'Admin edit before shipment',
          changes,
        } as any;

        const updated = await Order.findOneAndUpdate(
          findQuery,
          { $set: updateDoc, $push: { auditLog: auditEntry } },
          { new: true }
        ).lean();

        if (!updated) {
          return createErrorResponse('Order not found after update', 404, 'Not Found');
        }

        const formatted: OrderResponse = {
          id: updated._id.toString(),
          orderNumber: updated.orderNumber,
          userId: updated.userId,
          items: updated.items,
          total: updated.total,
          subtotal: updated.subtotal,
          shipping: updated.shipping,
          discount: updated.discount,
          status: updated.status,
          paymentStatus: updated.paymentStatus,
          shippingAddress: updated.shippingAddress,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
          paymentAt: updated.paymentAt ? updated.paymentAt.toISOString() : undefined,
          confirmedAt: updated.confirmedAt ? updated.confirmedAt.toISOString() : undefined,
          shippedAt: updated.shippedAt ? updated.shippedAt.toISOString() : undefined,
          deliveredAt: updated.deliveredAt ? updated.deliveredAt.toISOString() : undefined,
          expectedDeliveryAt: updated.expectedDeliveryAt ? updated.expectedDeliveryAt.toISOString() : undefined,
        };

        emitOrderEvent('updated', { id: formatted.id, orderNumber: formatted.orderNumber, status: formatted.status, updatedAt: formatted.updatedAt });
        return createSuccessResponse(formatted, 'Order edited successfully');
      }

      // Existing: status/payment/tracking branch
      const allowedStatus = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
      const allowedPayment = ['pending', 'completed', 'failed'];

      const update: any = {};
      if (status) {
        if (!allowedStatus.includes(status)) {
          return createErrorResponse('Invalid status value', 400, 'Validation Error');
        }
        update.status = status;
      }
      if (paymentStatus) {
        if (!allowedPayment.includes(paymentStatus)) {
          return createErrorResponse('Invalid paymentStatus value', 400, 'Validation Error');
        }
        update.paymentStatus = paymentStatus;
      }
      if (trackingNumber !== undefined) update.trackingNumber = trackingNumber;
      if (carrier !== undefined) update.carrier = carrier;

      if (expectedDeliveryAt) update.expectedDeliveryAt = new Date(expectedDeliveryAt);
      if (shippedAt) update.shippedAt = new Date(shippedAt);
      if (deliveredAt) update.deliveredAt = new Date(deliveredAt);
      if (paymentAt) update.paymentAt = new Date(paymentAt);
      if (confirmedAt) update.confirmedAt = new Date(confirmedAt);

      if (Object.keys(update).length === 0) {
        return createErrorResponse('No valid fields to update', 400, 'Validation Error');
      }

      // Update the order
      const order = await Order.findOneAndUpdate(
        findQuery,
        { $set: update },
        { new: true }
      ).lean();

      if (!order) {
        return createErrorResponse('Order not found', 404, 'Not Found');
      }
      
      // Send confirmation email if status changed to 'confirmed' and email hasn't been sent
      if (status === 'confirmed' && currentOrder.status !== 'confirmed' && !currentOrder.confirmationEmailSent) {
        console.log('📧 Order status changed to confirmed, sending confirmation email...');
        
        try {
          // Get customer details
          const customer = await User.findById(order.userId).select('name email');
          
          if (customer && customer.email) {
            // Use the simplified email approach that we know works
            const nodemailer = (await import('nodemailer')).default;
            const fs = await import('fs');
            const path = await import('path');
            
            const transporter = nodemailer.createTransport({
              host: 'smtp.gmail.com',
              port: 587,
              secure: false,
              auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASSWORD,
              },
              tls: {
                rejectUnauthorized: false,
              },
            });
            
            // Load and process template
            const templatePath = path.join(process.cwd(), 'lib', 'email-templates', 'order-confirmation.html');
            let htmlTemplate = fs.readFileSync(templatePath, 'utf-8');
            
            // Simple template replacement
            htmlTemplate = htmlTemplate
              .replace(/{{orderNumber}}/g, order.orderNumber)
              .replace(/{{orderDate}}/g, new Date(order.createdAt).toLocaleDateString())
              .replace(/{{customerName}}/g, customer.name)
              .replace(/{{customerEmail}}/g, customer.email)
              .replace(/{{subtotal}}/g, order.subtotal.toFixed(2))
              .replace(/{{shipping}}/g, order.shipping.toFixed(2))
              .replace(/{{total}}/g, order.total.toFixed(2))
              .replace(/{{shippingAddress\.name}}/g, order.shippingAddress.name)
              .replace(/{{shippingAddress\.address}}/g, order.shippingAddress.address)
              .replace(/{{shippingAddress\.city}}/g, order.shippingAddress.city)
              .replace(/{{shippingAddress\.state}}/g, order.shippingAddress.state)
              .replace(/{{shippingAddress\.pincode}}/g, order.shippingAddress.pincode)
              .replace(/{{shippingAddress\.phone}}/g, order.shippingAddress.phone)
              .replace(/{{trackingUrl}}/g, `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/orders/${order._id}`)
              .replace(/{{companyName}}/g, 'Your E-commerce Store')
              .replace(/{{companyAddress}}/g, 'Your Store Address')
              .replace(/{{supportUrl}}/g, `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/support`)
              .replace(/{{returnUrl}}/g, `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/returns`)
              .replace(/{{unsubscribeUrl}}/g, `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/unsubscribe`);
            
            // Handle items
            const itemsHtml = order.items.map((item: any) => `
              <div class=\"order-item\">\n                <img src=\"${item.image}\" alt=\"${item.name}\" class=\"item-image\">\n                <div class=\"item-details\">\n                  <div class=\"item-name\">${item.name}</div>\n                  ${item.variant ? `<div class=\"item-variant\">${item.variant}</div>` : ''}\n                  <div class=\"item-quantity\">Quantity: ${item.quantity}</div>\n                </div>\n                <div class=\"item-price\">₹${item.price.toFixed(2)}</div>\n              </div>
            `).join('');
            
            htmlTemplate = htmlTemplate.replace(/\{\{#each items\}\}[\s\S]*?\{\{\/each\}\}/g, itemsHtml);
            htmlTemplate = htmlTemplate.replace(/\{\{#if discount\}\}[\s\S]*?\{\{\/if\}\}/g, order.discount > 0 ? `<div class=\"total-row\"><span>Discount:</span><span>-₹${order.discount.toFixed(2)}</span></div>` : '');
            
            // Send email
            const mailOptions = {
              from: {
                name: process.env.EMAIL_FROM_NAME || 'E-commerce Store',
                address: process.env.EMAIL_FROM_ADDRESS || process.env.EMAIL_USER || 'noreply@example.com',
              },
              to: customer.email,
              subject: `Order Confirmation - ${order.orderNumber}`,
              html: htmlTemplate,
              text: `Your order ${order.orderNumber} has been confirmed. Total: ₹${order.total.toFixed(2)}`,
            };
            
            const result = await transporter.sendMail(mailOptions);
            
            // Update order to mark email as sent
            await Order.findOneAndUpdate(
              findQuery,
              {
                $set: {
                  confirmationEmailSent: true,
                  confirmationEmailSentAt: new Date()
                }
              }
            );
            
            console.log('✅ Confirmation email sent successfully for order:', order.orderNumber);
            console.log('📨 Message ID:', (result as any).messageId);
          } else {
            console.log('⚠️  No customer email found for order:', order.orderNumber);
          }
        } catch (emailError) {
          console.error('❌ Failed to send confirmation email:', emailError);
          // Don't fail the order update if email fails
        }
      }

      const formatted: OrderResponse = {
        id: order._id.toString(),
        orderNumber: order.orderNumber,
        userId: order.userId,
        items: order.items,
        total: order.total,
        subtotal: order.subtotal,
        shipping: order.shipping,
        discount: order.discount,
        status: order.status,
        paymentStatus: order.paymentStatus,
        shippingAddress: order.shippingAddress,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
        paymentAt: order.paymentAt ? order.paymentAt.toISOString() : undefined,
        confirmedAt: order.confirmedAt ? order.confirmedAt.toISOString() : undefined,
        shippedAt: order.shippedAt ? order.shippedAt.toISOString() : undefined,
        deliveredAt: order.deliveredAt ? order.deliveredAt.toISOString() : undefined,
        expectedDeliveryAt: order.expectedDeliveryAt ? order.expectedDeliveryAt.toISOString() : undefined,
      };

      // Emit SSE event
      emitOrderEvent('updated', { id: formatted.id, orderNumber: formatted.orderNumber, status: formatted.status, paymentStatus: formatted.paymentStatus, updatedAt: formatted.updatedAt });
      return createSuccessResponse(formatted, 'Order updated successfully');
    } catch (error) {
      return handleApiError(error, `PATCH /api/orders/${params.id}`);
    }
  })(request);
}

/**
 * GET /api/orders/[id]
 * Retrieve a specific order by ID
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    await connectDB();

    // Get session using NextAuth
    const session = await getServerSession(authOptions);
    
    if (!session || !session.user) {
      return createErrorResponse(
        'Authentication required',
        401,
        'Unauthorized'
      );
    }

    // Get user from database using session info
    const currentUser = await User.findOne({ 
      email: session.user.email 
    }).select('-password');

    if (!currentUser) {
      return createErrorResponse(
        'User not found',
        404,
        'Not Found'
      );
    }

    // Rate limiting
    const clientIP = getClientIP(request);
    const rateLimitResult = rateLimit(`order_get_${clientIP}`, 100, 60000);
    
    if (!rateLimitResult.allowed) {
      return createErrorResponse(
        'Too many requests',
        429,
        'Rate limit exceeded'
      );
    }

      // Accept either ObjectId or orderNumber
      const idValidation = validateObjectId(params.id);
      const order = await (idValidation.isValid 
        ? Order.findById(params.id).lean() 
        : Order.findOne({ orderNumber: params.id }).lean());

      if (!order) {
        return createErrorResponse(
          'Order not found',
          404,
          'Not Found'
        );
      }

      // Check permissions - users can only view their own orders unless admin
      if (currentUser.role !== 'admin' && order.userId !== currentUser._id.toString()) {
        return createErrorResponse(
          'Access denied',
          403,
          'Authorization Error'
        );
      }

      // Format response
      const formattedOrder: OrderResponse = {
  id: order._id.toString(),
  orderNumber: order.orderNumber,
  userId: order.userId,
  items: order.items,
  total: order.total,
  subtotal: order.subtotal,
  shipping: order.shipping,
  discount: order.discount,
  status: order.status,
  paymentStatus: order.paymentStatus,
  shippingAddress: order.shippingAddress,
  createdAt: order.createdAt.toISOString(),
  updatedAt: order.updatedAt.toISOString(),
  paymentAt: order.paymentAt ? order.paymentAt.toISOString() : undefined,
  confirmedAt: order.confirmedAt ? order.confirmedAt.toISOString() : undefined,
  shippedAt: order.shippedAt ? order.shippedAt.toISOString() : undefined,
  deliveredAt: order.deliveredAt ? order.deliveredAt.toISOString() : undefined,
  expectedDeliveryAt: order.expectedDeliveryAt ? order.expectedDeliveryAt.toISOString() : undefined,
};


    return createSuccessResponse<OrderResponse>(
      formattedOrder,
      'Order retrieved successfully'
    );

  } catch (error) {
    return handleApiError(error, `GET /api/orders/${params.id}`);
  }
}

/**
 * DELETE /api/orders/[id]
 * Admin: delete order by _id or orderNumber
 */
export async function DELETE(
  request: NextRequest,
  { params }: RouteParams
) {
  return withAuth(async (req, currentUser) => {
    try {
      await connectDB();

      // Admin only
      if (currentUser.role !== 'admin') {
        return createErrorResponse('Insufficient permissions', 403, 'Authorization Error');
      }

      const idValidation = validateObjectId(params.id);
      const findQuery = idValidation.isValid ? { _id: params.id } : { orderNumber: params.id };

      const order = await Order.findOne(findQuery).lean();
      if (!order) {
        return createErrorResponse('Order not found', 404, 'Not Found');
      }

      await Order.deleteOne(findQuery);

      // Emit SSE event
      emitOrderEvent('deleted', { id: order._id.toString(), orderNumber: order.orderNumber });

      return createSuccessResponse(null, 'Order deleted successfully');
    } catch (error) {
      return handleApiError(error, `DELETE /api/orders/${params.id}`);
    }
  })(request);
}