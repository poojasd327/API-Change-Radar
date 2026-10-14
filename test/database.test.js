const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../src/app');
const Endpoint = require('../src/models/Endpoint');
const Contract = require('../src/models/Contract');
const CheckRun = require('../src/models/CheckRun');
const { seedDemoData } = require('../src/scripts/seed');
const { productSchema } = require('../src/contracts/product.schema');

test('Milestone 4: MongoDB Database Integration & Persistence Suite', async (t) => {
  let mongod;
  let server;
  let baseUrl;

  // Setup: Spin up isolated in-memory MongoDB and ephemeral HTTP test server
  mongod = await MongoMemoryServer.create();
  const mongoUri = mongod.getUri();
  await mongoose.connect(mongoUri);

  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  app.set('mockApiBaseUrl', `${baseUrl}/mock-api/products`);

  t.after(async () => {
    if (server) server.close();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongod) await mongod.stop();
  });

  // --- 1. MODEL VALIDATION TESTS ---

  await t.test('1. Endpoint model validates required fields and defaults', async () => {
    // Missing required fields should throw validation error
    const invalidEndpoint = new Endpoint({});
    await assert.rejects(
      async () => await invalidEndpoint.validate(),
      (err) => {
        assert.ok(err.errors.name);
        assert.ok(err.errors.url);
        return true;
      }
    );

    // Valid endpoint with defaults
    const valid = new Endpoint({
      name: 'Test Endpoint',
      url: 'http://localhost:5001/mock-api/products/101'
    });
    await valid.validate();
    assert.equal(valid.method, 'GET');
    assert.equal(valid.isActive, true);
  });

  await t.test('2. Contract model validates required fields and versioning', async () => {
    const invalidContract = new Contract({ version: 0 });
    await assert.rejects(
      async () => await invalidContract.validate(),
      (err) => {
        assert.ok(err.errors.endpoint);
        assert.ok(err.errors.name);
        assert.ok(err.errors.schema);
        assert.ok(err.errors.version);
        return true;
      }
    );
  });

  await t.test('3. CheckRun model validates status enum and required references', async () => {
    const invalidCheck = new CheckRun({ status: 'invalid-status' });
    await assert.rejects(
      async () => await invalidCheck.validate(),
      (err) => {
        assert.ok(err.errors.endpoint);
        assert.ok(err.errors.contract);
        assert.ok(err.errors.status);
        return true;
      }
    );
  });

  // --- 2. SEED IDEMPOTENCY TESTS ---

  await t.test('4. Seed script is idempotent and does not create duplicate records', async () => {
    // First run: creates records
    const seed1 = await seedDemoData();
    assert.ok(seed1.endpoint._id);
    assert.ok(seed1.contract._id);

    const countEndpoints1 = await Endpoint.countDocuments();
    const countContracts1 = await Contract.countDocuments();
    assert.equal(countEndpoints1, 1);
    assert.equal(countContracts1, 1);

    // Second run: must reuse existing records without duplicating
    const seed2 = await seedDemoData();
    assert.equal(seed2.endpoint._id.toString(), seed1.endpoint._id.toString());
    assert.equal(seed2.contract._id.toString(), seed1.contract._id.toString());

    const countEndpoints2 = await Endpoint.countDocuments();
    const countContracts2 = await Contract.countDocuments();
    assert.equal(countEndpoints2, 1);
    assert.equal(countContracts2, 1);
  });

  // --- 3. PERSISTENCE VIA POST /api/checks/mock-product ---

  await t.test('5. Manual check saves a CheckRun document to MongoDB', async () => {
    const res = await fetch(`${baseUrl}/api/checks/mock-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'healthy');
    assert.ok(body.checkRunId, 'checkRunId must be returned');

    // Query database directly to verify record was persisted
    const saved = await CheckRun.findById(body.checkRunId);
    assert.ok(saved);
    assert.equal(saved.status, 'healthy');
    assert.equal(saved.schemaValid, true);
    assert.equal(saved.httpStatus, 200);
    assert.equal(saved.errors.length, 0);
  });

  await t.test('6. Broken scenario persists schema failure details', async () => {
    const res = await fetch(`${baseUrl}/api/checks/mock-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'wrong-price-type' })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'failed');
    assert.equal(body.failureType, 'SCHEMA_VIOLATION');
    assert.ok(body.checkRunId);

    const saved = await CheckRun.findById(body.checkRunId);
    assert.ok(saved);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.failureType, 'SCHEMA_VIOLATION');
    assert.equal(saved.schemaValid, false);
    assert.ok(saved.errors.some(e => e.includes("Field 'price' must be of type number")));
  });

  // --- 4. CHECK HISTORY & PAGINATION TESTS ---

  await t.test('7. GET /api/checks/history returns records sorted newest first', async () => {
    const res = await fetch(`${baseUrl}/api/checks/history`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length >= 2);
    assert.equal(body.pagination.total, body.data.length);

    // Verify newest first
    const dateFirst = new Date(body.data[0].checkedAt).getTime();
    const dateSecond = new Date(body.data[1].checkedAt).getTime();
    assert.ok(dateFirst >= dateSecond);

    // Verify populated references
    assert.ok(body.data[0].endpoint.name);
    assert.ok(body.data[0].contract.name);

    // Verify __v is stripped
    assert.equal(body.data[0].__v, undefined);
  });

  await t.test('8. GET /api/checks/history supports limit and page query parameters', async () => {
    const res = await fetch(`${baseUrl}/api/checks/history?limit=1&page=1`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.pagination.page, 1);
    assert.equal(body.pagination.limit, 1);
    assert.ok(body.pagination.totalPages >= 2);
    assert.equal(body.pagination.hasNextPage, true);
  });

  await t.test('9. GET /api/checks/history rejects invalid pagination parameters with 400', async () => {
    // Negative or 0 page
    const resPage = await fetch(`${baseUrl}/api/checks/history?page=0`);
    assert.equal(resPage.status, 400);
    const bodyPage = await resPage.json();
    assert.equal(bodyPage.error, 'BadRequest');

    // Limit out of range
    const resLimit = await fetch(`${baseUrl}/api/checks/history?limit=500`);
    assert.equal(resLimit.status, 400);
    const bodyLimit = await resLimit.json();
    assert.equal(bodyLimit.error, 'BadRequest');
  });

  await t.test('10. GET /api/checks/history/latest returns the most recent check run', async () => {
    const res = await fetch(`${baseUrl}/api/checks/history/latest`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(body._id);
    assert.ok(body.status);
    assert.ok(body.endpoint.name);
    assert.ok(body.contract.name);
  });
});
