const express = require('express');
const cors = require('cors');
const healthRoutes = require('./routes/health.routes');
const mockProductRoutes = require('./routes/mockProduct.routes');
const checkRoutes = require('./routes/check.routes');
const incidentRoutes = require('./routes/incident.routes');

const app = express();

// Standard middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/checks', checkRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/mock-api/products', mockProductRoutes);

// Fallback 404 handler for unknown routes
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred'
  });
});

module.exports = app;
