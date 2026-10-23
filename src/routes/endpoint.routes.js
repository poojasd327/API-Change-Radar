const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Endpoint = require('../models/Endpoint');
const Contract = require('../models/Contract');
const CheckRun = require('../models/CheckRun');
const { validateEndpointUrl } = require('../services/ssrfProtection.service');
const { requireAuth } = require('../middleware/auth.middleware');

// Protect all endpoint management routes with authentication
router.use(requireAuth);

const SUPPORTED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ALLOWED_CREATE_FIELDS = ['name', 'url', 'method', 'isActive'];
const ALLOWED_PATCH_FIELDS = ['name', 'isActive'];

/**
 * GET /api/endpoints
 * Returns a paginated list of persisted endpoints sorted newest first,
 * enriched with a safe summary of the latest check run and contract readiness.
 *
 * Query parameters:
 * - page: positive integer (default 1)
 * - limit: integer between 1 and 100 (default 20)
 * - isActive: 'true' | 'false' (optional filter)
 */
router.get('/', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable'
      });
    }

    const filter = { userId: req.userId };

    // 1. Validate optional isActive filter
    if (req.query.isActive !== undefined) {
      const val = req.query.isActive.trim().toLowerCase();
      if (val === 'true') {
        filter.isActive = true;
      } else if (val === 'false') {
        filter.isActive = false;
      } else {
        return res.status(400).json({
          error: 'BadRequest',
          message: "Query parameter 'isActive' must be 'true' or 'false'"
        });
      }
    }

    // 2. Validate page query param
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

    // 3. Validate limit query param
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

    // 4. Query endpoints and total count in parallel
    const [total, endpoints] = await Promise.all([
      Endpoint.countDocuments(filter),
      Endpoint.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-__v')
        .lean()
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    // If no endpoints on this page, return early
    if (endpoints.length === 0) {
      return res.status(200).json({
        data: [],
        pagination: {
          total,
          page,
          limit,
          totalPages,
          hasNextPage: false,
          hasPrevPage: page > 1
        }
      });
    }

    const endpointIds = endpoints.map(e => e._id);

    // 5. Safely summarize the latest check run for each endpoint
    const latestChecks = await CheckRun.aggregate([
      { $match: { endpoint: { $in: endpointIds } } },
      { $sort: { checkedAt: -1 } },
      {
        $group: {
          _id: '$endpoint',
          status: { $first: '$status' },
          failureType: { $first: '$failureType' },
          httpStatus: { $first: '$httpStatus' },
          responseTimeMs: { $first: '$responseTimeMs' },
          checkedAt: { $first: '$checkedAt' }
        }
      }
    ]);

    const checkMap = new Map();
    for (const check of latestChecks) {
      checkMap.set(check._id.toString(), {
        status: check.status,
        failureType: check.failureType,
        httpStatus: check.httpStatus,
        responseTimeMs: check.responseTimeMs,
        checkedAt: check.checkedAt
      });
    }

    // 6. Identify which endpoints have an approved active contract
    const activeContracts = await Contract.find({
      endpoint: { $in: endpointIds },
      isActive: true
    }).select('endpoint').lean();

    const activeContractSet = new Set(activeContracts.map(c => c.endpoint.toString()));

    // 7. Assemble enriched endpoint records
    const enrichedData = endpoints.map(ep => {
      const epIdStr = ep._id.toString();
      return {
        ...ep,
        hasActiveContract: activeContractSet.has(epIdStr),
        latestCheck: checkMap.get(epIdStr) || null
      };
    });

    return res.status(200).json({
      data: enrichedData,
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

/**
 * GET /api/endpoints/:id
 * Retrieve a single endpoint by its MongoDB ObjectId.
 */
router.get('/:id', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable'
      });
    }

    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: `Invalid endpoint ID format: '${id}'`
      });
    }

    const endpoint = await Endpoint.findOne({ _id: id, userId: req.userId }).select('-__v').lean();
    if (!endpoint) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Endpoint with ID '${id}' was not found`
      });
    }

    // Fetch latest check run and active contract in parallel (scoped to user)
    const [latestCheck, activeContract] = await Promise.all([
      CheckRun.findOne({ endpoint: endpoint._id, userId: req.userId })
        .sort({ checkedAt: -1 })
        .select('status failureType httpStatus responseTimeMs checkedAt')
        .lean(),
      Contract.findOne({ endpoint: endpoint._id, userId: req.userId, isActive: true })
        .select('_id name version isActive')
        .lean()
    ]);

    return res.status(200).json({
      ...endpoint,
      hasActiveContract: Boolean(activeContract),
      activeContract: activeContract || null,
      latestCheck: latestCheck ? {
        status: latestCheck.status,
        failureType: latestCheck.failureType,
        httpStatus: latestCheck.httpStatus,
        responseTimeMs: latestCheck.responseTimeMs,
        checkedAt: latestCheck.checkedAt
      } : null
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/endpoints
 * Register a new monitored endpoint with strict SSRF validation and duplicate checks.
 *
 * Expected body:
 * - name: string (required, 1-200 chars)
 * - url: string (required, valid public HTTP/HTTPS URL)
 * - method: string (optional, default 'GET', one of GET, POST, PUT, PATCH, DELETE)
 * - isActive: boolean (optional, default true)
 */
router.post('/', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable'
      });
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Request body must be a JSON object'
      });
    }

    // 1. Prohibit arbitrary, unapproved fields (e.g. headers, credentials, body, IDs)
    const extraFields = Object.keys(req.body).filter(k => !ALLOWED_CREATE_FIELDS.includes(k));
    if (extraFields.length > 0) {
      return res.status(400).json({
        error: 'BadRequest',
        message: `Unrecognized or prohibited field(s): ${extraFields.join(', ')}`
      });
    }

    // 2. Validate endpoint name
    if (req.body.name === undefined || req.body.name === null) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Endpoint name is required'
      });
    }
    if (typeof req.body.name !== 'string' || req.body.name.trim() === '') {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Endpoint name must be a non-empty string'
      });
    }
    const trimmedName = req.body.name.trim();
    if (trimmedName.length > 200) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Endpoint name must not exceed 200 characters'
      });
    }

    // 3. Validate endpoint URL
    if (req.body.url === undefined || req.body.url === null) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Endpoint URL is required'
      });
    }
    if (typeof req.body.url !== 'string' || req.body.url.trim() === '') {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Endpoint URL must be a non-empty string'
      });
    }
    const rawUrl = req.body.url.trim();

    // 4. Strict SSRF protection and URL validation
    const dnsResolver = req.app.get('dnsResolver');
    const ssrfResult = await validateEndpointUrl(rawUrl, { dnsResolver });
    if (!ssrfResult.isValid) {
      return res.status(400).json({
        error: 'BadRequest',
        message: `Invalid endpoint URL: ${ssrfResult.reason}`
      });
    }
    const normalizedUrl = ssrfResult.normalizedUrl;

    // 5. Validate HTTP method
    let method = 'GET';
    if (req.body.method !== undefined) {
      if (typeof req.body.method !== 'string') {
        return res.status(400).json({
          error: 'BadRequest',
          message: "Field 'method' must be a string"
        });
      }
      const upperMethod = req.body.method.trim().toUpperCase();
      if (!SUPPORTED_METHODS.includes(upperMethod)) {
        return res.status(400).json({
          error: 'BadRequest',
          message: `Unsupported HTTP method '${req.body.method}'. Supported methods: ${SUPPORTED_METHODS.join(', ')}`
        });
      }
      method = upperMethod;
    }

    // 6. Validate isActive
    let isActive = true;
    if (req.body.isActive !== undefined) {
      if (typeof req.body.isActive !== 'boolean') {
        return res.status(400).json({
          error: 'BadRequest',
          message: "Field 'isActive' must be a boolean"
        });
      }
      isActive = req.body.isActive;
    }

    // 7. Duplicate handling: check URL and Name conflicts scoped to this user
    const existingUrl = await Endpoint.findOne({ userId: req.userId, url: normalizedUrl });
    if (existingUrl) {
      return res.status(409).json({
        error: 'Conflict',
        message: `An endpoint with URL '${normalizedUrl}' already exists`
      });
    }

    const existingName = await Endpoint.findOne({ userId: req.userId, name: trimmedName });
    if (existingName) {
      return res.status(409).json({
        error: 'Conflict',
        message: `An endpoint with name '${trimmedName}' already exists`
      });
    }

    // 8. Persist new Endpoint with user ownership
    const endpoint = await Endpoint.create({
      userId: req.userId,
      name: trimmedName,
      url: normalizedUrl,
      method,
      isActive
    });

    return res.status(201).json({
      _id: endpoint._id,
      name: endpoint.name,
      url: endpoint.url,
      method: endpoint.method,
      isActive: endpoint.isActive,
      hasActiveContract: false,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
      message: 'Endpoint created successfully. Note: An approved contract must be registered before automated checks can run on this endpoint.'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/endpoints/:id
 * Update explicitly approved fields (name, isActive) on an existing endpoint.
 * Protected fields (_id, timestamps, url, method, headers, etc.) are strictly rejected.
 */
router.patch('/:id', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable'
      });
    }

    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: `Invalid endpoint ID format: '${id}'`
      });
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Request body must contain at least one field to update'
      });
    }

    // 1. Enforce strict allowlist: reject any field not in ALLOWED_PATCH_FIELDS
    const prohibitedFields = Object.keys(req.body).filter(k => !ALLOWED_PATCH_FIELDS.includes(k));
    if (prohibitedFields.length > 0) {
      return res.status(400).json({
        error: 'BadRequest',
        message: `Modification of field(s) '${prohibitedFields.join(', ')}' is not permitted. Only ['name', 'isActive'] may be updated.`
      });
    }

    const updates = {};

    // 2. Validate name if provided
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || req.body.name.trim() === '') {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'Endpoint name must be a non-empty string'
        });
      }
      const trimmedName = req.body.name.trim();
      if (trimmedName.length > 200) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'Endpoint name must not exceed 200 characters'
        });
      }

      // Check duplicate name against user's other endpoints
      const duplicateName = await Endpoint.findOne({ userId: req.userId, name: trimmedName, _id: { $ne: id } });
      if (duplicateName) {
        return res.status(409).json({
          error: 'Conflict',
          message: `An endpoint with name '${trimmedName}' already exists`
        });
      }

      updates.name = trimmedName;
    }

    // 3. Validate isActive if provided
    if (req.body.isActive !== undefined) {
      if (typeof req.body.isActive !== 'boolean') {
        return res.status(400).json({
          error: 'BadRequest',
          message: "Field 'isActive' must be a boolean"
        });
      }
      updates.isActive = req.body.isActive;
    }

    // 4. Perform atomic update scoped strictly to this user
    const updated = await Endpoint.findOneAndUpdate(
      { _id: id, userId: req.userId },
      { $set: updates },
      { returnDocument: 'after', runValidators: true }
    ).select('-__v').lean();

    if (!updated) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Endpoint with ID '${id}' was not found`
      });
    }

    const hasActiveContract = Boolean(await Contract.exists({ endpoint: updated._id, userId: req.userId, isActive: true }));

    return res.status(200).json({
      ...updated,
      hasActiveContract
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
