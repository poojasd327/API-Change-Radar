const mongoose = require('mongoose');

const contractSchema = new mongoose.Schema(
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
      required: [true, 'Associated endpoint reference is required']
    },
    name: {
      type: String,
      required: [true, 'Contract name is required'],
      trim: true
    },
    schema: {
      type: mongoose.Schema.Types.Mixed,
      required: [true, 'JSON Schema object is required']
    },
    version: {
      type: Number,
      default: 1,
      min: [1, 'Contract version must be at least 1']
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

// Indexes to quickly look up active contracts for endpoints and users
contractSchema.index({ endpoint: 1, isActive: 1 });
contractSchema.index({ userId: 1, endpoint: 1, isActive: 1 });

const Contract = mongoose.model('Contract', contractSchema);

module.exports = Contract;
