const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Generates an unpredictable, URL-safe 20-character hexadecimal slug.
 * Does not expose user emails, sequential IDs, or MongoDB ObjectIds.
 */
function generateSlug() {
  return crypto.randomBytes(10).toString('hex');
}

const statusPageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner userId is required'],
      unique: true,
      index: true
    },
    slug: {
      type: String,
      required: [true, 'Public slug is required'],
      unique: true,
      index: true,
      trim: true,
      default: generateSlug
    },
    title: {
      type: String,
      required: [true, 'Display title is required'],
      trim: true,
      maxlength: [100, 'Title cannot exceed 100 characters'],
      default: 'Service Status'
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Description cannot exceed 500 characters'],
      default: ''
    },
    isPublished: {
      type: Boolean,
      default: false,
      index: true
    },
    selectedEndpoints: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Endpoint'
      }
    ]
  },
  {
    timestamps: true
  }
);

// Compound index for querying published status pages by slug
statusPageSchema.index({ slug: 1, isPublished: 1 });

const StatusPage = mongoose.model('StatusPage', statusPageSchema);

module.exports = {
  StatusPage,
  generateSlug
};
