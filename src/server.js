import 'dotenv/config';
import app from './app.js';
import { connectDB, disconnectDB } from './config/db.js';
import { seedDemoData } from './scripts/seed.js';
import { startScheduler, stopScheduler } from './services/scheduler.service.js';

const PORT = process.env.PORT || 5001;

async function startServer() {
  // 1. Connect to MongoDB before accepting incoming traffic
  await connectDB();

  // 2. Initialize demo endpoint and approved contract idempotently
  await seedDemoData();

  // 3. Start HTTP server
  const server = app.listen(PORT, () => {
    console.log(`[APIChange Radar] Server running at http://localhost:${PORT}`);
    console.log(`[APIChange Radar] Health check: http://localhost:${PORT}/api/health`);
  });

  // 4. Start the automatic monitoring scheduler
  startScheduler();

  // Graceful shutdown helper
  const gracefulShutdown = (signal) => {
    console.log(`[APIChange Radar] ${signal} received. Closing HTTP server and stopping scheduler...`);
    stopScheduler();
    server.close(async () => {
      console.log('[APIChange Radar] HTTP server closed.');
      await disconnectDB();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

startServer().catch((err) => {
  console.error('[APIChange Radar] Fatal startup error:', err);
  process.exit(1);
});
