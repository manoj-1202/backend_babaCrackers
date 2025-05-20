const express = require("express");
const publicRouter = express.Router();
const adminRouter = express.Router();
const mongoose = require("mongoose");
const Order = require("../models/order");
const Customer = require("../models/customer");
const Product = require("../models/Product");
const nodemailer = require("nodemailer");
const Razorpay = require("razorpay");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const generateTrackingId = () => {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substr(2, 10);
  return `${timestamp}-${randomStr}`.toUpperCase();
};

const MINIMUM_ORDER_AMOUNT = 3000;

// Function to generate an image from HTML content
const generateImageFromHtml = async (htmlContent) => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: "networkidle0" });
    await page.setViewport({ width: 800, height: 1200, deviceScaleFactor: 2 });
    const imagePath = path.join(__dirname, `../temp/order-${Date.now()}.png`);
    await page.screenshot({ path: imagePath, fullPage: true });
    await browser.close();
    return imagePath;
  } catch (err) {
    console.error("Error generating image:", err);
    if (browser) await browser.close();
    throw err;
  }
};

// Public Routes (No Authentication)
publicRouter.post("/create-payment-order", async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < MINIMUM_ORDER_AMOUNT * 100) {
      return res.status(400).json({ message: `Minimum order amount is ₹${MINIMUM_ORDER_AMOUNT}.` });
    }

    const options = {
      amount: amount,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
    };

    const razorpayOrder = await razorpay.orders.create(options);
    res.json({
      razorpayOrderId: razorpayOrder.id,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("Error creating payment order:", err);
    res.status(500).json({ message: "Failed to create payment order", error: err.message });
  }
});

