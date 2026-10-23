const mongoose = require('mongoose');

const checkRunSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },
    endpoint: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Endpoint',
      required: [true, 'Endpoint reference is required']
    },
    contract: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contract',
      required: [true, 'Contract reference is required']
    },
    status: {
      type: String,
      enum: ['healthy', 'failed'],
      required: [true, 'Check status is required']
    },
    failureType: {
      type: String,
      enum: [null, 'SCHEMA_VIOLATION', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'INVALID_JSON'],
      default: null
    },
    httpStatus: {
      type: Number,
      default: null
    },
    responseTimeMs: {
      type: Number,
      min: 0,
      default: 0
    },
    schemaValid: {
      type: Boolean,
      default: null
    },
    errors: {
      type: [String],
      default: []
    },
    checkedAt: {
      type: Date,
      default: Date.now,
      required: true
    }
  },
  {
    timestamps: true,
    suppressReservedKeysWarning: true
  }
);

// Indexes for high-performance history querying (sorted newest first)
checkRunSchema.index({ checkedAt: -1 });
checkRunSchema.index({ endpoint: 1, checkedAt: -1 });
checkRunSchema.index({ userId: 1, checkedAt: -1 });
checkRunSchema.index({ userId: 1, endpoint: 1, checkedAt: -1 });

const CheckRun = mongoose.model('CheckRun', checkRunSchema);

module.exports = CheckRun;
