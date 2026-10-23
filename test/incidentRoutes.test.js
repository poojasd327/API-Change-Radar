const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../src/app');
const Endpoint = require('../src/models/Endpoint');
const Contract = require('../src/models/Contract');
const Incident = require('../src/models/Incident');
const { productSchema } = require('../src/contracts/product.schema');

const User = require('../src/models/User');
const { generateToken } = require('../src/services/auth.service');

test('Milestone 6, Step 3: Incident REST API Routes Suite', async (t) => {
  let mongod;
  let server;
  let baseUrl;

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-12345';
  process.env.JWT_EXPIRES_IN = '1h';

  const testUser = await User.create({
    name: 'Incident Suite User',
    email: 'incident-suite@example.com',
    password: 'securePassword123'
  });
  const authToken = generateToken(testUser);

  const nativeFetch = globalThis.fetch;
  const fetch = (url, opts = {}) => {
    const headers = { ...opts?.headers };
    if (!headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    return nativeFetch(url, { ...opts, headers });
  };

  const origEndpointCreate = Endpoint.create.bind(Endpoint);
  Endpoint.create = function(doc, ...args) {
    if (Array.isArray(doc)) {
      doc.forEach(d => { if (!d.userId) d.userId = testUser._id; });
    } else if (doc && !doc.userId) {
      doc.userId = testUser._id;
    }
    return origEndpointCreate(doc, ...args);
  };

  const origContractCreate = Contract.create.bind(Contract);
  Contract.create = function(doc, ...args) {
    if (doc && !doc.userId) {
      doc.userId = testUser._id;
    }
    return origContractCreate(doc, ...args);
  };

  const origIncidentCreate = Incident.create.bind(Incident);
  Incident.create = function(doc, ...args) {
    if (doc && !doc.userId) {
      doc.userId = testUser._id;
    }
    return origIncidentCreate(doc, ...args);
  };

  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    Endpoint.create = origEndpointCreate;
    Contract.create = origContractCreate;
    Incident.create = origIncidentCreate;
    if (server) server.close();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongod) await mongod.stop();
  });

  t.beforeEach(async () => {
    await Incident.deleteMany({});
    await Endpoint.deleteMany({});
    await Contract.deleteMany({});
  });

  // --- 1. LIST INCIDENTS & ORDERING ---

  await t.test('1. GET /api/incidents returns list sorted by lastSeenAt descending', async () => {
    const endpoint = await Endpoint.create({
      name: 'Test Endpoint',
      url: 'http://localhost:5001/mock-api/products/101',
      method: 'GET'
    });

    const contract = await Contract.create({
      endpoint: endpoint._id,
      name: 'Approved Contract',
      schema: productSchema
    });

    // Create older incident
    await Incident.create({
      endpoint: endpoint._id,
      contract: contract._id,
      failureType: 'HTTP_ERROR',
      title: 'Older Incident',
      status: 'resolved',
      lastSeenAt: new Date(Date.now() - 60000),
      resolvedAt: new Date()
    });

    // Create newer incident
    await Incident.create({
      endpoint: endpoint._id,
      contract: contract._id,
      failureType: 'SCHEMA_VIOLATION',
      title: 'Newer Incident',
      status: 'open',
      lastSeenAt: new Date()
    });

    const res = await fetch(`${baseUrl}/api/incidents`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.data.length, 2);
    assert.equal(body.pagination.total, 2);
    assert.equal(body.pagination.page, 1);
    assert.equal(body.pagination.limit, 20);

    // Verify ordering: newest activity first
    assert.equal(body.data[0].title, 'Newer Incident');
    assert.equal(body.data[1].title, 'Older Incident');

    // Verify populated endpoint and contract references
    assert.equal(body.data[0].endpoint.name, 'Test Endpoint');
    assert.equal(body.data[0].endpoint.url, 'http://localhost:5001/mock-api/products/101');
    assert.equal(body.data[0].contract.name, 'Approved Contract');

    // Verify internal __v is excluded
    assert.equal(body.data[0].__v, undefined);
  });

  // --- 2. STATUS FILTERING ---

  await t.test('2. GET /api/incidents filters by status (open vs resolved)', async () => {
    const endpoint = await Endpoint.create({
      name: 'Filter Endpoint',
      url: 'http://localhost:5001/mock-api/products/101',
      method: 'GET'
    });

    await Incident.create({
      endpoint: endpoint._id,
      failureType: 'TIMEOUT',
      title: 'Open Incident',
      status: 'open'
    });

    await Incident.create({
      endpoint: endpoint._id,
      failureType: 'HTTP_ERROR',
      title: 'Resolved Incident',
      status: 'resolved',
      resolvedAt: new Date()
    });

    // Filter status=open
    const openRes = await fetch(`${baseUrl}/api/incidents?status=open`);
    assert.equal(openRes.status, 200);
    const openBody = await openRes.json();
    assert.equal(openBody.data.length, 1);
    assert.equal(openBody.data[0].status, 'open');
    assert.equal(openBody.data[0].title, 'Open Incident');

    // Filter status=resolved
    const resolvedRes = await fetch(`${baseUrl}/api/incidents?status=resolved`);
    assert.equal(resolvedRes.status, 200);
    const resolvedBody = await resolvedRes.json();
    assert.equal(resolvedBody.data.length, 1);
    assert.equal(resolvedBody.data[0].status, 'resolved');
    assert.equal(resolvedBody.data[0].title, 'Resolved Incident');

    // Invalid status filter returns 400
    const invalidRes = await fetch(`${baseUrl}/api/incidents?status=closed`);
    assert.equal(invalidRes.status, 400);
    const invalidBody = await invalidRes.json();
    assert.equal(invalidBody.error, 'BadRequest');
    assert.match(invalidBody.message, /Query parameter 'status' must be one of/);
  });

  // --- 3. PAGINATION & VALIDATION ---

  await t.test('3. GET /api/incidents handles pagination and invalid query parameters', async () => {
    const endpoint = await Endpoint.create({
      name: 'Pagination Endpoint',
      url: 'http://localhost:5001/mock-api/products/101',
      method: 'GET'
    });

    // Seed 3 incidents
    for (let i = 1; i <= 3; i++) {
      await Incident.create({
        endpoint: endpoint._id,
        failureType: 'HTTP_ERROR',
        title: `Incident ${i}`,
        status: 'open'
      });
    }

    // Paginate limit=2, page=1
    const resPage1 = await fetch(`${baseUrl}/api/incidents?limit=2&page=1`);
    assert.equal(resPage1.status, 200);
    const bodyPage1 = await resPage1.json();
    assert.equal(bodyPage1.data.length, 2);
    assert.equal(bodyPage1.pagination.page, 1);
    assert.equal(bodyPage1.pagination.limit, 2);
    assert.equal(bodyPage1.pagination.total, 3);
    assert.equal(bodyPage1.pagination.totalPages, 2);
    assert.equal(bodyPage1.pagination.hasNextPage, true);
    assert.equal(bodyPage1.pagination.hasPrevPage, false);

    // Paginate limit=2, page=2
    const resPage2 = await fetch(`${baseUrl}/api/incidents?limit=2&page=2`);
    assert.equal(resPage2.status, 200);
    const bodyPage2 = await resPage2.json();
    assert.equal(bodyPage2.data.length, 1);
    assert.equal(bodyPage2.pagination.page, 2);
    assert.equal(bodyPage2.pagination.hasNextPage, false);
    assert.equal(bodyPage2.pagination.hasPrevPage, true);

    // Invalid page parameter returns 400
    const resBadPage = await fetch(`${baseUrl}/api/incidents?page=0`);
    assert.equal(resBadPage.status, 400);
    const badPageBody = await resBadPage.json();
    assert.equal(badPageBody.error, 'BadRequest');

    // Invalid limit parameter returns 400
    const resBadLimit = await fetch(`${baseUrl}/api/incidents?limit=200`);
    assert.equal(resBadLimit.status, 400);
    const badLimitBody = await resBadLimit.json();
    assert.equal(badLimitBody.error, 'BadRequest');
  });

  // --- 4. RETRIEVE SINGLE INCIDENT BY ID ---

  await t.test('4. GET /api/incidents/:id returns single incident or appropriate error', async () => {
    const endpoint = await Endpoint.create({
      name: 'Single Incident Endpoint',
      url: 'http://localhost:5001/mock-api/products/101',
      method: 'GET'
    });

    const incident = await Incident.create({
      endpoint: endpoint._id,
      failureType: 'SCHEMA_VIOLATION',
      title: 'Detailed Incident',
      description: 'Expected number for price but got string',
      status: 'open',
      occurrenceCount: 3
    });

    // 1. Valid existing ID returns 200
    const resValid = await fetch(`${baseUrl}/api/incidents/${incident._id}`);
    assert.equal(resValid.status, 200);
    const bodyValid = await resValid.json();
    assert.equal(bodyValid._id, incident._id.toString());
    assert.equal(bodyValid.title, 'Detailed Incident');
    assert.equal(bodyValid.occurrenceCount, 3);
    assert.equal(bodyValid.endpoint.name, 'Single Incident Endpoint');

    // 2. Non-existent valid ObjectId returns 404
    const nonExistentId = new mongoose.Types.ObjectId();
    const resNotFound = await fetch(`${baseUrl}/api/incidents/${nonExistentId}`);
    assert.equal(resNotFound.status, 404);
    const bodyNotFound = await resNotFound.json();
    assert.equal(bodyNotFound.error, 'NotFound');
    assert.match(bodyNotFound.message, /was not found/);

    // 3. Malformed invalid ID returns 400
    const resInvalidId = await fetch(`${baseUrl}/api/incidents/not-a-valid-id`);
    assert.equal(resInvalidId.status, 400);
    const bodyInvalidId = await resInvalidId.json();
    assert.equal(bodyInvalidId.error, 'BadRequest');
    assert.match(bodyInvalidId.message, /Invalid incident ID format/);
  });
});
