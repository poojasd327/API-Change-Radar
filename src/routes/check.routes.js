const express = require('express');
const router = express.Router();
const { runProductCheck } = require('../services/detectionEngine.service');

const SUPPORTED_SCENARIOS = ['missing-price', 'wrong-price-type', 'server-error', 'slow'];

/**
 * POST /api/checks/mock-product
 * Triggers a single contract detection check against the controlled mock product API.
 *
 * Optional JSON body:
 * {
 *   "scenario": "wrong-price-type", // 'missing-price' | 'wrong-price-type' | 'server-error' | 'slow'
 *   "delay": 500,                   // integer ms, applicable if scenario === 'slow'
 *   "timeoutMs": 3000               // integer ms request timeout limit
 * }
 */
router.post('/mock-product', async (req, res, next) => {
  try {
    const { scenario, delay, timeoutMs } = req.body || {};

    // 1. Validate scenario parameter
    if (scenario && !SUPPORTED_SCENARIOS.includes(scenario)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: `Unsupported scenario '${scenario}'. Supported scenarios: ${SUPPORTED_SCENARIOS.join(', ')}`
      });
    }

    // 2. Validate timeoutMs if supplied
    const resolvedTimeout = Number.isInteger(timeoutMs) && timeoutMs > 0
      ? Math.min(Math.max(timeoutMs, 50), 10000)
      : 3000;

    // 3. Resolve the mock API base URL (env var, app-level setting, or default localhost)
    const port = process.env.PORT || 5001;
    const baseUrl = req.app.get('mockApiBaseUrl') ||
      process.env.MOCK_API_BASE_URL ||
      `http://127.0.0.1:${port}/mock-api/products`;

    // 4. Construct target URL safely (restricted strictly to our controlled mock API)
    const url = new URL(`${baseUrl}/101`);
    if (scenario) {
      url.searchParams.set('scenario', scenario);
    }
    if (scenario === 'slow' && Number.isInteger(delay)) {
      url.searchParams.set('delay', String(delay));
    }

    // 5. Run the detection check
    const checkResult = await runProductCheck({
      url: url.toString(),
      timeoutMs: resolvedTimeout
    });

    // Return the structured check result
    return res.status(200).json(checkResult);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
