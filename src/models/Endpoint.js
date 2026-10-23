const mongoose = require('mongoose');

const endpointSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },
    name: {
      type: String,
      required: [true, 'Endpoint name is required'],
      trim: true
    },
    url: {
      type: String,
      required: [true, 'Endpoint URL is required'],
      trim: true
    },
    method: {
      type: String,
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      default: 'GET'
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

// Helpful indexes for scoped queries
endpointSchema.index({ isActive: 1 });
endpointSchema.index({ userId: 1, isActive: 1 });
endpointSchema.index({ userId: 1, name: 1 });
endpointSchema.index({ userId: 1, url: 1 });

const Endpoint = mongoose.model('Endpoint', endpointSchema);

module.exports = Endpoint;
