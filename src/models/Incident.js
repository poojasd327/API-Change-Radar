const mongoose = require('mongoose');

const incidentSchema = new mongoose.Schema(
  {
    endpoint: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Endpoint',
      required: [true, 'Associated endpoint reference is required']
    },
    contract: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contract',
      default: null
    },
    status: {
      type: String,
      enum: {
        values: ['open', 'resolved'],
        message: '{VALUE} is not a valid incident status'
      },
      default: 'open',
      required: [true, 'Incident status is required']
    },
    failureType: {
      type: String,
      required: [true, 'Failure type is required'],
      trim: true
    },
    title: {
      type: String,
      required: [true, 'Incident title is required'],
      trim: true
    },
    description: {
      type: String,
      default: null,
      trim: true
    },
    firstSeenAt: {
      type: Date,
      default: Date.now,
      required: true
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
      required: true
    },
    occurrenceCount: {
      type: Number,
      default: 1,
      min: [1, 'Occurrence count must be at least 1']
    },
    resolvedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Compound index for finding existing open incidents for an endpoint by failure type
incidentSchema.index({ endpoint: 1, status: 1, failureType: 1 });

// Compound index for dashboard queries filtering by status and ordering by most recent activity
incidentSchema.index({ status: 1, lastSeenAt: -1 });

// Single index for global recent activity queries
incidentSchema.index({ lastSeenAt: -1 });

const Incident = mongoose.model('Incident', incidentSchema);

module.exports = Incident;
