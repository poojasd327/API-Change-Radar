const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth.middleware');
const { StatusPage, generateSlug } = require('../models/StatusPage');
const Endpoint = require('../models/Endpoint');

// Require authentication for all status-page management operations
router.use(requireAuth);

// Ensure no caching for private management responses
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

/**
 * POST /api/status-page
 * Creates an unpublished status page configuration for the authenticated user.
 */
router.post('/', async (req, res, next) => {
  try {
    const existing = await StatusPage.findOne({ userId: req.userId });
    if (existing) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'A status page already exists for this account'
      });
    }

    const { title, description } = req.body || {};

    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'Title must be a non-empty string'
        });
      }
      if (title.trim().length > 100) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'Title cannot exceed 100 characters'
        });
      }
    }

    if (description !== undefined) {
      if (typeof description !== 'string') {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'Description must be a string'
        });
      }
      if (description.trim().length > 500) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'Description cannot exceed 500 characters'
        });
      }
    }

    const statusPage = await StatusPage.create({
      userId: req.userId,
      title: title ? title.trim() : 'Service Status',
      description: description ? description.trim() : '',
      isPublished: false,
      selectedEndpoints: []
    });

    return res.status(201).json(statusPage);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/status-page/me
 * Retrieves the current authenticated user's status page configuration.
 */
router.get('/me', async (req, res, next) => {
  try {
    const statusPage = await StatusPage.findOne({ userId: req.userId })
      .populate('selectedEndpoints', 'name isActive method');

    if (!statusPage) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Status page not found for this account'
      });
    }

    return res.status(200).json(statusPage);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/status-page/me
 * Updates approved fields (title, description, isPublished) on the authenticated user's status page.
 */
router.patch('/me', async (req, res, next) => {
  try {
    const statusPage = await StatusPage.findOne({ userId: req.userId });
    if (!statusPage) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Status page not found for this account'
      });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Request body must be a non-empty object with fields to update'
      });
    }

    const allowedKeys = ['title', 'description', 'isPublished'];
    const invalidKeys = Object.keys(body).filter(k => !allowedKeys.includes(k));
    if (invalidKeys.length > 0) {
      return res.status(400).json({
        error: 'BadRequest',
        message: `Modifying protected or unapproved field(s): ${invalidKeys.join(', ')}`
      });
    }

    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim()) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'Title must be a non-empty string'
        });
      }
      if (body.title.trim().length > 100) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'Title cannot exceed 100 characters'
        });
      }
      statusPage.title = body.title.trim();
    }

    if (body.description !== undefined) {
      if (typeof body.description !== 'string') {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'Description must be a string'
        });
      }
      if (body.description.trim().length > 500) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'Description cannot exceed 500 characters'
        });
      }
      statusPage.description = body.description.trim();
    }

    if (body.isPublished !== undefined) {
      if (typeof body.isPublished !== 'boolean') {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'isPublished must be a boolean'
        });
      }
      statusPage.isPublished = body.isPublished;
    }

    await statusPage.save();
    return res.status(200).json(statusPage);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/status-page/me/services
 * Sets the list of monitored endpoints to publish on the public status page.
 * Strictly verifies that all selected endpoints belong to req.userId and are active.
 */
router.put('/me/services', async (req, res, next) => {
  try {
    const statusPage = await StatusPage.findOne({ userId: req.userId });
    if (!statusPage) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Status page not found for this account'
      });
    }

    const endpointIds = req.body?.endpointIds ?? req.body?.endpoints ?? (Array.isArray(req.body) ? req.body : null);

    if (!Array.isArray(endpointIds)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Expected an array of endpoint IDs in endpointIds'
      });
    }

    // Validate MongoDB ObjectId formats
    for (const id of endpointIds) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          error: 'BadRequest',
          message: `Invalid endpoint ID format: '${id}'`
        });
      }
    }

    // Check for duplicate IDs
    const strIds = endpointIds.map(String);
    if (new Set(strIds).size !== strIds.length) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Duplicate endpoint IDs are not permitted'
      });
    }

    // If array is not empty, verify ownership and eligibility
    if (endpointIds.length > 0) {
      const endpoints = await Endpoint.find({
        _id: { $in: endpointIds },
        userId: req.userId
      });

      if (endpoints.length !== endpointIds.length) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'One or more selected endpoints are invalid or not owned by you'
        });
      }

      const hasInactive = endpoints.some(e => !e.isActive);
      if (hasInactive) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'Inactive endpoints cannot be selected for public status'
        });
      }
    }

    statusPage.selectedEndpoints = endpointIds;
    await statusPage.save();

    return res.status(200).json(statusPage);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/status-page/me/regenerate-slug
 * Regenerates the public status page slug for the authenticated user.
 */
router.post('/me/regenerate-slug', async (req, res, next) => {
  try {
    const statusPage = await StatusPage.findOne({ userId: req.userId });
    if (!statusPage) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Status page not found for this account'
      });
    }

    const newSlug = generateSlug();
    statusPage.slug = newSlug;
    await statusPage.save();

    return res.status(200).json({
      message: 'Public status page slug regenerated successfully. Previous public links will no longer work.',
      slug: newSlug,
      statusPage
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
