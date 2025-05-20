const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

dotenv.config();

const app = express();

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "image/jpeg" || file.mimetype === "image/jpg") {
      cb(null, true);
    } else {
      cb(new Error("Only JPG/JPEG images are allowed"), false);
    }
  },
});

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (
    email === process.env.ADMIN_EMAIL &&
    password === process.env.ADMIN_PASSWORD
  ) {
    const token = jwt.sign({ email }, process.env.JWT_SECRET, {
      expiresIn: "30d", // Extended token expiration to 30 days
    });
    res.json({ token });
  } else {
    res.status(401).json({ message: "Invalid credentials" });
  }
});

const customerRoutes = require("./routes/customers");
const productRoutes = require("./routes/products");
const { publicRouter: publicOrderRoutes, adminRouter: adminOrderRoutes } = require("./routes/orders");

// Public Routes (No Authentication)
app.use("/api/products", productRoutes);
app.use("/api/orders", publicOrderRoutes); // Handles /create-payment-order and /place-order

// Authenticated Routes
app.use("/api/customers", authMiddleware, customerRoutes);
app.use("/api/admin/orders", authMiddleware, adminOrderRoutes); // Admin-only order fetching

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
    const PORT = process.env.PORT || 5001;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => console.error("MongoDB connection error:", err));