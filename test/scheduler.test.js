const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../src/app');
const Endpoint = require('../src/models/Endpoint');
const Contract = require('../src/models/Contract');
const CheckRun = require('../src/models/CheckRun');
const { productSchema } = require('../src/contracts/product.schema');
const {
  startScheduler,
  stopScheduler,
  runScheduledChecks,
  isSchedulerRunning,
  getActiveSchedule,
  DEFAULT_CRON_SCHEDULE
} = require('../src/services/scheduler.service');

test('Milestone 5: Automatic API Monitoring Scheduler Suite', async (t) => {
  let mongod;
  let server;
  let baseUrl;

  // Setup: Spin up isolated in-memory MongoDB and ephemeral HTTP test server
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  app.set('mockApiBaseUrl', `${baseUrl}/mock-api/products`);

  t.after(async () => {
    stopScheduler();
    if (server) server.close();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongod) await mongod.stop();
  });

  // Ensure scheduler is stopped before each test
  t.beforeEach(() => {
    stopScheduler();
  });

  // --- 1. SCHEDULER CONFIGURATION & LIFECYCLE ---

  await t.test('1. Scheduler starts and stops cleanly with default schedule', () => {
    assert.equal(isSchedulerRunning(), false);

    const { schedule, task } = startScheduler();
    assert.equal(schedule, DEFAULT_CRON_SCHEDULE);
    assert.ok(task);
    assert.equal(isSchedulerRunning(), true);

    stopScheduler();
    assert.equal(isSchedulerRunning(), false);
  });

  await t.test('2. Scheduler accepts custom cron schedule and validates invalid expressions', () => {
    const customSchedule = '0 * * * *';
    const { schedule } = startScheduler(customSchedule);
    assert.equal(schedule, customSchedule);
    stopScheduler();

    // Invalid cron expression should fall back to default safely
    const fallback = startScheduler('invalid-cron-string');
    assert.equal(fallback.schedule, DEFAULT_CRON_SCHEDULE);
    stopScheduler();
  });

  await t.test('3. Starting an already running scheduler prevents duplicate tasks', () => {
    startScheduler();
    const secondStart = startScheduler();
    assert.ok(secondStart);
    assert.equal(isSchedulerRunning(), true);
    stopScheduler();
  });

  // --- 2. SCHEDULED CHECK EXECUTION & PERSISTENCE ---

  await t.test('4. runScheduledChecks finds active endpoints and persists CheckRun to DB', async () => {
    // Create an active endpoint and contract
    const endpoint = await Endpoint.create({
      name: 'Scheduled Test Endpoint',
      url: `${baseUrl}/mock-api/products/101`,
      method: 'GET',
      isActive: true
    });

    const contract = await Contract.create({
      endpoint: endpoint._id,
      name: 'Scheduled Contract v1',
      schema: productSchema,
      version: 1,
      isActive: true
    });

    const summary = await runScheduledChecks({ overrideBaseUrl: baseUrl });
    assert.equal(summary.totalEndpoints, 1);
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 0);

    // Verify CheckRun was saved in MongoDB
    const savedCheck = await CheckRun.findOne({ endpoint: endpoint._id });
    assert.ok(savedCheck);
    assert.equal(savedCheck.status, 'healthy');
    assert.equal(savedCheck.schemaValid, true);
    assert.equal(savedCheck.contract.toString(), contract._id.toString());
  });

  await t.test('5. Inactive endpoints are skipped by the scheduler', async () => {
    await Endpoint.deleteMany({});
    await Contract.deleteMany({});
    await CheckRun.deleteMany({});

    // Create an inactive endpoint
    await Endpoint.create({
      name: 'Inactive Endpoint',
      url: `${baseUrl}/mock-api/products/101`,
      method: 'GET',
      isActive: false
    });

    const summary = await runScheduledChecks({ overrideBaseUrl: baseUrl });
    assert.equal(summary.totalEndpoints, 0);
    assert.equal(summary.passed, 0);

    const count = await CheckRun.countDocuments();
    assert.equal(count, 0);
  });

  // --- 3. FAILURE HANDLING ---

  await t.test('6. Broken endpoint is recorded as failed without crashing scheduler', async () => {
    await Endpoint.deleteMany({});
    await Contract.deleteMany({});
    await CheckRun.deleteMany({});

    // Point endpoint to broken scenario
    const brokenEndpoint = await Endpoint.create({
      name: 'Broken Endpoint',
      url: `${baseUrl}/mock-api/products/101?scenario=wrong-price-type`,
      method: 'GET',
      isActive: true
    });

    await Contract.create({
      endpoint: brokenEndpoint._id,
      name: 'Approved Contract',
      schema: productSchema,
      version: 1,
      isActive: true
    });

    const summary = await runScheduledChecks({ overrideBaseUrl: baseUrl });
    assert.equal(summary.totalEndpoints, 1);
    assert.equal(summary.passed, 0);
    assert.equal(summary.failed, 1);

    const savedCheck = await CheckRun.findOne({ endpoint: brokenEndpoint._id });
    assert.ok(savedCheck);
    assert.equal(savedCheck.status, 'failed');
    assert.equal(savedCheck.failureType, 'SCHEMA_VIOLATION');
    assert.equal(savedCheck.schemaValid, false);
  });

  await t.test('7. Endpoint without active contract is skipped safely', async () => {
    await Endpoint.deleteMany({});
    await Contract.deleteMany({});

    await Endpoint.create({
      name: 'Orphan Endpoint',
      url: `${baseUrl}/mock-api/products/101`,
      method: 'GET',
      isActive: true
    });

    const summary = await runScheduledChecks({ overrideBaseUrl: baseUrl });
    assert.equal(summary.totalEndpoints, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.passed, 0);
  });

  // --- 4. OVERLAP PREVENTION ---

  await t.test('8. Overlapping scheduled runs are skipped', async () => {
    // Simulate an ongoing run by firing runScheduledChecks concurrently
    const [res1, res2] = await Promise.all([
      runScheduledChecks({ overrideBaseUrl: baseUrl }),
      runScheduledChecks({ overrideBaseUrl: baseUrl })
    ]);

    // One of the runs should either complete or be skipped due to overlap
    const oneWasSkipped = res1.status === 'skipped' || res2.status === 'skipped';
    assert.ok(oneWasSkipped, 'Expected one concurrent run to be skipped due to OVERLAPPING_RUN');
  });
});
