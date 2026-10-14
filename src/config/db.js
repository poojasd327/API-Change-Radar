const mongoose = require('mongoose');

/**
 * Connect to MongoDB with sanitized error handling.
 */
async function connectDB() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error('[Database] ERROR: MONGODB_URI environment variable is not defined.');
    console.error('[Database] Please define MONGODB_URI in your .env file.');
    process.exit(1);
  }

  // If already connected, return existing connection
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000
    });

    console.log(`[Database] Connected to MongoDB host: ${conn.connection.host}`);
    return conn;
  } catch (err) {
    // Sanitize any potential credentials from error message before logging
    const sanitizedMsg = (err.message || '').replace(/:([^:@]+)@/, ':****@');
    console.error(`[Database] Initial MongoDB connection failed: ${err.name} - ${sanitizedMsg}`);
    process.exit(1);
  }
}

/**
 * Disconnect cleanly from MongoDB.
 */
async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    console.log('[Database] MongoDB connection closed cleanly.');
  }
}

// Connection lifecycle event listeners
mongoose.connection.on('error', (err) => {
  const sanitizedMsg = (err.message || '').replace(/:([^:@]+)@/, ':****@');
  console.error(`[Database] MongoDB runtime connection error: ${sanitizedMsg}`);
});

mongoose.connection.on('disconnected', () => {
  console.log('[Database] MongoDB disconnected.');
});

module.exports = {
  connectDB,
  disconnectDB
};
