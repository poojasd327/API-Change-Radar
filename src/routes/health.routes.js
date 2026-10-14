const express = require('express');
const router = express.Router();

/**
 * GET /api/health
 * Returns the operational health status of the APIChange Radar backend.
 */
router.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'APIChange Radar service is running',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || 'development'
  });
});

module.exports = router;
