const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Product = require('../models/product');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg') {
      cb(null, true);
    } else {
      cb(new Error('Only JPG/JPEG images are allowed'), false);
    }
  },
});

router.get('/', async (req, res) => {
  try {
    const products = await Product.find();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', upload.single('image'), async (req, res) => {
  try {
    const { category, name, actualPrice, ourPrice, per } = req.body;
    if (!category || !name || actualPrice === undefined || ourPrice === undefined || !per) {
      return res.status(400).json({ error: 'All fields (category, name, actualPrice, ourPrice, per) are required' });
    }
    const parsedActualPrice = parseFloat(actualPrice);
    const parsedOurPrice = parseFloat(ourPrice);
    if (isNaN(parsedActualPrice) || isNaN(parsedOurPrice)) {
      return res.status(400).json({ error: 'Prices must be valid numbers' });
    }
    const newProduct = new Product({
      category,
      name,
      actualPrice: parsedActualPrice,
      ourPrice: parsedOurPrice,
      per,
      image: req.file ? `/uploads/${req.file.filename}` : undefined,
    });
    await newProduct.save();
    res.status(201).json(newProduct);
  } catch (err) {
    console.error("Error in POST /products:", err);
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', upload.single('image'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid product ID' });
    }
    const { category, name, actualPrice, ourPrice, per } = req.body;
    if (!category || !name || actualPrice === undefined || ourPrice === undefined || !per) {
      return res.status(400).json({ error: 'All fields (category, name, actualPrice, ourPrice, per) are required' });
    }
    const parsedActualPrice = parseFloat(actualPrice);
    const parsedOurPrice = parseFloat(ourPrice);
    if (isNaN(parsedActualPrice) || isNaN(parsedOurPrice)) {
      return res.status(400).json({ error: 'Prices must be valid numbers' });
    }
    const updateData = {
      category,
      name,
      actualPrice: parsedActualPrice,
      ourPrice: parsedOurPrice,
      per,
    };
    if (req.file) {
      updateData.image = `/uploads/${req.file.filename}`;
    }
    const updated = await Product.findByIdAndUpdate(req.params.id, updateData, { new: true });
    if (!updated) return res.status(404).json({ error: 'Product not found' });
    res.json(updated);
  } catch (err) {
    console.error("Error in PUT /products/:id:", err);
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid product ID' });
    }
    const deleted = await Product.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    console.error("Error in DELETE /products/:id:", err);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;