publicRouter.post("/place-order", async (req, res) => {
  try {
    const {
      name,
      email,
      mobile,
      address,
      cartItems,
      totalAmount,
      orderDate,
      paymentDetails,
    } = req.body;

    console.log("Received place-order request:", {
      name,
      email,
      mobile,
      address,
      totalAmount,
      orderDate,
      cartItems,
      paymentDetails,
    });

    if (
      !name ||
      !email ||
      !mobile ||
      !address ||
      !Array.isArray(cartItems) ||
      cartItems.length === 0 ||
      !totalAmount ||
      !orderDate ||
      !paymentDetails
    ) {
      return res.status(400).json({ message: "Incomplete order data" });
    }

    if (Number(totalAmount) < MINIMUM_ORDER_AMOUNT) {
      return res.status(400).json({ message: `Minimum order amount is ₹${MINIMUM_ORDER_AMOUNT}.` });
    }

    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(
        `${paymentDetails.razorpay_order_id}|${paymentDetails.razorpay_payment_id}`
      )
      .digest("hex");

    if (generatedSignature !== paymentDetails.razorpay_signature) {
      return res.status(400).json({ message: "Invalid payment signature" });
    }

    const enrichedCartItems = [];
    for (const item of cartItems) {
      if (!mongoose.Types.ObjectId.isValid(item.productId)) {
        return res.status(400).json({ message: `Invalid productId: ${item.productId}` });
      }

      const product = await Product.findById(item.productId);
      if (!product) {
        return res.status(400).json({ message: `Product not found: ${item.productId}` });
      }

      enrichedCartItems.push({
        productId: item.productId,
        name: item.name || product.name,
        actualPrice: product.actualPrice,
        ourPrice: item.ourPrice,
        per: item.per,
        qty: item.qty,
      });
    }

    let customer = await Customer.findOne({ email });
    if (!customer) {
      customer = new Customer({ name, email, phone: mobile, address });
      try {
        await customer.save();
        console.log("New customer created:", customer);
      } catch (err) {
        if (err.code === 11000) {
          return res.status(400).json({ message: "Email already exists" });
        }
        console.error("Customer creation error:", err);
        return res.status(400).json({ message: "Failed to create customer", error: err.message });
      }
    } else if (address && address.trim() !== "") {
      customer.address = address;
      await customer.save();
      console.log("Customer address updated:", { _id: customer._id, email, address });
    }

    const order = new Order({
      orderDate,
      totalAmount,
      cartItems: enrichedCartItems,
      customer: customer._id,
      trackingId: null,
      paymentDetails: {
        razorpay_payment_id: paymentDetails.razorpay_payment_id,
        razorpay_order_id: paymentDetails.razorpay_order_id,
      },
    });

    let savedOrder = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        order.trackingId = generateTrackingId();
        savedOrder = await order.save();
        break;
      } catch (err) {
        if (err.code === 11000 && attempt < 3) {
          console.log(`Retrying trackingId generation, attempt ${attempt + 1}`);
          continue;
        }
        throw err;
      }
    }

    if (!savedOrder) {
      throw new Error("Failed to generate unique trackingId after retries");
    }

    const totalItems = enrichedCartItems.reduce((sum, item) => sum + Number(item.qty), 0);

    // Generate table rows with enhanced CSS
    const itemList = enrichedCartItems
      .map(
        (item, index) => `
          <tr>
            <td style="border: 1px solid #ddd; padding: 10px; text-align: center; font-size: 14px;">${index + 1}</td>
            <td style="border: 1px solid #ddd; padding: 10px; text-align: left; font-size: 14px; word-wrap: break-word; max-width: 200px;">${item.name}</td>
            <td style="border: 1px solid #ddd; padding: 10px; text-align: center; font-size: 14px;">${item.per}</td>
            <td style="border: 1px solid #ddd; padding: 10px; text-align: right; font-size: 14px;">₹${Number(item.ourPrice).toFixed(2)}</td>
            <td style="border: 1px solid #ddd; padding: 10px; text-align: center; font-size: 14px;">${item.qty}</td>
            <td style="border: 1px solid #ddd; padding: 10px; text-align: right; font-size: 14px;">₹${(Number(item.ourPrice) * Number(item.qty)).toFixed(2)}</td>
          </tr>
        `
      )
      .join("");

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: Arial, sans-serif;
            background-color: #f9f9f9;
            margin: 0;
            padding: 20px;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #fff;
            border: 1px solid #e0e0e0;
            padding: 20px;
          }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 20px;
            border-bottom: 1px solid #e0e0e0;
          }
          .header-left {
            display: flex;
            align-items: center;
          }
          .header-left h1 {
            font-size: 24px;
            color: #000;
            margin: 0;
            font-weight: bold;
          }
          .header-right {
            text-align: right;
            font-size: 14px;
            color: #fff;
            background-color: #4CAF50;
            padding: 5px 10px;
          }
          .header-right p {
            margin: 0;
            font-weight: bold;
          }
          .address-section {
            display: flex;
            justify-content: space-between;
            margin-top: 20px;
            font-size: 14px;
            color: #333;
          }
          .address-section div {
            width: 48%;
          }
          .address-section p {
            margin: 5px 0;
          }
          .table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
          }
          .table th, .table td {
            padding: 10px;
            border: 1px solid #e0e0e0;
          }
          .table th {
            background-color: #4CAF50;
            color: #fff;
            text-align: center;
            font-weight: bold;
          }
          .table td {
            text-align: center;
          }
          .total-section {
            margin-top: 20px;
            font-size: 14px;
            text-align: right;
          }
          .total-section p {
            margin: 5px 0;
          }
          .total-section .grand-total {
            background-color: #4CAF50;
            color: #fff;
            padding: 5px 10px;
            display: inline-block;
            font-weight: bold;
          }
          .footer {
            margin-top: 30px;
            text-align: center;
            font-size: 12px;
            color: #666;
            border-top: 1px solid #e0e0e0;
            padding-top: 15px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="header-left">
              <h1>BABA CRACKERS</h1>
            </div>
            <div class="header-right">
              <p>ORDER CONFIRMATION</p>
              <p>No: ${savedOrder.trackingId} | Date: ${orderDate}</p>
            </div>
          </div>

          <div class="address-section">
            <div>
              <p><strong>Order From:</strong></p>
              <p>Baba Crackers</p>
              <p>C/O Sri Mahalakshmi Pyro</p>
              <p>2/258-4 Alngulam to</p>
              <p>Sivakasi Main Road</p>
              <p>9445280054</p>
            </div>
            <div>
              <p><strong>Order To:</strong></p>
              <p>${name}</p>
              <p>${address}</p>
              <p>${email}</p>
              <p>${mobile}</p>
            </div>
          </div>

          <table class="table">
            <thead>
              <tr>
                <th>S.No</th>
                <th>Item</th>
                <th>Content</th>
                <th>Price</th>
                <th>Qty</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              ${itemList}
            </tbody>
          </table>

          <div class="total-section">
            <p><strong>Total Items: ${totalItems}</strong></p>
            <p>Subtotal: ₹${Number(totalAmount).toFixed(2)}</p>
            <p class="grand-total">Grand Total: ₹${Number(totalAmount).toFixed(2)}</p>
          </div>

          <div class="footer">
            <p>Thank you for Choosing Us</p>
            <p>Baba Crackers Wishing you a bright and auspicious Diwali</p>
          </div>
        </div>
      </body>
      </html>
    `;



    let imagePath;
    try {
      imagePath = await generateImageFromHtml(htmlContent);
      console.log("Image generated at:", imagePath);
    } catch (err) {
      console.error("Failed to generate image:", err);
      return res.status(500).json({
        message: "Order placed successfully, but failed to generate email image.",
        orderId: savedOrder._id.toString(),
        trackingId: savedOrder.trackingId,
        name,
        totalAmount,
      });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER || "ttsapplications2025@gmail.com",
        pass: process.env.EMAIL_PASS || "djor ksrg pkzt zznd",
      },
    });

    const mailOptions = {
      from: `BabaCrackers <${process.env.EMAIL_USER}>`,
      to: [email, "manojpolevault1202@gmail.com"],
      subject: `Order Confirmation - ${savedOrder.trackingId} | BabaCrackers`,
      html: `
        <div style="font-family: Arial, Helvetica, sans-serif; padding: 20px; color: #333;">
          <h2 style="font-size: 20px; color: #333;">Order Confirmation</h2>
          <p style="font-size: 14px;">Thank you for your order! Please find the order details attached below.</p>
          <p style="font-size: 14px;">For any queries, contact us at:</p>
          <p style="font-size: 14px;">Email: jais1829@gmail.com | Phone: +91 9445280054</p>
        </div>
      `,
      attachments: [
        {
          filename: `order-confirmation-${savedOrder.trackingId}.png`,
          path: imagePath,
          cid: "order-image",
        },
      ],
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log("Emails sent successfully to:", mailOptions.to);
    } catch (emailErr) {
      console.error("Email sending failed:", emailErr);
      return res.status(500).json({
        message: "Order placed successfully, but failed to send confirmation email.",
        orderId: savedOrder._id.toString(),
        trackingId: savedOrder.trackingId,
        name,
        totalAmount,
      });
    } finally {
      if (imagePath && fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
        console.log("Cleaned up image file:", imagePath);
      }
    }

    res.json({
      message: "Order placed successfully!",
      orderId: savedOrder._id.toString(),
      trackingId: savedOrder.trackingId,
      name,
      totalAmount,
    });
  } catch (err) {
    console.error("Error placing order:", err);
    res.status(500).json({
      message: "Failed to place order. Please try again later.",
      error: err.message,
    });
  }
});

// Admin Routes (Require Authentication)
adminRouter.get("/", async (req, res) => {
  try {
    const orders = await Order.find().populate("customer").lean();
    console.log("Orders fetched:", {
      count: orders.length,
      orders: orders.map((o) => ({
        _id: o._id,
        customer: o.customer?.email,
        trackingId: o.trackingId,
      })),
    });
    res.json(orders);
  } catch (err) {
    console.error("Error fetching orders:", err);
    res.status(500).json({
      message: "Failed to fetch orders",
      error: err.message,
    });
  }
});

module.exports = { publicRouter, adminRouter };