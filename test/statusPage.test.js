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
const { StatusPage } = require('../src/models/StatusPage');
const { generateToken } = require('../src/services/auth.service');

test('Stage 3: Public Status API and Safe Publishing Suite', async (t) => {
  let mongod;
  let server;
  let baseUrl;

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-12345';
  process.env.JWT_EXPIRES_IN = '1h';

  // Seed two distinct users: Alice and Bob
  const alice = await User.create({
    name: 'Alice Status Admin',
    email: 'alice.status@example.com',
    password: 'securePassword123'
  });
  const aliceToken = generateToken(alice);

  const bob = await User.create({
    name: 'Bob Status Admin',
    email: 'bob.status@example.com',
    password: 'securePassword123'
  });
  const bobToken = generateToken(bob);

  const makeAuthFetch = (token) => (url, opts = {}) => {
    const headers = { ...opts?.headers };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetch(url, { ...opts, headers });
  };

  const aliceFetch = makeAuthFetch(aliceToken);
  const bobFetch = makeAuthFetch(bobToken);

  t.after(async () => {
    if (server) server.close();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongod) await mongod.stop();
  });

  const publicStatusRouter = require('../src/routes/publicStatus.routes');

  t.beforeEach(async () => {
    if (publicStatusRouter.rateLimiter?.reset) {
      publicStatusRouter.rateLimiter.reset();
    }
    await StatusPage.deleteMany({});
    await CheckRun.deleteMany({});
    await Incident.deleteMany({});
    await Contract.deleteMany({});
    await Endpoint.deleteMany({});
  });

  // =========================================================================
  // 1. Management Authentication & Creation
  // =========================================================================

  await t.test('1. Unauthenticated requests to /api/status-page routes are rejected with 401', async () => {
    const resPost = await fetch(`${baseUrl}/api/status-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My Status' })
    });
    assert.equal(resPost.status, 401);

    const resGet = await fetch(`${baseUrl}/api/status-page/me`);
    assert.equal(resGet.status, 401);

    const resPatch = await fetch(`${baseUrl}/api/status-page/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' })
    });
    assert.equal(resPatch.status, 401);

    const resPut = await fetch(`${baseUrl}/api/status-page/me/services`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpointIds: [] })
    });
    assert.equal(resPut.status, 401);

    const resRegen = await fetch(`${baseUrl}/api/status-page/me/regenerate-slug`, {
      method: 'POST'
    });
    assert.equal(resRegen.status, 401);
  });

  await t.test('2. User can create an initial unpublished status page; duplicate returns 409', async () => {
    const res = await aliceFetch(`${baseUrl}/api/status-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Alice Systems Status',
        description: 'Official status of Alice APIs',
        userId: bob._id.toString() // Spoofed userId attempt
      })
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.title, 'Alice Systems Status');
    assert.equal(body.description, 'Official status of Alice APIs');
    assert.equal(body.isPublished, false, 'Status page must be unpublished by default');
    assert.equal(body.userId, alice._id.toString(), 'userId must come from authenticated token, not body');
    assert.ok(body.slug, 'Slug must be generated');
    assert.equal(typeof body.slug, 'string');
    assert.ok(body.slug.length >= 16);

    // Duplicate creation returns 409 Conflict
    const resDup = await aliceFetch(`${baseUrl}/api/status-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Duplicate Attempt' })
    });
    assert.equal(resDup.status, 409);
    const dupBody = await resDup.json();
    assert.equal(dupBody.error, 'Conflict');
  });

  await t.test('3. GET /api/status-page/me returns user configuration with no-store cache headers', async () => {
    // Before creating, returns 404
    const res404 = await aliceFetch(`${baseUrl}/api/status-page/me`);
    assert.equal(res404.status, 404);

    // Create Alice status page
    await aliceFetch(`${baseUrl}/api/status-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Alice Services' })
    });

    const res = await aliceFetch(`${baseUrl}/api/status-page/me`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /no-store/);

    const body = await res.json();
    assert.equal(body.title, 'Alice Services');
    assert.equal(body.userId, alice._id.toString());
    assert.equal(body.isPublished, false);

    // Bob still gets 404 since Bob has not created a status page
    const bobRes = await bobFetch(`${baseUrl}/api/status-page/me`);
    assert.equal(bobRes.status, 404);
  });

  await t.test('4. PATCH /api/status-page/me updates approved fields and rejects protected fields', async () => {
    await aliceFetch(`${baseUrl}/api/status-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Initial Title' })
    });

    // 1. Attempting to modify protected fields returns 400
    const resProtected = await aliceFetch(`${baseUrl}/api/status-page/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: bob._id.toString(),
        slug: 'hacked-slug'
      })
    });
    assert.equal(resProtected.status, 400);
    const protBody = await resProtected.json();
    assert.equal(protBody.error, 'BadRequest');
    assert.match(protBody.message, /Modifying protected or unapproved field/);

    // 2. Empty body returns 400
    const resEmpty = await aliceFetch(`${baseUrl}/api/status-page/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(resEmpty.status, 400);

    // 3. Updating approved fields succeeds
    const resValid = await aliceFetch(`${baseUrl}/api/status-page/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Updated Alice Status',
        description: 'New description',
        isPublished: true
      })
    });
    assert.equal(resValid.status, 200);
    const bodyValid = await resValid.json();
    assert.equal(bodyValid.title, 'Updated Alice Status');
    assert.equal(bodyValid.description, 'New description');
    assert.equal(bodyValid.isPublished, true);
  });

  // =========================================================================
  // 2. Service Selection & Ownership Integrity
  // =========================================================================

  await t.test('5. PUT /api/status-page/me/services allows selecting own endpoints and rejects foreign or inactive endpoints', async () => {
    await aliceFetch(`${baseUrl}/api/status-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Alice Services' })
    });

    const aliceEndpoint1 = await Endpoint.create({
      userId: alice._id,
      name: 'Alice Payment API',
      url: 'https://api.alice.com/payments',
      isActive: true
    });

    const aliceEndpoint2 = await Endpoint.create({
      userId: alice._id,
      name: 'Alice Inventory API',
      url: 'https://api.alice.com/inventory',
      isActive: true
    });

    const aliceInactive = await Endpoint.create({
      userId: alice._id,
      name: 'Alice Deprecated API',
      url: 'https://api.alice.com/old',
      isActive: false
    });

    const bobEndpoint = await Endpoint.create({
      userId: bob._id,
      name: 'Bob Secret API',
      url: 'https://api.bob.com/secret',
      isActive: true
    });

    // 1. Attempting to select Bob's endpoint is rejected with 400
    const resForeign = await aliceFetch(`${baseUrl}/api/status-page/me/services`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpointIds: [aliceEndpoint1._id.toString(), bobEndpoint._id.toString()]
      })
    });
    assert.equal(resForeign.status, 400);
    const foreignBody = await resForeign.json();
    assert.match(foreignBody.message, /invalid or not owned by you/i);

    // 2. Attempting to select inactive endpoint is rejected with 400
    const resInactive = await aliceFetch(`${baseUrl}/api/status-page/me/services`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpointIds: [aliceEndpoint1._id.toString(), aliceInactive._id.toString()]
      })
    });
    assert.equal(resInactive.status, 400);
    const inactBody = await resInactive.json();
    assert.match(inactBody.message, /Inactive endpoints cannot be selected/i);

    // 3. Attempting duplicate endpoint IDs is rejected with 400
    const resDup = await aliceFetch(`${baseUrl}/api/status-page/me/services`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpointIds: [aliceEndpoint1._id.toString(), aliceEndpoint1._id.toString()]
      })
    });
    assert.equal(resDup.status, 400);
    const dupBody = await resDup.json();
    assert.match(dupBody.message, /Duplicate endpoint IDs/i);

    // 4. Invalid ObjectId format is rejected with 400
    const resMalformed = await aliceFetch(`${baseUrl}/api/status-page/me/services`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpointIds: ['invalid-id-123']
      })
    });
    assert.equal(resMalformed.status, 400);

    // 5. Selecting own valid active endpoints succeeds
    const resValid = await aliceFetch(`${baseUrl}/api/status-page/me/services`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpointIds: [aliceEndpoint1._id.toString(), aliceEndpoint2._id.toString()]
      })
    });
    assert.equal(resValid.status, 200);
    const bodyValid = await resValid.json();
    assert.equal(bodyValid.selectedEndpoints.length, 2);
    assert.equal(bodyValid.selectedEndpoints[0], aliceEndpoint1._id.toString());
    assert.equal(bodyValid.selectedEndpoints[1], aliceEndpoint2._id.toString());
  });

  await t.test('6. POST /api/status-page/me/regenerate-slug creates a new unguessable slug and invalidates the old one', async () => {
    const createRes = await aliceFetch(`${baseUrl}/api/status-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Alice Slug Test' })
    });
    const { slug: originalSlug } = await createRes.json();

    // Publish page
    await aliceFetch(`${baseUrl}/api/status-page/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: true })
    });

    // Old slug is currently reachable
    const resOldBefore = await fetch(`${baseUrl}/api/public/status/${originalSlug}`);
    assert.equal(resOldBefore.status, 200);

    // Regenerate slug
    const resRegen = await aliceFetch(`${baseUrl}/api/status-page/me/regenerate-slug`, {
      method: 'POST'
    });
    assert.equal(resRegen.status, 200);
    const regenBody = await resRegen.json();
    assert.notEqual(regenBody.slug, originalSlug);
    assert.match(regenBody.message, /no longer work/i);

    // Old slug is immediately 404
    const resOldAfter = await fetch(`${baseUrl}/api/public/status/${originalSlug}`);
    assert.equal(resOldAfter.status, 404);

    // New slug is reachable
    const resNew = await fetch(`${baseUrl}/api/public/status/${regenBody.slug}`);
    assert.equal(resNew.status, 200);
  });

  // =========================================================================
  // 3. Public Status Read & Strict Privacy Sanitization
  // =========================================================================

  await t.test('7. Unpublished or disabled status page returns 404 on public route', async () => {
    const createRes = await aliceFetch(`${baseUrl}/api/status-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Alice Unpublished' })
    });
    const { slug } = await createRes.json();

    // Default unpublished page returns 404
    const resUnpublished = await fetch(`${baseUrl}/api/public/status/${slug}`);
    assert.equal(resUnpublished.status, 404);
    const bodyUnpub = await resUnpublished.json();
    assert.equal(bodyUnpub.error, 'NotFound');

    // Unknown slug returns 404
    const resUnknown = await fetch(`${baseUrl}/api/public/status/does-not-exist-slug-12345`);
    assert.equal(resUnknown.status, 404);

    // Enable publishing => returns 200
    await aliceFetch(`${baseUrl}/api/status-page/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: true })
    });

    const resPublished = await fetch(`${baseUrl}/api/public/status/${slug}`);
    assert.equal(resPublished.status, 200);

    // Disable publishing => immediately returns 404 again
    await aliceFetch(`${baseUrl}/api/status-page/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: false })
    });

    const resDisabled = await fetch(`${baseUrl}/api/public/status/${slug}`);
    assert.equal(resDisabled.status, 404);
  });

  await t.test('8. Public endpoint sanitizes private data: no URLs, headers, schemas, userIds, or error details', async () => {
    // 1. Create Alice endpoints
    const epPublished = await Endpoint.create({
      userId: alice._id,
      name: 'Public Orders Service',
      url: 'https://internal-api.corp.alice.com:8443/v2/orders?apiKey=secret-key-123',
      isActive: true
    });

    const epUnpublished = await Endpoint.create({
      userId: alice._id,
      name: 'Internal Secret Payroll API',
      url: 'https://payroll.corp.alice.com/admin',
      isActive: true
    });

    const contract = await Contract.create({
      userId: alice._id,
      endpoint: epPublished._id,
      name: 'Sensitive Schema Contract',
      schema: { type: 'object', properties: { orderId: { type: 'string' } } },
      version: 1
    });

    // 2. Create CheckRun for epPublished
    await CheckRun.create({
      userId: alice._id,
      endpoint: epPublished._id,
      contract: contract._id,
      status: 'healthy',
      httpStatus: 200,
      responseTimeMs: 35,
      checkedAt: new Date()
    });

    // 3. Create StatusPage publishing only epPublished
    const createRes = await aliceFetch(`${baseUrl}/api/status-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Acme Public Status', description: 'Public uptime' })
    });
    const { slug } = await createRes.json();

    await aliceFetch(`${baseUrl}/api/status-page/me/services`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpointIds: [epPublished._id.toString()] })
    });

    await aliceFetch(`${baseUrl}/api/status-page/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: true })
    });

    // 4. Fetch public status page
    const res = await fetch(`${baseUrl}/api/public/status/${slug}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /public/);

    const body = await res.json();
    assert.equal(body.title, 'Acme Public Status');
    assert.equal(body.description, 'Public uptime');
    assert.equal(body.systemStatus, 'operational');
    assert.equal(body.services.length, 1);

    const service = body.services[0];
    assert.equal(service.name, 'Public Orders Service');
    assert.equal(service.status, 'operational');
    assert.equal(service.uptimePercentage24h, 100);
    assert.ok(service.lastCheckedAt);
    assert.ok(Array.isArray(service.recentChecks));

    // Stringify entire response and verify NO private data leaks
    const jsonStr = JSON.stringify(body);

    // Private URLs and hosts
    assert.ok(!jsonStr.includes('internal-api.corp.alice.com'), 'Internal hostname leaked');
    assert.ok(!jsonStr.includes('secret-key-123'), 'URL API key leaked');
    assert.ok(!jsonStr.includes('payroll.corp.alice.com'), 'Unpublished service URL leaked');
    assert.ok(!jsonStr.includes('Internal Secret Payroll API'), 'Unpublished service name leaked');

    // User identity & ObjectIds
    assert.ok(!jsonStr.includes(alice._id.toString()), 'Alice userId leaked');
    assert.ok(!jsonStr.includes('alice.status@example.com'), 'Alice email leaked');
    assert.ok(!jsonStr.includes(epPublished._id.toString()), 'Endpoint MongoDB _id leaked');
    assert.ok(!jsonStr.includes(contract._id.toString()), 'Contract _id leaked');

    // Contract schemas
    assert.ok(!jsonStr.includes('Sensitive Schema Contract'), 'Contract name leaked');
    assert.ok(!jsonStr.includes('orderId'), 'Contract schema property leaked');
  });

  // =========================================================================
  // 4. Public Status Calculation Rules & Multi-User Independence
  // =========================================================================

  await t.test('9. Missing or stale checks (>15 mins old) evaluate to unknown status', async () => {
    const epStale = await Endpoint.create({
      userId: alice._id,
      name: 'Stale Endpoint',
      url: 'https://api.alice.com/stale',
      isActive: true
    });

    const epNoChecks = await Endpoint.create({
      userId: alice._id,
      name: 'No Checks Endpoint',
      url: 'https://api.alice.com/new',
      isActive: true
    });

    const contract = await Contract.create({
      userId: alice._id,
      endpoint: epStale._id,
      name: 'Contract',
      schema: { type: 'object' }
    });

    // Check from 30 minutes ago (> 15 minutes stale threshold)
    await CheckRun.create({
      userId: alice._id,
      endpoint: epStale._id,
      contract: contract._id,
      status: 'healthy',
      checkedAt: new Date(Date.now() - 30 * 60 * 1000)
    });

    const createRes = await aliceFetch(`${baseUrl}/api/status-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Staleness Test' })
    });
    const { slug } = await createRes.json();

    await aliceFetch(`${baseUrl}/api/status-page/me/services`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpointIds: [epStale._id.toString(), epNoChecks._id.toString()]
      })
    });

    await aliceFetch(`${baseUrl}/api/status-page/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: true })
    });

    const res = await fetch(`${baseUrl}/api/public/status/${slug}`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.services[0].name, 'Stale Endpoint');
    assert.equal(body.services[0].status, 'unknown', 'Stale check must evaluate to unknown');

    assert.equal(body.services[1].name, 'No Checks Endpoint');
    assert.equal(body.services[1].status, 'unknown', 'Endpoint without checks must evaluate to unknown');
    assert.equal(body.services[1].lastCheckedAt, null);

    assert.equal(body.systemStatus, 'unknown', 'All unknown services produce unknown systemStatus');
  });

  await t.test('10. Incidents and failures map correctly to degraded vs major_outage', async () => {
    const epOutage = await Endpoint.create({
      userId: alice._id,
      name: 'Down Service',
      url: 'https://api.alice.com/down',
      isActive: true
    });

    const epDegraded = await Endpoint.create({
      userId: alice._id,
      name: 'Violating Service',
      url: 'https://api.alice.com/violating',
      isActive: true
    });

    const contract1 = await Contract.create({
      userId: alice._id,
      endpoint: epOutage._id,
      name: 'Contract 1',
      schema: { type: 'object' }
    });

    const contract2 = await Contract.create({
      userId: alice._id,
      endpoint: epDegraded._id,
      name: 'Contract 2',
      schema: { type: 'object' }
    });

    // 1. Outage endpoint has recent NETWORK_ERROR failure & open incident
    await CheckRun.create({
      userId: alice._id,
      endpoint: epOutage._id,
      contract: contract1._id,
      status: 'failed',
      failureType: 'NETWORK_ERROR',
      checkedAt: new Date()
    });

    await Incident.create({
      userId: alice._id,
      endpoint: epOutage._id,
      contract: contract1._id,
      status: 'open',
      failureType: 'NETWORK_ERROR',
      title: 'Outage on Down Service'
    });

    // 2. Degraded endpoint has SCHEMA_VIOLATION & open incident
    await CheckRun.create({
      userId: alice._id,
      endpoint: epDegraded._id,
      contract: contract2._id,
      status: 'failed',
      failureType: 'SCHEMA_VIOLATION',
      checkedAt: new Date()
    });

    await Incident.create({
      userId: alice._id,
      endpoint: epDegraded._id,
      contract: contract2._id,
      status: 'open',
      failureType: 'SCHEMA_VIOLATION',
      title: 'Schema violation on Violating Service'
    });

    const createRes = await aliceFetch(`${baseUrl}/api/status-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Incident Mapping Test' })
    });
    const { slug } = await createRes.json();

    await aliceFetch(`${baseUrl}/api/status-page/me/services`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpointIds: [epOutage._id.toString(), epDegraded._id.toString()]
      })
    });

    await aliceFetch(`${baseUrl}/api/status-page/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: true })
    });

    const res = await fetch(`${baseUrl}/api/public/status/${slug}`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.services[0].name, 'Down Service');
    assert.equal(body.services[0].status, 'major_outage');

    assert.equal(body.services[1].name, 'Violating Service');
    assert.equal(body.services[1].status, 'degraded');

    // Aggregate system status reflects highest severity failure
    assert.equal(body.systemStatus, 'major_outage');
  });

  await t.test('11. Bob incidents or checks cannot affect Alice public status page', async () => {
    // Alice endpoint is healthy
    const aliceEp = await Endpoint.create({
      userId: alice._id,
      name: 'Alice Clean Service',
      url: 'https://api.alice.com/clean',
      isActive: true
    });

    const aliceContract = await Contract.create({
      userId: alice._id,
      endpoint: aliceEp._id,
      name: 'Alice Contract',
      schema: { type: 'object' }
    });

    await CheckRun.create({
      userId: alice._id,
      endpoint: aliceEp._id,
      contract: aliceContract._id,
      status: 'healthy',
      checkedAt: new Date()
    });

    // Bob has an active major outage incident on his own endpoint
    const bobEp = await Endpoint.create({
      userId: bob._id,
      name: 'Bob Broken Service',
      url: 'https://api.bob.com/broken',
      isActive: true
    });

    await Incident.create({
      userId: bob._id,
      endpoint: bobEp._id,
      status: 'open',
      failureType: 'NETWORK_ERROR',
      title: 'Bob Massive Outage'
    });

    const createRes = await aliceFetch(`${baseUrl}/api/status-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Alice Public Status' })
    });
    const { slug } = await createRes.json();

    await aliceFetch(`${baseUrl}/api/status-page/me/services`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpointIds: [aliceEp._id.toString()] })
    });

    await aliceFetch(`${baseUrl}/api/status-page/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: true })
    });

    const res = await fetch(`${baseUrl}/api/public/status/${slug}`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.systemStatus, 'operational');
    assert.equal(body.services.length, 1);
    assert.equal(body.services[0].name, 'Alice Clean Service');
    assert.equal(body.services[0].status, 'operational');
  });

  // =========================================================================
  // 5. Rate Limiting on Public Status Endpoint
  // =========================================================================

  await t.test('12. Exceeding rate limit on public status returns 429 Too Many Requests', async () => {
    // Create and publish page
    const createRes = await aliceFetch(`${baseUrl}/api/status-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Rate Limit Test' })
    });
    const { slug } = await createRes.json();

    await aliceFetch(`${baseUrl}/api/status-page/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: true })
    });

    // Make 60 requests (allowed)
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`${baseUrl}/api/public/status/${slug}`);
      assert.equal(res.status, 200);
    }

    // The 61st request exceeds max (60) and must return 429
    const resThrottled = await fetch(`${baseUrl}/api/public/status/${slug}`);
    assert.equal(resThrottled.status, 429);
    assert.ok(resThrottled.headers.get('retry-after'));

    const bodyThrottled = await resThrottled.json();
    assert.equal(bodyThrottled.error, 'TooManyRequests');
    assert.match(bodyThrottled.message, /Too many requests/i);
  });
});
