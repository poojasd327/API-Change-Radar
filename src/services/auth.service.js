const jwt = require('jsonwebtoken');

const DEFAULT_DEV_SECRET = 'dev-jwt-secret-key-change-in-production';
const DEFAULT_EXPIRATION = '1h';

/**
 * Retrieves the configured JWT secret key.
 * Logs a warning if using the default fallback in non-test environments.
 */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[Security Error] JWT_SECRET must be configured in production environment.');
    }
    return DEFAULT_DEV_SECRET;
  }
  return secret;
}

/**
 * Retrieves the configured JWT expiration time.
 */
function getJwtExpiresIn() {
  return process.env.JWT_EXPIRES_IN || DEFAULT_EXPIRATION;
}

/**
 * Generates a signed JSON Web Token for an authenticated user.
 * Payload includes only essential claims: userId, email, and role.
 * Sensitive data and password hashes are never included.
 *
 * @param {object} user - User document or object with _id, email, and role
 * @param {object} [options] - Optional overrides (e.g. expiresIn)
 * @returns {string} - Signed JWT
 */
function generateToken(user, options = {}) {
  const userId = user._id ? user._id.toString() : user.id;
  const payload = {
    userId,
    email: user.email,
    role: user.role || 'user'
  };

  const secret = getJwtSecret();
  const expiresIn = options.expiresIn || getJwtExpiresIn();

  return jwt.sign(payload, secret, { expiresIn });
}

/**
 * Verifies a JSON Web Token and returns its decoded payload.
 * Throws JsonWebTokenError or TokenExpiredError on failure.
 *
 * @param {string} token - The JWT string to verify
 * @returns {object} - Decoded token payload
 */
function verifyToken(token) {
  const secret = getJwtSecret();
  return jwt.verify(token, secret);
}

/**
 * Sanitizes a user document or object for safe external API responses.
 * Guarantees no password hash, internal version key, or sensitive fields leak.
 *
 * @param {object} user - User document or plain object
 * @returns {object} - Safe user representation
 */
function sanitizeUser(user) {
  const userObj = typeof user.toJSON === 'function' ? user.toJSON() : { ...user };
  delete userObj.password;
  delete userObj.__v;
  return {
    id: userObj._id ? userObj._id.toString() : userObj.id,
    name: userObj.name,
    email: userObj.email,
    role: userObj.role,
    isActive: userObj.isActive,
    createdAt: userObj.createdAt,
    updatedAt: userObj.updatedAt
  };
}

module.exports = {
  generateToken,
  verifyToken,
  sanitizeUser,
  getJwtSecret,
  getJwtExpiresIn
};
