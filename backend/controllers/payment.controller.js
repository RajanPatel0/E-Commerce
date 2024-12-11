import Coupon from "../models/coupon.model.js";
import Order from "../models/order.model.js";
import { razorpay } from "../lib/razorpay.js";

export const createCheckoutSession = async (req, res) => {
  try {
    const { products, couponCode } = req.body;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: "Invalid or empty products array" });
    }

    let totalAmount = 0;

    const lineItems = products.map((product) => {
      totalAmount += product.price * 100 *80 * product.quantity; // Razorpay works with paise
      return {
        name: product.name,
        image: product.image,
        price: product.price,
        quantity: product.quantity || 1,
      };
    });

    let coupon = null;
    if (couponCode) {
      coupon = await Coupon.findOne({ code: couponCode, userId: req.user._id, isActive: true });
      if (coupon) {
        totalAmount -= Math.round((totalAmount * coupon.discountPercentage) / 100);
      }
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: totalAmount, // amount in paise
      currency: "INR",
      receipt: `order_rcptid_${Math.random().toString(36).substring(2, 8)}`,
      notes: {
        userId: req.user._id.toString(),
        products: JSON.stringify(
          products.map((p) => ({
            id: p._id,
            quantity: p.quantity,
            price: p.price,
          }))
        ),
        couponCode: couponCode || "",
      },
    });

    if (totalAmount >= 2000000) {
      await createNewCoupon(req.user._id);
    }

    res.status(200).json({ orderId: razorpayOrder.id, totalAmount: totalAmount / 100 });
  } catch (error) {
    console.error("Error processing checkout:", error);
    res.status(500).json({ message: "Error processing checkout", error: error.message });
  }
};

import crypto from "crypto";

export const checkoutSuccess = async (req, res) => {
  try {
    const { razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body;

    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (generatedSignature !== razorpaySignature) {
      return res.status(400).json({ message: "Payment verification failed" });
    }

    const razorpayOrder = await razorpay.orders.fetch(razorpayOrderId);

    if (razorpayOrder.notes.couponCode) {
      await Coupon.findOneAndUpdate(
        {
          code: razorpayOrder.notes.couponCode,
          userId: razorpayOrder.notes.userId,
        },
        {
          isActive: false,
        }
      );
    }

    // Create a new Order
    const products = JSON.parse(razorpayOrder.notes.products);
    const newOrder = new Order({
      user: razorpayOrder.notes.userId,
      products: products.map((product) => ({
        product: product.id,
        quantity: product.quantity,
        price: product.price,
      })),
      totalAmount: razorpayOrder.amount / 100, // Convert from paise to rupees
      razorpayOrderId,
      razorpayPaymentId,
    });

    await newOrder.save();

    res.status(200).json({
      success: true,
      message: "Payment successful, order created, and coupon deactivated if used.",
      orderId: newOrder._id,
    });
  } catch (error) {
    console.error("Error processing successful checkout:", error);
    res.status(500).json({ message: "Error processing successful checkout", error: error.message });
  }
};
