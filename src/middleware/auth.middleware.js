const User = require('../models/User');
const { verifyToken } = require('../services/auth.service');

/**
 * Express middleware to authenticate requests via JWT Bearer token.
 * Validates token presence, signature, expiration, and user account status.
 * Attaches authenticated user document to req.user.
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required. No token provided.'
      });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1].trim()) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid authorization header format. Expected Bearer <token>'
      });
    }

    const token = parts[1].trim();
    let decoded;

    try {
      decoded = verifyToken(token);
    } catch (tokenErr) {
      if (tokenErr.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication token has expired'
        });
      }
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or malformed authentication token'
      });
    }

    // Verify database connectivity
    if (require('mongoose').connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable'
      });
    }

    // Verify user exists and is active in database
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'User account not found'
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'User account has been deactivated'
      });
    }

    // Attach authenticated user and convenience identifier
    req.user = user;
    req.userId = user._id;

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Authorization middleware to restrict route access to platform administrators.
 * Must be placed after requireAuth middleware.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Administrator privileges are required'
    });
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin
};
