const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Contract = require('../models/Contract');
const Endpoint = require('../models/Endpoint');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  validateSchemaStructure,
  validateSampleAgainstSchema,
  inferSchemaFromSample,
} = require('../services/contractValidator.service');

// Protect all contract routes with authentication
router.use(requireAuth);

/**
 * POST /api/contracts/validate
 * Validates a JSON Schema and optional sample response data without saving.
 */
router.post('/validate', async (req, res, next) => {
  try {
    const { schema, sampleData } = req.body || {};

    if (!schema) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'A schema object is required for validation',
      });
    }

    const structureResult = validateSchemaStructure(schema);
    if (!structureResult.valid) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Invalid JSON Schema structure',
        errors: structureResult.errors,
      });
    }

    let sampleResult = { valid: true, errors: [] };
    if (sampleData !== undefined) {
      sampleResult = validateSampleAgainstSchema(schema, sampleData);
    }

    return res.status(200).json({
      valid: structureResult.valid && sampleResult.valid,
      schemaValid: structureResult.valid,
      schemaErrors: structureResult.errors,
      sampleValid: sampleResult.valid,
      sampleErrors: sampleResult.errors,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/contracts/infer
 * Infers a draft JSON Schema from a sample JSON response payload.
 */
router.post('/infer', async (req, res, next) => {
  try {
    const { sampleData, title } = req.body || {};
    if (sampleData === undefined) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'sampleData payload is required to infer a JSON Schema',
      });
    }

    const inferredSchema = inferSchemaFromSample(
      sampleData,
      title || 'Inferred Schema'
    );
    return res.status(200).json({
      schema: inferredSchema,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/contracts
 * Register a new contract for an endpoint owned by the authenticated user.
 * Created in draft / pending approval status (isApproved: false, isActive: false).
 */
router.post('/', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable',
      });
    }

    const { endpointId, name, schema } = req.body || {};

    // 1. Validate endpointId
    if (!endpointId || !mongoose.Types.ObjectId.isValid(endpointId)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Valid endpointId is required',
      });
    }

    // Verify ownership of the endpoint
    const endpoint = await Endpoint.findOne({
      _id: endpointId,
      userId: req.userId,
    });
    if (!endpoint) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Endpoint with ID '${endpointId}' was not found for this account`,
      });
    }

    // 2. Validate contract name
    if (
      !name ||
      typeof name !== 'string' ||
      name.trim().length === 0 ||
      name.trim().length > 200
    ) {
      return res.status(400).json({
        error: 'BadRequest',
        message:
          'Contract name is required and must be between 1 and 200 characters',
      });
    }

    // 3. Validate JSON Schema structure
    const schemaValidation = validateSchemaStructure(schema);
    if (!schemaValidation.valid) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Invalid JSON Schema structure',
        errors: schemaValidation.errors,
      });
    }

    // 4. Calculate next contract version for this endpoint
    const highestVersionContract = await Contract.findOne({
      endpoint: endpointId,
      userId: req.userId,
    }).sort({ version: -1 });

    const nextVersion = highestVersionContract
      ? (highestVersionContract.version || 1) + 1
      : 1;

    // 5. Create the contract in draft/pending state
    const contract = await Contract.create({
      userId: req.userId,
      endpoint: endpoint._id,
      name: name.trim(),
      schema,
      version: nextVersion,
      isApproved: false,
      isActive: false,
    });

    return res.status(201).json({
      message:
        'Contract created successfully in pending approval status. You must explicitly approve this contract before automated monitoring begins.',
      contract,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/contracts
 * List contracts for the authenticated user, optionally filtered by endpointId.
 */
router.get('/', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable',
      });
    }

    const filter = { userId: req.userId };

    if (req.query.endpointId) {
      if (!mongoose.Types.ObjectId.isValid(req.query.endpointId)) {
        return res.status(400).json({
          error: 'BadRequest',
          message: `Invalid endpointId format: '${req.query.endpointId}'`,
        });
      }
      filter.endpoint = req.query.endpointId;
    }

    if (req.query.isApproved !== undefined) {
      filter.isApproved = req.query.isApproved === 'true';
    }

    let page = 1;
    if (req.query.page !== undefined) {
      if (!/^\d+$/.test(req.query.page) || parseInt(req.query.page, 10) < 1) {
        return res.status(400).json({
          error: 'BadRequest',
          message: "Query parameter 'page' must be a positive integer",
        });
      }
      page = parseInt(req.query.page, 10);
    }

    let limit = 20;
    if (req.query.limit !== undefined) {
      if (
        !/^\d+$/.test(req.query.limit) ||
        parseInt(req.query.limit, 10) < 1 ||
        parseInt(req.query.limit, 10) > 100
      ) {
        return res.status(400).json({
          error: 'BadRequest',
          message: "Query parameter 'limit' must be between 1 and 100",
        });
      }
      limit = parseInt(req.query.limit, 10);
    }

    const skip = (page - 1) * limit;

    const [total, records] = await Promise.all([
      Contract.countDocuments(filter),
      Contract.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-__v')
        .populate('endpoint', 'name url method isActive')
        .lean(),
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
        hasPrevPage: page > 1,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/contracts/:id
 * Retrieve a specific contract by ID, scoped to authenticated user.
 */
router.get('/:id', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable',
      });
    }

    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: `Invalid contract ID format: '${id}'`,
      });
    }

    const contract = await Contract.findOne({ _id: id, userId: req.userId })
      .select('-__v')
      .populate('endpoint', 'name url method isActive')
      .lean();

    if (!contract) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Contract with ID '${id}' was not found`,
      });
    }

    return res.status(200).json(contract);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/contracts/:id/approve
 * Explicitly approve and activate a contract.
 * Deactivates any previous active contract for this endpoint.
 */
router.post('/:id/approve', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable',
      });
    }

    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: `Invalid contract ID format: '${id}'`,
      });
    }

    const contract = await Contract.findOne({ _id: id, userId: req.userId });
    if (!contract) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Contract with ID '${id}' was not found`,
      });
    }

    // Verify endpoint still exists and belongs to user
    const endpoint = await Endpoint.findOne({
      _id: contract.endpoint,
      userId: req.userId,
    });
    if (!endpoint) {
      return res.status(404).json({
        error: 'NotFound',
        message:
          'Associated endpoint no longer exists or belongs to another user',
      });
    }

    // 1. Deactivate any existing active contract for this endpoint
    await Contract.updateMany(
      {
        endpoint: contract.endpoint,
        userId: req.userId,
        _id: { $ne: contract._id },
      },
      {
        $set: { isActive: false },
      }
    );

    // 2. Activate and approve this contract
    contract.isApproved = true;
    contract.isActive = true;
    await contract.save();

    console.log(
      `[ContractRoutes] Approved contract "${contract.name}" (v${contract.version}) for endpoint "${endpoint.name}"`
    );

    return res.status(200).json({
      message: `Contract "${contract.name}" (v${contract.version}) is now approved and active. Automated monitoring will validate responses against this schema.`,
      contract,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/contracts/:id/deactivate
 * Deactivates an active contract.
 */
router.post('/:id/deactivate', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Database connection is unavailable',
      });
    }

    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: `Invalid contract ID format: '${id}'`,
      });
    }

    const contract = await Contract.findOne({ _id: id, userId: req.userId });
    if (!contract) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Contract with ID '${id}' was not found`,
      });
    }

    contract.isActive = false;
    await contract.save();

    return res.status(200).json({
      message: `Contract "${contract.name}" has been deactivated.`,
      contract,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
