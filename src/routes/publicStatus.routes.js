const express = require('express');
const router = express.Router();
const { getPublicStatusData } = require('../services/publicStatus.service');
const { createRateLimiter } = require('../middleware/rateLimiter.middleware');

// Public status rate limiter: 60 requests per minute per IP
const publicStatusRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many requests to public status. Please try again later.'
});

// Apply rate limiting across public status routes
router.use(publicStatusRateLimiter);

/**
 * GET /api/public/status/:slug
 * Public read-only endpoint returning sanitized status information for an explicitly published status page.
 * Unauthenticated and safe for consumption by external status frontends.
 */
router.get('/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;

    if (!slug || typeof slug !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Status page not found or is currently private'
      });
    }

    const publicData = await getPublicStatusData(slug);

    if (!publicData) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Status page not found or is currently private'
      });
    }

    // Set short-lived public caching header (30 seconds)
    res.set('Cache-Control', 'public, max-age=30, must-revalidate');

    return res.status(200).json(publicData);
  } catch (err) {
    next(err);
  }
});

router.rateLimiter = publicStatusRateLimiter;

module.exports = router;

