const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../src/app');
const User = require('../src/models/User');
const Endpoint = require('../src/models/Endpoint');
const Contract = require('../src/models/Contract');
const CheckRun = require('../src/models/CheckRun');
const Incident = require('../src/models/Incident');
const { generateToken } = require('../src/services/auth.service');
const { runScheduledChecks } = require('../src/services/scheduler.service');
const { resolveEndpointIncidents, recordIncidentFailure } = require('../src/services/incident.service');
const { auditUnresolvedLegacyRecords, assignLegacyOwnership } = require('../src/scripts/migrateLegacyOwnership');
const { productSchema } = require('../src/contracts/product.schema');

test('Stage 2: Per-User Data Isolation and Authorization Suite', async (t) => {
  let mongod;
  let server;
  let baseUrl;
  let alice;
  let bob;
  let aliceToken;
  let bobToken;

  // Spin up isolated in-memory MongoDB and ephemeral HTTP test server
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  // Configure test JWT secret
  process.env.JWT_SECRET = 'stage2-isolation-secret-key-12345';
  process.env.JWT_EXPIRES_IN = '1h';

  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  app.set('mockApiBaseUrl', `${baseUrl}/mock-api/products`);

  // Setup mock DNS resolver for SSRF safety during endpoint creation
  const mockDnsRecords = {
    'api.alice-service.com': [{ address: '93.184.216.34', family: 4 }],
    'api.bob-service.com': [{ address: '151.101.1.69', family: 4 }]
  };
  app.set('dnsResolver', async (hostname) => {
    if (mockDnsRecords[hostname]) {
      return mockDnsRecords[hostname];
    }
    const err = new Error(`ENOTFOUND ${hostname}`);
    err.code = 'ENOTFOUND';
    throw err;
  });

  // Create two distinct users: Alice and Bob
  alice = await User.create({
    name: 'Alice Cooper',
    email: 'alice@example.com',
    password: 'aliceSecurePassword123'
  });
  bob = await User.create({
    name: 'Bob Marley',
    email: 'bob@example.com',
    password: 'bobSecurePassword123'
  });

  aliceToken = generateToken(alice);
  bobToken = generateToken(bob);

  t.after(async () => {
    if (server) server.close();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongod) await mongod.stop();
  });

  // --- 1. ENDPOINT REGISTRATION & ISOLATION ---

  let aliceEndpointId;
  let bobEndpointId;

  await t.test('1. Unauthenticated requests to /api/endpoints are rejected with 401', async () => {
    const resGet = await fetch(`${baseUrl}/api/endpoints`);
    assert.equal(resGet.status, 401);
    const bodyGet = await resGet.json();
    assert.equal(bodyGet.error, 'Unauthorized');

    const resPost = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Unauth API',
        url: 'https://api.alice-service.com/v1'
      })
    });
    assert.equal(resPost.status, 401);
  });

  await t.test('2. Alice and Bob create their own endpoints independently', async () => {
    // Alice creates her endpoint
    const resAlice = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`
      },
      body: JSON.stringify({
        name: 'Alice Catalog API',
        url: 'https://api.alice-service.com/v1',
        method: 'GET'
      })
    });
    assert.equal(resAlice.status, 201);
    const dataAlice = await resAlice.json();
    aliceEndpointId = dataAlice._id;

    // Verify endpoint in DB has Alice's userId
    const aliceInDb = await Endpoint.findById(aliceEndpointId);
    assert.equal(aliceInDb.userId.toString(), alice._id.toString());

    // Bob creates his endpoint
    const resBob = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bobToken}`
      },
      body: JSON.stringify({
        name: 'Bob Inventory API',
        url: 'https://api.bob-service.com/v1',
        method: 'GET'
      })
    });
    assert.equal(resBob.status, 201);
    const dataBob = await resBob.json();
    bobEndpointId = dataBob._id;

    // Verify endpoint in DB has Bob's userId
    const bobInDb = await Endpoint.findById(bobEndpointId);
    assert.equal(bobInDb.userId.toString(), bob._id.toString());
  });

  await t.test('3. Client cannot forge ownership by supplying userId in request body', async () => {
    // Alice attempts to forge Bob's userId when creating an endpoint
    const res = await fetch(`${baseUrl}/api/endpoints`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`
      },
      body: JSON.stringify({
        name: 'Forged Endpoint',
        url: 'https://api.alice-service.com/v2',
        userId: bob._id.toString() // Unauthorized field
      })
    });

    // Prohibited field should be rejected with 400 Bad Request
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'BadRequest');
  });

  await t.test('4. GET /api/endpoints returns strictly user-scoped list', async () => {
    // Alice lists endpoints: should only see Alice Catalog API
    const resAlice = await fetch(`${baseUrl}/api/endpoints`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    assert.equal(resAlice.status, 200);
    const dataAlice = await resAlice.json();
    assert.equal(dataAlice.data.length, 1);
    assert.equal(dataAlice.data[0].name, 'Alice Catalog API');
    assert.equal(dataAlice.data[0]._id, aliceEndpointId);

    // Bob lists endpoints: should only see Bob Inventory API
    const resBob = await fetch(`${baseUrl}/api/endpoints`, {
      headers: { Authorization: `Bearer ${bobToken}` }
    });
    assert.equal(resBob.status, 200);
    const dataBob = await resBob.json();
    assert.equal(dataBob.data.length, 1);
    assert.equal(dataBob.data[0].name, 'Bob Inventory API');
    assert.equal(dataBob.data[0]._id, bobEndpointId);
  });

  await t.test('5. GET /api/endpoints/:id prevents IDOR (Bob cannot read Alice endpoint)', async () => {
    // Alice accesses her own endpoint: 200 OK
    const resOwn = await fetch(`${baseUrl}/api/endpoints/${aliceEndpointId}`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    assert.equal(resOwn.status, 200);
    const dataOwn = await resOwn.json();
    assert.equal(dataOwn._id, aliceEndpointId);

    // Bob tries to access Alice's endpoint by ID: returns 404 Not Found
    const resCross = await fetch(`${baseUrl}/api/endpoints/${aliceEndpointId}`, {
      headers: { Authorization: `Bearer ${bobToken}` }
    });
    assert.equal(resCross.status, 404, 'Accessing another user endpoint must return 404');
    const dataCross = await resCross.json();
    assert.equal(dataCross.error, 'NotFound');
  });

  await t.test('6. PATCH /api/endpoints/:id prevents IDOR (Bob cannot modify Alice endpoint)', async () => {
    // Bob attempts to update Alice's endpoint: returns 404 Not Found
    const resCross = await fetch(`${baseUrl}/api/endpoints/${aliceEndpointId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bobToken}`
      },
      body: JSON.stringify({ name: 'Hacked by Bob' })
    });
    assert.equal(resCross.status, 404);

    // Alice updates her own endpoint: 200 OK
    const resOwn = await fetch(`${baseUrl}/api/endpoints/${aliceEndpointId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`
      },
      body: JSON.stringify({ name: 'Alice Updated API' })
    });
    assert.equal(resOwn.status, 200);
    const dataOwn = await resOwn.json();
    assert.equal(dataOwn.name, 'Alice Updated API');
  });

  // --- 2. CHECK HISTORY & MONITORING ISOLATION ---

  let aliceCheckRunId;

  await t.test('7. POST /api/checks/mock-product associates CheckRun with authenticated user', async () => {
    // Alice runs a check
    const resAlice = await fetch(`${baseUrl}/api/checks/mock-product`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`
      },
      body: JSON.stringify({})
    });
    assert.equal(resAlice.status, 200);
    const dataAlice = await resAlice.json();
    aliceCheckRunId = dataAlice.checkRunId;
    assert.ok(aliceCheckRunId);

    // Verify in database that CheckRun has Alice's userId
    const runInDb = await CheckRun.findById(aliceCheckRunId);
    assert.equal(runInDb.userId.toString(), alice._id.toString());
  });

  await t.test('8. GET /api/checks/history isolates check history between users', async () => {
    // Alice sees her check run
    const resAlice = await fetch(`${baseUrl}/api/checks/history`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    assert.equal(resAlice.status, 200);
    const dataAlice = await resAlice.json();
    assert.ok(dataAlice.data.length >= 1);
    assert.equal(dataAlice.data[0]._id, aliceCheckRunId);

    // Bob has run no checks yet: history returns empty array
    const resBob = await fetch(`${baseUrl}/api/checks/history`, {
      headers: { Authorization: `Bearer ${bobToken}` }
    });
    assert.equal(resBob.status, 200);
    const dataBob = await resBob.json();
    assert.equal(dataBob.data.length, 0);

    // Bob calls /api/checks/history/latest: returns 404 Not Found
    const resLatestBob = await fetch(`${baseUrl}/api/checks/history/latest`, {
      headers: { Authorization: `Bearer ${bobToken}` }
    });
    assert.equal(resLatestBob.status, 404);
  });

  // --- 3. INCIDENT LIFECYCLE & ISOLATION ---

  let aliceIncidentId;
  let bobIncidentId;

  await t.test('9. Incidents are strictly isolated between Alice and Bob', async () => {
    // Create an incident for Alice's endpoint
    const aliceIncident = await Incident.create({
      userId: alice._id,
      endpoint: aliceEndpointId,
      status: 'open',
      failureType: 'SCHEMA_VIOLATION',
      title: 'Schema violation on Alice endpoint',
      description: 'Field price invalid',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      occurrenceCount: 1
    });
    aliceIncidentId = aliceIncident._id.toString();

    // Create an incident for Bob's endpoint
    const bobIncident = await Incident.create({
      userId: bob._id,
      endpoint: bobEndpointId,
      status: 'open',
      failureType: 'HTTP_ERROR',
      title: 'HTTP error on Bob endpoint',
      description: '500 Internal Server Error',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      occurrenceCount: 1
    });
    bobIncidentId = bobIncident._id.toString();

    // Alice lists incidents: sees only her incident
    const resAliceList = await fetch(`${baseUrl}/api/incidents`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    assert.equal(resAliceList.status, 200);
    const dataAliceList = await resAliceList.json();
    assert.equal(dataAliceList.data.length, 1);
    assert.equal(dataAliceList.data[0]._id, aliceIncidentId);

    // Bob lists incidents: sees only his incident
    const resBobList = await fetch(`${baseUrl}/api/incidents`, {
      headers: { Authorization: `Bearer ${bobToken}` }
    });
    assert.equal(resBobList.status, 200);
    const dataBobList = await resBobList.json();
    assert.equal(dataBobList.data.length, 1);
    assert.equal(dataBobList.data[0]._id, bobIncidentId);

    // IDOR check: Alice tries to get Bob's incident -> returns 404
    const resCross = await fetch(`${baseUrl}/api/incidents/${bobIncidentId}`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    assert.equal(resCross.status, 404);
  });

  await t.test('10. Auto-resolving Alice incidents does not touch Bob open incidents', async () => {
    // Resolve Alice's incidents
    const resolveResult = await resolveEndpointIncidents({
      endpointId: aliceEndpointId,
      userId: alice._id
    });
    assert.equal(resolveResult.resolvedCount, 1);

    // Verify Alice incident is now resolved
    const aliceInDb = await Incident.findById(aliceIncidentId);
    assert.equal(aliceInDb.status, 'resolved');

    // Verify Bob's incident is STILL OPEN
    const bobInDb = await Incident.findById(bobIncidentId);
    assert.equal(bobInDb.status, 'open', 'Bob incident must remain open after Alice resolution');
  });

  // --- 4. SCHEDULER MULTI-USER ISOLATION ---

  await t.test('11. Scheduler monitors endpoints with valid ownership and sets userId on CheckRuns', async () => {
    // Clear check runs and incidents for clean scheduler test
    await CheckRun.deleteMany({});
    await Incident.deleteMany({});

    // Attach active contract for Alice
    await Contract.create({
      userId: alice._id,
      endpoint: aliceEndpointId,
      name: 'Alice Contract v1',
      schema: productSchema,
      version: 1,
      isActive: true
    });

    // Run scheduled checks
    const summary = await runScheduledChecks({ overrideBaseUrl: `${baseUrl}/mock-api/products` });
    assert.ok(summary.totalEndpoints >= 1);

    // Verify saved CheckRun has Alice's userId
    const savedRun = await CheckRun.findOne({ endpoint: aliceEndpointId });
    assert.ok(savedRun);
    assert.equal(savedRun.userId.toString(), alice._id.toString());
  });

  await t.test('12. Legacy unowned endpoints are skipped by scheduler and hidden from users', async () => {
    // Create a legacy endpoint with userId: null
    const legacyEndpoint = await Endpoint.create({
      userId: null,
      name: 'Unresolved Legacy Endpoint',
      url: `${baseUrl}/mock-api/products/101`,
      method: 'GET',
      isActive: true
    });

    // Neither Alice nor Bob can see this legacy endpoint in their list
    const resAlice = await fetch(`${baseUrl}/api/endpoints`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    const dataAlice = await resAlice.json();
    assert.ok(!dataAlice.data.some(e => e._id === legacyEndpoint._id.toString()));

    const resBob = await fetch(`${baseUrl}/api/endpoints`, {
      headers: { Authorization: `Bearer ${bobToken}` }
    });
    const dataBob = await resBob.json();
    assert.ok(!dataBob.data.some(e => e._id === legacyEndpoint._id.toString()));

    // Scheduler does not include unowned endpoints in monitoring pass
    const summary = await runScheduledChecks({ overrideBaseUrl: `${baseUrl}/mock-api/products` });
    const hasLegacyInResults = summary.results.some(r => r.endpointId.toString() === legacyEndpoint._id.toString());
    assert.equal(hasLegacyInResults, false, 'Legacy unowned endpoint must be excluded from scheduled checks');
  });

  // --- 5. LEGACY MIGRATION SCRIPT ---

  await t.test('13. Migration script audits and assigns legacy ownership safely', async () => {
    // Audit detects unresolved legacy records
    const audit = await auditUnresolvedLegacyRecords();
    assert.ok(audit.endpoints.count >= 1, 'Audit should detect unresolved legacy endpoints');
    assert.ok(audit.totalUnresolved >= 1);

    // Assign legacy records to Bob
    const migrationResult = await assignLegacyOwnership({
      targetUserIdentifier: 'bob@example.com'
    });
    assert.ok(migrationResult.migrated.endpoints >= 1);

    // Now Bob can see the migrated endpoint in his list
    const resBob = await fetch(`${baseUrl}/api/endpoints`, {
      headers: { Authorization: `Bearer ${bobToken}` }
    });
    const dataBob = await resBob.json();
    const migratedFound = dataBob.data.some(e => e.name === 'Unresolved Legacy Endpoint');
    assert.equal(migratedFound, true, 'Bob must now see the migrated legacy endpoint');

    // Alice still CANNOT see it
    const resAlice = await fetch(`${baseUrl}/api/endpoints`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    const dataAlice = await resAlice.json();
    const aliceFound = dataAlice.data.some(e => e.name === 'Unresolved Legacy Endpoint');
    assert.equal(aliceFound, false, 'Alice must not see Bob newly migrated endpoint');
  });
});
