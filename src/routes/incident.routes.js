const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Incident = require('../models/Incident');
const { requireAuth } = require('../middleware/auth.middleware');

// Protect all incident routes with authentication
router.use(requireAuth);

const ALLOWED_STATUSES = ['open', 'resolved'];

/**
 * GET /api/incidents
 * List incidents owned by the authenticated user, sorted by newest activity (lastSeenAt: -1).
 *
 * Query Parameters:
 * - status: 'open' | 'resolved' (optional filter)
 * - page: positive integer (default 1)
 * - limit: integer between 1 and 100 (default 20)
 */
router.get('/', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable'
      });
    }

    // Strictly scope all queries to the authenticated user
    const filter = { userId: req.userId };

    // 1. Validate optional status query parameter
    if (req.query.status !== undefined) {
      const normalizedStatus = req.query.status.trim().toLowerCase();
      if (!ALLOWED_STATUSES.includes(normalizedStatus)) {
        return res.status(400).json({
          error: 'BadRequest',
          message: `Query parameter 'status' must be one of: ${ALLOWED_STATUSES.join(', ')}`
        });
      }
      filter.status = normalizedStatus;
    }

    // 2. Validate page query parameter
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

    // 3. Validate limit query parameter
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

    // 4. Query incidents and count in parallel, scoped strictly to req.userId
    const [total, records] = await Promise.all([
      Incident.countDocuments(filter),
      Incident.find(filter)
        .sort({ lastSeenAt: -1 })
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

/**
 * GET /api/incidents/:id
 * Retrieve a single incident by its MongoDB ObjectId, scoped strictly to the authenticated user.
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

    // Validate MongoDB ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: `Invalid incident ID format: '${id}'`
      });
    }

    // Enforce ownership: only return incident if it belongs to req.userId
    const incident = await Incident.findOne({ _id: id, userId: req.userId })
      .select('-__v')
      .populate('endpoint', 'name url method')
      .populate('contract', 'name version')
      .lean();

    if (!incident) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Incident with ID '${id}' was not found`
      });
    }

    return res.status(200).json(incident);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
