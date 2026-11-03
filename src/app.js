import express from 'express';
import cors from 'cors';
import healthRoutes from './routes/health.routes.js';
import mockProductRoutes from './routes/mockProduct.routes.js';
import checkRoutes from './routes/check.routes.js';
import incidentRoutes from './routes/incident.routes.js';
import endpointRoutes from './routes/endpoint.routes.js';
import contractRoutes from './routes/contract.routes.js';
import authRoutes from './routes/auth.routes.js';
import statusPageRoutes from './routes/statusPage.routes.js';
import publicStatusRoutes from './routes/publicStatus.routes.js';

const app = express();

// Standard middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/endpoints', endpointRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/checks', checkRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/api/status-page', statusPageRoutes);
app.use('/api/public/status', publicStatusRoutes);
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

export { app };
export default app;
