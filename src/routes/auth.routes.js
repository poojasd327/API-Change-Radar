const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const { generateToken, sanitizeUser } = require('../services/auth.service');
const { requireAuth } = require('../middleware/auth.middleware');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/**
 * POST /api/auth/register
 * Registers a new individual user account.
 * Rejects duplicate emails and enforces input validation.
 */
router.post('/register', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable'
      });
    }

    const { name, email, password } = req.body || {};

    // 1. Validate name
    if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 50) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Name is required and must be between 2 and 50 characters'
      });
    }

    // 2. Validate email
    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'A valid email address is required'
      });
    }

    // 3. Validate password length
    if (!password || typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: 'BadRequest',
        message: `Password is required and must be at least ${MIN_PASSWORD_LENGTH} characters long`
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // 4. Check for duplicate email
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Email is already registered'
      });
    }

    // 5. Create user (role is strictly enforced as 'user' for public registration)
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password,
      role: 'user',
      isActive: true
    });

    // 6. Generate access token
    const token = generateToken(user);

    return res.status(201).json({
      message: 'User registered successfully',
      user: sanitizeUser(user),
      token
    });
  } catch (err) {
    // Handle Mongoose duplicate key error (code 11000) defensively
    if (err.code === 11000) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Email is already registered'
      });
    }
    next(err);
  }
});

/**
 * POST /api/auth/login
 * Authenticates user credentials and returns a JWT access token.
 * Uses generic error messages to prevent account enumeration.
 */
router.post('/login', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable'
      });
    }

    const { email, password } = req.body || {};

    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Email and password are required'
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Query user and explicitly select password field
    const user = await User.findOne({ email: normalizedEmail }).select('+password');

    // Uniform authentication failure response to prevent user enumeration
    if (!user || !user.isActive) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid email or password'
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid email or password'
      });
    }

    const token = generateToken(user);

    return res.status(200).json({
      message: 'Login successful',
      user: sanitizeUser(user),
      token
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 * Retrieves profile of the currently authenticated user.
 */
router.get('/me', requireAuth, async (req, res) => {
  return res.status(200).json({
    user: sanitizeUser(req.user)
  });
});

/**
 * POST /api/auth/logout
 * Confirms logout. As standard JWTs are stateless, the client should discard the token.
 */
router.post('/logout', (req, res) => {
  return res.status(200).json({
    message: 'Logged out successfully. Please discard the authorization token on the client.'
  });
});

module.exports = router;
