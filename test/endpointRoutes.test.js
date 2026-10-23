const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../src/app');
const Endpoint = require('../src/models/Endpoint');
const Contract = require('../src/models/Contract');
const CheckRun = require('../src/models/CheckRun');
const { productSchema } = require('../src/contracts/product.schema');

test('Milestone 7A: Endpoint Management REST API & SSRF Protections Suite', async (t) => {
  let mongod;
  let server;
  let baseUrl;

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  // Configure a deterministic mock DNS resolver on the Express app so tests
  // never send real DNS queries or external network requests.
  const mockDnsRecords = {
    'api.weather.com': [{ address: '93.184.216.34', family: 4 }],
    'api.github.com': [{ address: '140.82.121.4', family: 4 }],
    'public-service.org': [{ address: '151.101.1.69', family: 4 }],
    'rebind.attacker.com': [{ address: '127.0.0.1', family: 4 }],
    'internal-alias.test': [{ address: '10.0.0.5', family: 4 }],
    'imds-alias.test': [{ address: '169.254.169.254', family: 4 }]
  };

  app.set('dnsResolver', async (hostname) => {
    if (mockDnsRecords[hostname]) {
      return mockDnsRecords[hostname];
    }
    const err = new Error(`ENOTFOUND ${hostname}`);
    err.code = 'ENOTFOUND';
    throw err;
  });

  const User = require('../src/models/User');
  const { generateToken } = require('../src/services/auth.service');

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-12345';
  process.env.JWT_EXPIRES_IN = '1h';

  const testUser = await User.create({
    name: 'Endpoint Suite User',
    email: 'endpoint-suite@example.com',
    password: 'securePassword123'
  });
  const authToken = generateToken(testUser);

  const nativeFetch = globalThis.fetch;
  const fetch = (url, opts = {}) => {
    const headers = { ...opts.headers };
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

  const origCheckRunCreate = CheckRun.create.bind(CheckRun);
  CheckRun.create = function(doc, ...args) {
    if (doc && !doc.userId) {
      doc.userId = testUser._id;
    }
    return origCheckRunCreate(doc, ...args);
  };

  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    Endpoint.create = origEndpointCreate;
    Contract.create = origContractCreate;
    CheckRun.create = origCheckRunCreate;
    if (server) server.close();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongod) await mongod.stop();
  });

  t.beforeEach(async () => {
    await CheckRun.deleteMany({});
    await Contract.deleteMany({});
    await Endpoint.deleteMany({});
  });

  // =========================================================================
  // 1. GET /api/endpoints (Listing, Sorting, Pagination, Summaries, Filtering)
  // =========================================================================

  await t.test('1. GET /api/endpoints returns empty list when no endpoints exist', async () => {
    const res = await fetch(`${baseUrl}/api/endpoints`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.deepEqual(body.data, []);
    assert.equal(body.pagination.total, 0);
    assert.equal(body.pagination.page, 1);
    assert.equal(body.pagination.limit, 20);
    assert.equal(body.pagination.totalPages, 1);
    assert.equal(body.pagination.hasNextPage, false);
    assert.equal(body.pagination.hasPrevPage, false);
  });

  await t.test('2. GET /api/endpoints returns persisted endpoints with safe latest check summaries and contract status', async () => {
    const ep1 = await Endpoint.create({
      name: 'Weather API',
      url: 'https://api.weather.com/v1',
      method: 'GET',
      isActive: true
    });

    const ep2 = await Endpoint.create({
      name: 'GitHub API',
      url: 'https://api.github.com/v1',
      method: 'GET',
      isActive: false
    });

    const contract1 = await Contract.create({
      endpoint: ep1._id,
      name: 'Weather Contract v1',
      schema: productSchema,
      version: 1,
      isActive: true
    });

    // Create an older check and a newer check for ep1
    await CheckRun.create({
      endpoint: ep1._id,
      contract: contract1._id,
      status: 'failed',
      failureType: 'HTTP_ERROR',
      httpStatus: 500,
      responseTimeMs: 250,
      checkedAt: new Date(Date.now() - 60000)
    });

    await CheckRun.create({
      endpoint: ep1._id,
      contract: contract1._id,
      status: 'healthy',
      failureType: null,
      httpStatus: 200,
      responseTimeMs: 45,
      checkedAt: new Date()
    });

    const res = await fetch(`${baseUrl}/api/endpoints`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.data.length, 2);
    assert.equal(body.pagination.total, 2);

    // Sorted newest created first: ep2 then ep1
    const foundEp1 = body.data.find(e => e._id === ep1._id.toString());
    const foundEp2 = body.data.find(e => e._id === ep2._id.toString());

    assert.ok(foundEp1);
    assert.equal(foundEp1.name, 'Weather API');
    assert.equal(foundEp1.hasActiveContract, true);
    assert.ok(foundEp1.latestCheck);
    assert.equal(foundEp1.latestCheck.status, 'healthy');
    assert.equal(foundEp1.latestCheck.httpStatus, 200);
    assert.equal(foundEp1.latestCheck.responseTimeMs, 45);

    assert.ok(foundEp2);
    assert.equal(foundEp2.name, 'GitHub API');
    assert.equal(foundEp2.hasActiveContract, false);
    assert.equal(foundEp2.latestCheck, null);
    assert.equal(foundEp2.__v, undefined);
  });

  await t.test('3. GET /api/endpoints filters by isActive and paginates properly', async () => {
    for (let i = 1; i <= 5; i++) {
      await Endpoint.create({
        name: `Endpoint ${i}`,
        url: `https://api.github.com/item/${i}`,
        method: 'GET',
        isActive: i % 2 === 1 // 1, 3, 5 are active; 2, 4 are inactive
      });
    }

    // Filter isActive=true
    const activeRes = await fetch(`${baseUrl}/api/endpoints?isActive=true`);
    assert.equal(activeRes.status, 200);
    const activeBody = await activeRes.json();
    assert.equal(activeBody.data.length, 3);
    assert.equal(activeBody.pagination.total, 3);
    assert.ok(activeBody.data.every(e => e.isActive === true));

    // Filter isActive=false
    const inactiveRes = await fetch(`${baseUrl}/api/endpoints?isActive=false`);
    assert.equal(inactiveRes.status, 200);
    const inactiveBody = await inactiveRes.json();
    assert.equal(inactiveBody.data.length, 2);
    assert.equal(inactiveBody.pagination.total, 2);
    assert.ok(inactiveBody.data.every(e => e.isActive === false));

    // Pagination limit=2, page=1
    const page1Res = await fetch(`${baseUrl}/api/endpoints?limit=2&page=1`);
    assert.equal(page1Res.status, 200);
    const page1Body = await page1Res.json();
    assert.equal(page1Body.data.length, 2);
    assert.equal(page1Body.pagination.page, 1);
    assert.equal(page1Body.pagination.totalPages, 3);
    assert.equal(page1Body.pagination.hasNextPage, true);
    assert.equal(page1Body.pagination.hasPrevPage, false);

    // Invalid isActive filter returns 400
    const badFilterRes = await fetch(`${baseUrl}/api/endpoints?isActive=maybe`);
    assert.equal(badFilterRes.status, 400);

    // Invalid page & limit query params return 400
    const badPageRes = await fetch(`${baseUrl}/api/endpoints?page=0`);
    assert.equal(badPageRes.status, 400);

    const badLimitRes = await fetch(`${baseUrl}/api/endpoints?limit=500`);
    assert.equal(badLimitRes.status, 400);
  });

  // =========================================================================
  // 2. GET /api/endpoints/:id (Single Endpoint Retrieval)
  // =========================================================================

  await t.test('4. GET /api/endpoints/:id returns single endpoint with contract & latest check', async () => {
    const endpoint = await Endpoint.create({
      name: 'Single Inspection Endpoint',
      url: 'https://public-service.org/v1/status',
      method: 'GET'
    });

    const contract = await Contract.create({
      endpoint: endpoint._id,
      name: 'Inspection Contract',
      schema: productSchema,
      version: 1,
      isActive: true
    });

    await CheckRun.create({
      endpoint: endpoint._id,
      contract: contract._id,
      status: 'healthy',
      failureType: null,
      httpStatus: 200,
      responseTimeMs: 32,
      checkedAt: new Date()
    });

    const res = await fetch(`${baseUrl}/api/endpoints/${endpoint._id}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body._id, endpoint._id.toString());
    assert.equal(body.name, 'Single Inspection Endpoint');
    assert.equal(body.url, 'https://public-service.org/v1/status');
    assert.equal(body.hasActiveContract, true);
    assert.equal(body.activeContract.name, 'Inspection Contract');
    assert.equal(body.latestCheck.status, 'healthy');
    assert.equal(body.latestCheck.responseTimeMs, 32);
  });

  await t.test('5. GET /api/endpoints/:id handles invalid ObjectId format and missing ID', async () => {
    // Malformed ID returns 400
    const badIdRes = await fetch(`${baseUrl}/api/endpoints/not-a-valid-id`);
    assert.equal(badIdRes.status, 400);
    const badIdBody = await badIdRes.json();
    assert.equal(badIdBody.error, 'BadRequest');
    assert.match(badIdBody.message, /Invalid endpoint ID format/);

    // Non-existent ID returns 404
    const nonExistentId = new mongoose.Types.ObjectId();
    const notFoundRes = await fetch(`${baseUrl}/api/endpoints/${nonExistentId}`);
    assert.equal(notFoundRes.status, 404);
    const notFoundBody = await notFoundRes.json();
    assert.equal(notFoundBody.error, 'NotFound');
    assert.match(notFoundBody.message, /was not found/);
  });

  // =========================================================================
  // 3. POST /api/endpoints (Creation, Validation, Security & Duplicate Handling)
  // =========================================================================

  await t.test('6. POST /api/endpoints creates endpoint successfully with defaults', async () => {
    const payload = {
      name: 'Public Weather Endpoint',
      url: 'https://api.weather.com/v1/forecast'
    };

    const res = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body._id);
    assert.equal(body.name, 'Public Weather Endpoint');
    assert.equal(body.url, 'https://api.weather.com/v1/forecast');
    assert.equal(body.method, 'GET');
    assert.equal(body.isActive, true);
    assert.equal(body.hasActiveContract, false);
    assert.match(body.message, /approved contract must be registered before automated checks/);

    // Verify persisted in DB
    const persisted = await Endpoint.findById(body._id);
    assert.ok(persisted);
    assert.equal(persisted.name, 'Public Weather Endpoint');
  });

  await t.test('7. POST /api/endpoints accepts custom supported method and isActive', async () => {
    const payload = {
      name: 'GitHub Events Webhook',
      url: 'https://api.github.com/events',
      method: 'POST',
      isActive: false
    };

    const res = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.method, 'POST');
    assert.equal(body.isActive, false);
  });

  await t.test('8. POST /api/endpoints validates required fields, types, and supported methods', async () => {
    // Missing name
    const resNoName = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://api.weather.com/v1' })
    });
    assert.equal(resNoName.status, 400);
    assert.match((await resNoName.json()).message, /Endpoint name is required/);

    // Empty/blank name
    const resEmptyName = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ', url: 'https://api.weather.com/v1' })
    });
    assert.equal(resEmptyName.status, 400);

    // Missing URL
    const resNoUrl = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Valid Name' })
    });
    assert.equal(resNoUrl.status, 400);
    assert.match((await resNoUrl.json()).message, /Endpoint URL is required/);

    // Unsupported HTTP method
    const resBadMethod = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad Method EP',
        url: 'https://api.weather.com/v1',
        method: 'CONNECT'
      })
    });
    assert.equal(resBadMethod.status, 400);
    assert.match((await resBadMethod.json()).message, /Unsupported HTTP method/);

    // Non-boolean isActive
    const resBadActive = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad Active EP',
        url: 'https://api.weather.com/v1',
        isActive: 'yes'
      })
    });
    assert.equal(resBadActive.status, 400);
    assert.match((await resBadActive.json()).message, /Field 'isActive' must be a boolean/);
  });

  await t.test('9. POST /api/endpoints rejects arbitrary/unapproved fields (headers, credentials, body)', async () => {
    const res = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Smuggled Fields EP',
        url: 'https://api.weather.com/v1',
        headers: { Authorization: 'Bearer secret-token' },
        credentials: { user: 'admin', pass: 'secret' },
        body: { query: 'test' }
      })
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'BadRequest');
    assert.match(body.message, /Unrecognized or prohibited field\(s\)/);
    assert.match(body.message, /headers/);
    assert.match(body.message, /credentials/);
  });

  await t.test('10. POST /api/endpoints rejects duplicate URL and duplicate name with 409 Conflict', async () => {
    await Endpoint.create({
      name: 'Existing Endpoint',
      url: 'https://api.weather.com/forecast',
      method: 'GET'
    });

    // Duplicate URL conflict
    const resDupUrl = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Different Name',
        url: 'https://api.weather.com/forecast'
      })
    });
    assert.equal(resDupUrl.status, 409);
    const bodyDupUrl = await resDupUrl.json();
    assert.equal(bodyDupUrl.error, 'Conflict');
    assert.match(bodyDupUrl.message, /already exists/);

    // Duplicate Name conflict
    const resDupName = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Existing Endpoint',
        url: 'https://api.weather.com/another-path'
      })
    });
    assert.equal(resDupName.status, 409);
    const bodyDupName = await resDupName.json();
    assert.equal(bodyDupName.error, 'Conflict');
    assert.match(bodyDupName.message, /already exists/);
  });

  // =========================================================================
  // 4. Strict SSRF Protection Tests
  // =========================================================================

  await t.test('11. POST /api/endpoints blocks loopback, private, and prohibited destinations (SSRF)', async () => {
    const prohibitedUrls = [
      // Loopback hostnames & IPs
      'http://localhost:5001/api',
      'http://service.localhost/api',
      'http://127.0.0.1:8080/data',
      'http://127.0.1.1:3000/info',
      'http://0.0.0.0:5000/status',
      'http://[::1]/api',
      'http://[::ffff:127.0.0.1]/status',
      // Cloud metadata (IMDS)
      'http://169.254.169.254/latest/meta-data',
      'http://metadata.google.internal/computeMetadata/v1',
      'http://metadata.goog/info',
      'http://instance-data/metadata',
      // Private RFC 1918 ranges
      'http://10.0.0.1:8000/secret',
      'http://172.16.0.10:4000/db',
      'http://172.31.255.255/admin',
      'http://192.168.1.1/router',
      // Private TLDs
      'http://backend.internal/api',
      'http://server.local/api',
      'http://router.lan/admin',
      // Prohibited protocols
      'file:///etc/passwd',
      'ftp://ftp.example.com/files',
      'gopher://gopher.example.com/',
      // Embedded credentials
      'https://admin:secret@api.weather.com/v1',
      // DNS resolution to loopback / private IP (DNS rebinding / local alias)
      'https://rebind.attacker.com/leak',
      'https://internal-alias.test/db',
      'https://imds-alias.test/meta-data',
      // Unresolvable domain
      'https://completely-non-existent-domain-xyz.org/test'
    ];

    for (const badUrl of prohibitedUrls) {
      const res = await fetch(`${baseUrl}/api/endpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `SSRF Test - ${badUrl.slice(0, 30)}`,
          url: badUrl
        })
      });

      assert.equal(
        res.status,
        400,
        `Expected HTTP 400 BadRequest for prohibited URL: ${badUrl}, got ${res.status}`
      );

      const body = await res.json();
      assert.equal(body.error, 'BadRequest');
      assert.match(body.message, /Invalid endpoint URL/);
    }
  });

  // =========================================================================
  // 5. PATCH /api/endpoints/:id (Updating, Field Whitelisting, Pause/Resume)
  // =========================================================================

  await t.test('12. PATCH /api/endpoints/:id updates name and pauses/resumes monitoring (isActive)', async () => {
    const endpoint = await Endpoint.create({
      name: 'Initial Name',
      url: 'https://api.github.com/repos',
      method: 'GET',
      isActive: true
    });

    // 1. Update name
    const resName = await fetch(`${baseUrl}/api/endpoints/${endpoint._id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Name' })
    });
    assert.equal(resName.status, 200);
    const bodyName = await resName.json();
    assert.equal(bodyName.name, 'Updated Name');
    assert.equal(bodyName.isActive, true);

    // 2. Pause monitoring (isActive: false)
    const resPause = await fetch(`${baseUrl}/api/endpoints/${endpoint._id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false })
    });
    assert.equal(resPause.status, 200);
    const bodyPause = await resPause.json();
    assert.equal(bodyPause.isActive, false);

    // 3. Resume monitoring (isActive: true)
    const resResume = await fetch(`${baseUrl}/api/endpoints/${endpoint._id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: true })
    });
    assert.equal(resResume.status, 200);
    const bodyResume = await resResume.json();
    assert.equal(bodyResume.isActive, true);

    // Verify DB state
    const fromDb = await Endpoint.findById(endpoint._id);
    assert.equal(fromDb.name, 'Updated Name');
    assert.equal(fromDb.isActive, true);
  });

  await t.test('13. PATCH /api/endpoints/:id strictly rejects modification of prohibited fields', async () => {
    const endpoint = await Endpoint.create({
      name: 'Protected Field Test',
      url: 'https://api.github.com/users',
      method: 'GET',
      isActive: true
    });

    const forbiddenAttempts = [
      { url: 'https://api.weather.com/new' },
      { method: 'DELETE' },
      { _id: new mongoose.Types.ObjectId() },
      { id: '12345' },
      { createdAt: new Date() },
      { updatedAt: new Date() },
      { headers: { 'X-Custom': 'value' } },
      { contract: new mongoose.Types.ObjectId() }
    ];

    for (const badPayload of forbiddenAttempts) {
      const res = await fetch(`${baseUrl}/api/endpoints/${endpoint._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(badPayload)
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'BadRequest');
      assert.match(body.message, /Modification of field\(s\) .* is not permitted/);
    }
  });

  await t.test('14. PATCH /api/endpoints/:id rejects empty body, duplicate name, malformed ID, and not found', async () => {
    const ep1 = await Endpoint.create({
      name: 'First Endpoint',
      url: 'https://api.github.com/one'
    });

    const ep2 = await Endpoint.create({
      name: 'Second Endpoint',
      url: 'https://api.github.com/two'
    });

    // Empty body
    const emptyRes = await fetch(`${baseUrl}/api/endpoints/${ep1._id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(emptyRes.status, 400);
    assert.match((await emptyRes.json()).message, /must contain at least one field to update/);

    // Duplicate name with another endpoint
    const dupRes = await fetch(`${baseUrl}/api/endpoints/${ep2._id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'First Endpoint' })
    });
    assert.equal(dupRes.status, 409);
    assert.match((await dupRes.json()).message, /already exists/);

    // Malformed ID
    const badIdRes = await fetch(`${baseUrl}/api/endpoints/bad-id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' })
    });
    assert.equal(badIdRes.status, 400);

    // Non-existent ID
    const nonExistentId = new mongoose.Types.ObjectId();
    const notFoundRes = await fetch(`${baseUrl}/api/endpoints/${nonExistentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' })
    });
    assert.equal(notFoundRes.status, 404);
  });

  // =========================================================================
  // 6. Service Unavailable on DB Disconnect
  // =========================================================================

  await t.test('15. Endpoint routes return 503 when MongoDB is disconnected', async () => {
    await mongoose.disconnect();

    const resGet = await fetch(`${baseUrl}/api/endpoints`);
    assert.equal(resGet.status, 503);
    assert.equal((await resGet.json()).error, 'ServiceUnavailable');

    const resPost = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', url: 'https://api.weather.com/v1' })
    });
    assert.equal(resPost.status, 503);

    const resPatch = await fetch(`${baseUrl}/api/endpoints/${new mongoose.Types.ObjectId()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' })
    });
    assert.equal(resPatch.status, 503);

    // Reconnect for cleanup
    await mongoose.connect(mongod.getUri());
  });
});
