const mongoose = require('mongoose');

const endpointSchema = new mongoose.Schema(
  {
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

// Helpful index on isActive and name
endpointSchema.index({ isActive: 1 });

const Endpoint = mongoose.model('Endpoint', endpointSchema);

module.exports = Endpoint;
