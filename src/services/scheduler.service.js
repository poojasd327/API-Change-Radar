const cron = require('node-cron');
const mongoose = require('mongoose');
const Endpoint = require('../models/Endpoint');
const Contract = require('../models/Contract');
const CheckRun = require('../models/CheckRun');
const { runProductCheck } = require('./detectionEngine.service');

// Default cron schedule: Every 5 minutes
const DEFAULT_CRON_SCHEDULE = '*/5 * * * *';

let scheduledTask = null;
let isRunInProgress = false;

/**
 * Execute a single monitoring pass over all active endpoints.
 * Protected against overlapping runs via an in-memory lock flag.
 *
 * @param {Object} [options]
 * @param {string} [options.overrideBaseUrl] - Optional base URL to override endpoint URLs (useful for ephemeral test ports)
 * @returns {Promise<Object>} Summary of check run
 */
async function runScheduledChecks(options = {}) {
  // 1. Overlap prevention
  if (isRunInProgress) {
    console.warn('[Scheduler] Previous scheduled check run is still in progress. Skipping this run.');
    return {
      status: 'skipped',
      reason: 'OVERLAPPING_RUN',
      timestamp: new Date().toISOString()
    };
  }

  isRunInProgress = true;
  const startTime = performance.now();
  const runTimestamp = new Date().toISOString();
  console.log(`[Scheduler] Scheduled check run started at ${runTimestamp}`);

  const summary = {
    totalEndpoints: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    results: []
  };

  try {
    // 2. Ensure database is connected
    if (mongoose.connection.readyState !== 1) {
      console.warn('[Scheduler] Database not connected. Skipping scheduled check run.');
      return {
        status: 'skipped',
        reason: 'DATABASE_DISCONNECTED',
        timestamp: runTimestamp
      };
    }

    // 3. Find all active endpoints
    const activeEndpoints = await Endpoint.find({ isActive: true });
    summary.totalEndpoints = activeEndpoints.length;

    if (activeEndpoints.length === 0) {
      console.log('[Scheduler] No active endpoints configured for monitoring.');
      return summary;
    }

    // 4. Iterate over each endpoint safely
    for (const endpoint of activeEndpoints) {
      try {
        // Find the active approved contract for this endpoint
        const contract = await Contract.findOne({ endpoint: endpoint._id, isActive: true });
        if (!contract) {
          console.warn(`[Scheduler] Skipping "${endpoint.name}": no active approved contract found.`);
          summary.skipped++;
          continue;
        }

        // Determine URL to check (support optional test base URL override)
        let targetUrl = endpoint.url;
        if (options.overrideBaseUrl) {
          try {
            const parsedTarget = new URL(targetUrl);
            const parsedOverride = new URL(options.overrideBaseUrl);
            parsedTarget.protocol = parsedOverride.protocol;
            parsedTarget.host = parsedOverride.host;
            targetUrl = parsedTarget.toString();
          } catch {
            targetUrl = endpoint.url;
          }
        }

        // Run detection engine with this contract's approved JSON schema
        const checkResult = await runProductCheck({
          url: targetUrl,
          schema: contract.schema,
          timeoutMs: 3000
        });

        // Persist the CheckRun document
        const checkRunDoc = await CheckRun.create({
          endpoint: endpoint._id,
          contract: contract._id,
          status: checkResult.status,
          failureType: checkResult.failureType,
          httpStatus: checkResult.httpStatus,
          responseTimeMs: checkResult.responseTimeMs,
          schemaValid: checkResult.schemaValid,
          errors: checkResult.errors,
          checkedAt: new Date(checkResult.checkedAt)
        });

        if (checkResult.status === 'healthy') {
          summary.passed++;
          console.log(`[Scheduler] PASSED: "${endpoint.name}" (${checkResult.responseTimeMs}ms) [Run ID: ${checkRunDoc._id}]`);
        } else {
          summary.failed++;
          console.error(`[Scheduler] FAILED: "${endpoint.name}" [${checkResult.failureType}] - ${checkResult.errors.join('; ')} [Run ID: ${checkRunDoc._id}]`);
        }

        summary.results.push({
          endpointId: endpoint._id,
          checkRunId: checkRunDoc._id,
          status: checkResult.status,
          failureType: checkResult.failureType
        });
      } catch (endpointErr) {
        // Catch isolated endpoint errors so other endpoints can continue running
        summary.failed++;
        console.error(`[Scheduler] Unexpected error checking endpoint "${endpoint.name}": ${endpointErr.message}`);
      }
    }
  } catch (err) {
    console.error(`[Scheduler] Fatal error during scheduled check run: ${err.message}`);
  } finally {
    isRunInProgress = false;
    const elapsedMs = Math.round(performance.now() - startTime);
    console.log(`[Scheduler] Scheduled check run completed in ${elapsedMs}ms (Passed: ${summary.passed}, Failed: ${summary.failed}, Skipped: ${summary.skipped})`);
  }

  return summary;
}

/**
 * Start the automatic monitoring scheduler.
 *
 * @param {string} [customSchedule] - Optional cron expression override
 * @returns {Object} { schedule: string, task: Object }
 */
function startScheduler(customSchedule = null) {
  if (scheduledTask) {
    console.warn('[Scheduler] Scheduler is already running. Call stopScheduler() first to restart.');
    return { schedule: getActiveSchedule(), task: scheduledTask };
  }

  const schedule = customSchedule || process.env.CHECK_CRON_SCHEDULE || DEFAULT_CRON_SCHEDULE;

  if (!cron.validate(schedule)) {
    console.error(`[Scheduler] Invalid cron expression: "${schedule}". Falling back to default "${DEFAULT_CRON_SCHEDULE}".`);
    return startScheduler(DEFAULT_CRON_SCHEDULE);
  }

  scheduledTask = cron.schedule(schedule, async () => {
    await runScheduledChecks();
  });

  console.log(`[Scheduler] Started successfully with schedule: "${schedule}"`);
  return { schedule, task: scheduledTask };
}

/**
 * Stop the scheduler cleanly during graceful shutdown.
 */
function stopScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log('[Scheduler] Stopped.');
  }
}

/**
 * Check whether the scheduler is currently active.
 */
function isSchedulerRunning() {
  return scheduledTask !== null;
}

/**
 * Get the active cron schedule expression or default.
 */
function getActiveSchedule() {
  return process.env.CHECK_CRON_SCHEDULE || DEFAULT_CRON_SCHEDULE;
}

/**
 * For testing purposes: check if a run is currently in progress.
 */
function isRunActive() {
  return isRunInProgress;
}

module.exports = {
  startScheduler,
  stopScheduler,
  runScheduledChecks,
  isSchedulerRunning,
  getActiveSchedule,
  isRunActive,
  DEFAULT_CRON_SCHEDULE
};
