const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { runProductCheck } = require('../services/detectionEngine.service');
const Endpoint = require('../models/Endpoint');
const Contract = require('../models/Contract');
const CheckRun = require('../models/CheckRun');
const { seedDemoData } = require('../scripts/seed');

const SUPPORTED_SCENARIOS = ['missing-price', 'wrong-price-type', 'server-error', 'slow'];

/**
 * Helper to retrieve active demo Endpoint and Contract documents,
 * self-healing by seeding them if they do not exist yet.
 */
async function getDemoEndpointAndContract() {
  const endpointName = 'Mock Product API - Item 101';
  let endpoint = await Endpoint.findOne({ name: endpointName });
  let contract = endpoint ? await Contract.findOne({ endpoint: endpoint._id, isActive: true }) : null;

  if (!endpoint || !contract) {
    const seeded = await seedDemoData();
    endpoint = seeded.endpoint;
    contract = seeded.contract;
  }

  return { endpoint, contract };
}

/**
 * POST /api/checks/mock-product
 * Triggers a contract check and persists the CheckRun record in MongoDB.
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

    // 3. Resolve target URL strictly against our controlled mock API
    const port = process.env.PORT || 5001;
    const baseUrl = req.app.get('mockApiBaseUrl') ||
      process.env.MOCK_API_BASE_URL ||
      `http://127.0.0.1:${port}/mock-api/products`;

    const url = new URL(`${baseUrl}/101`);
    if (scenario) {
      url.searchParams.set('scenario', scenario);
    }
    if (scenario === 'slow' && Number.isInteger(delay)) {
      url.searchParams.set('delay', String(delay));
    }

    // 4. Run the detection engine check once
    const checkResult = await runProductCheck({
      url: url.toString(),
      timeoutMs: resolvedTimeout
    });

    // 5. Persist the check run if database is connected
    let checkRunId = null;
    if (mongoose.connection.readyState === 1) {
      const { endpoint, contract } = await getDemoEndpointAndContract();

      const checkRun = await CheckRun.create({
        endpoint: endpoint._id,
        contract: contract._id,
        status: checkResult.status,
        failureType: checkResult.failureType,
        httpStatus: checkResult.httpStatus,
        responseTimeMs: checkResult.responseTimeMs,
        schemaValid: checkResult.schemaValid,
        errors: checkResult.errors,
        checkedAt: new Date(checkResult.checkedAt)
      });

      checkRunId = checkRun._id;
    } else {
      console.warn('[CheckRoutes] MongoDB is not connected; check result was not persisted.');
    }

    // Return the result with the saved document's ID
    return res.status(200).json({
      ...checkResult,
      checkRunId
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/checks/history/latest
 * Returns the single most recent check run without requiring manual database inspection.
 */
router.get('/history/latest', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable'
      });
    }

    const latest = await CheckRun.findOne()
      .sort({ checkedAt: -1 })
      .select('-__v')
      .populate('endpoint', 'name url method')
      .populate('contract', 'name version')
      .lean();

    if (!latest) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'No check runs found in database'
      });
    }

    return res.status(200).json(latest);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/checks/history
 * Returns paginated check history sorted newest first.
 *
 * Query parameters:
 * - page: positive integer (default 1)
 * - limit: integer between 1 and 100 (default 20)
 */
router.get('/history', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable'
      });
    }

    // Validate page query param
    let page = 1;
    if (req.query.page !== undefined) {
      if (!/^\d+$/.test(req.query.page) || parseInt(req.query.page, 10) < 1) {
        return res.status(400).json({
          error: 'BadRequest',
          message: "Query parameter 'page' must be a positive integer greater than or equal to 1"
        });
      }
      page = parseInt(req.query.page, 10);
    }

    // Validate limit query param
    let limit = 20;
    if (req.query.limit !== undefined) {
      if (!/^\d+$/.test(req.query.limit) || parseInt(req.query.limit, 10) < 1 || parseInt(req.query.limit, 10) > 100) {
        return res.status(400).json({
          error: 'BadRequest',
          message: "Query parameter 'limit' must be an integer between 1 and 100"
        });
      }
      limit = parseInt(req.query.limit, 10);
    }

    const skip = (page - 1) * limit;

    const [total, records] = await Promise.all([
      CheckRun.countDocuments(),
      CheckRun.find()
        .sort({ checkedAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-__v')
        .populate('endpoint', 'name url method')
        .populate('contract', 'name version')
        .lean()
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    return res.status(200).json({
      data: records,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
