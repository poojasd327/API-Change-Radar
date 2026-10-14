require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 5001;

const server = app.listen(PORT, () => {
  console.log(`[APIChange Radar] Server running at http://localhost:${PORT}`);
  console.log(`[APIChange Radar] Health check: http://localhost:${PORT}/api/health`);
});

// Graceful shutdown listeners
process.on('SIGTERM', () => {
  console.log('[APIChange Radar] SIGTERM received. Closing HTTP server...');
  server.close(() => {
    console.log('[APIChange Radar] HTTP server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[APIChange Radar] SIGINT received. Closing HTTP server...');
  server.close(() => {
    console.log('[APIChange Radar] HTTP server closed.');
    process.exit(0);
  });
});
