const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../src/app');
const Endpoint = require('../src/models/Endpoint');
const Contract = require('../src/models/Contract');
const Incident = require('../src/models/Incident');
const CheckRun = require('../src/models/CheckRun');
const { productSchema } = require('../src/contracts/product.schema');
const {
  recordIncidentFailure,
  resolveEndpointIncidents,
  formatIncidentTitle
} = require('../src/services/incident.service');
const { runScheduledChecks, stopScheduler } = require('../src/services/scheduler.service');

test('Milestone 6, Step 2: Incident Service & Scheduler Integration Suite', async (t) => {
  let mongod;
  let server;
  let baseUrl;

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

  t.beforeEach(async () => {
    await Incident.deleteMany({});
    await CheckRun.deleteMany({});
    await Endpoint.deleteMany({});
    await Contract.deleteMany({});
  });

  // --- 1. TITLE FORMATTING TESTS ---

  await t.test('1. formatIncidentTitle generates clear titles for all failure types', () => {
    assert.equal(
      formatIncidentTitle('SCHEMA_VIOLATION', 'Product API'),
      'Schema contract violation on Product API'
    );
    assert.equal(
      formatIncidentTitle('HTTP_ERROR', 'Product API', 500),
      'HTTP error (500) on Product API'
    );
    assert.equal(
      formatIncidentTitle('TIMEOUT', 'Product API'),
      'Request timed out on Product API'
    );
    assert.equal(
      formatIncidentTitle('NETWORK_ERROR', 'Product API'),
      'Network connection failure on Product API'
    );
    assert.equal(
      formatIncidentTitle('INVALID_JSON', 'Product API'),
      'Invalid JSON response received from Product API'
    );
  });

  // --- 2. FIRST FAILURE: INCIDENT CREATION ---

  await t.test('2. First failure creates a new OPEN incident with count 1', async () => {
    const endpoint = await Endpoint.create({
      name: 'Catalog API',
      url: `${baseUrl}/mock-api/products/101`,
      method: 'GET'
    });

    const contract = await Contract.create({
      endpoint: endpoint._id,
      name: 'Catalog Schema',
      schema: productSchema
    });

    const checkResult = {
      status: 'failed',
      failureType: 'SCHEMA_VIOLATION',
      httpStatus: 200,
      errors: ['Field price must be of type number']
    };

    const incident = await recordIncidentFailure({ endpoint, contract, checkResult });

    assert.ok(incident._id);
    assert.equal(incident.status, 'open');
    assert.equal(incident.occurrenceCount, 1);
    assert.equal(incident.failureType, 'SCHEMA_VIOLATION');
    assert.equal(incident.title, 'Schema contract violation on Catalog API');
    assert.equal(incident.description, 'Field price must be of type number');
    assert.equal(incident.endpoint.toString(), endpoint._id.toString());
    assert.equal(incident.contract.toString(), contract._id.toString());
    assert.equal(incident.resolvedAt, null);

    const totalIncidents = await Incident.countDocuments();
    assert.equal(totalIncidents, 1);
  });

  // --- 3. REPEATED FAILURE: INCREMENTS OCCURRENCE COUNT ---

  await t.test('3. Repeated failures update the existing incident and increment occurrenceCount', async () => {
    const endpoint = await Endpoint.create({
      name: 'Inventory API',
      url: `${baseUrl}/mock-api/products/101`,
      method: 'GET'
    });

    const checkResult1 = {
      status: 'failed',
      failureType: 'HTTP_ERROR',
      httpStatus: 500,
      errors: ['HTTP failure: server returned status code 500']
    };

    const firstRun = await recordIncidentFailure({ endpoint, checkResult: checkResult1 });
    assert.equal(firstRun.occurrenceCount, 1);

    // Second failure: same endpoint, same failure type
    const checkResult2 = {
      status: 'failed',
      failureType: 'HTTP_ERROR',
      httpStatus: 500,
      errors: ['HTTP failure: 500 Internal Server Error retry failed']
    };

    const secondRun = await recordIncidentFailure({ endpoint, checkResult: checkResult2 });
    assert.equal(secondRun._id.toString(), firstRun._id.toString());
    assert.equal(secondRun.occurrenceCount, 2);
    assert.equal(secondRun.description, 'HTTP failure: 500 Internal Server Error retry failed');
    assert.ok(new Date(secondRun.lastSeenAt) >= new Date(firstRun.firstSeenAt));

    // Must still only have 1 incident in database (no duplicate!)
    const totalIncidents = await Incident.countDocuments();
    assert.equal(totalIncidents, 1);
  });

  // --- 4. MULTIPLE FAILURE TYPES ON SAME ENDPOINT ---

  await t.test('4. Distinct failure types on the same endpoint create separate open incidents', async () => {
    const endpoint = await Endpoint.create({
      name: 'Payment API',
      url: `${baseUrl}/mock-api/products/101`,
      method: 'GET'
    });

    // 1st error: SCHEMA_VIOLATION
    await recordIncidentFailure({
      endpoint,
      checkResult: { failureType: 'SCHEMA_VIOLATION', errors: ['Missing field id'] }
    });

    // 2nd error: TIMEOUT
    await recordIncidentFailure({
      endpoint,
      checkResult: { failureType: 'TIMEOUT', errors: ['Request timed out after 3000ms'] }
    });

    const openIncidents = await Incident.find({ endpoint: endpoint._id, status: 'open' });
    assert.equal(openIncidents.length, 2);
    assert.ok(openIncidents.some(inc => inc.failureType === 'SCHEMA_VIOLATION'));
    assert.ok(openIncidents.some(inc => inc.failureType === 'TIMEOUT'));
  });

  // --- 5. HEALTHY CHECK AUTO-RESOLVES OPEN INCIDENTS ---

  await t.test('5. Healthy check auto-resolves open incidents for the endpoint', async () => {
    const endpoint = await Endpoint.create({
      name: 'Orders API',
      url: `${baseUrl}/mock-api/products/101`,
      method: 'GET'
    });

    // Create an open incident
    const openIncident = await recordIncidentFailure({
      endpoint,
      checkResult: { failureType: 'HTTP_ERROR', httpStatus: 502, errors: ['Bad Gateway'] }
    });
    assert.equal(openIncident.status, 'open');

    // Auto-resolve when endpoint recovers
    const resolution = await resolveEndpointIncidents({ endpointId: endpoint._id });
    assert.equal(resolution.resolvedCount, 1);
    assert.ok(resolution.resolvedAt);

    const updated = await Incident.findById(openIncident._id);
    assert.equal(updated.status, 'resolved');
    assert.ok(updated.resolvedAt);

    // Running resolve again does not modify already resolved incidents
    const secondResolution = await resolveEndpointIncidents({ endpointId: endpoint._id });
    assert.equal(secondResolution.resolvedCount, 0);
  });

  // --- 6. FAILURE AFTER RECOVERY CREATES A NEW INCIDENT ---

  await t.test('6. Failure after recovery creates a NEW incident without overwriting historical record', async () => {
    const endpoint = await Endpoint.create({
      name: 'Users API',
      url: `${baseUrl}/mock-api/products/101`,
      method: 'GET'
    });

    // 1. Initial failure
    const initialIncident = await recordIncidentFailure({
      endpoint,
      checkResult: { failureType: 'SCHEMA_VIOLATION', errors: ['Initial price error'] }
    });

    // 2. Endpoint recovers
    await resolveEndpointIncidents({ endpointId: endpoint._id });

    const historical = await Incident.findById(initialIncident._id);
    assert.equal(historical.status, 'resolved');

    // 3. Endpoint breaks again later with same failure type
    const newIncident = await recordIncidentFailure({
      endpoint,
      checkResult: { failureType: 'SCHEMA_VIOLATION', errors: ['New price error'] }
    });

    // A brand new incident document should be created
    assert.notEqual(newIncident._id.toString(), historical._id.toString());
    assert.equal(newIncident.status, 'open');
    assert.equal(newIncident.occurrenceCount, 1);

    // Both the historical resolved incident and new open incident exist in DB
    const totalCount = await Incident.countDocuments({ endpoint: endpoint._id });
    assert.equal(totalCount, 2);

    const resolvedCount = await Incident.countDocuments({ endpoint: endpoint._id, status: 'resolved' });
    const openCount = await Incident.countDocuments({ endpoint: endpoint._id, status: 'open' });
    assert.equal(resolvedCount, 1);
    assert.equal(openCount, 1);
  });

  // --- 7. SCHEDULER INTEGRATION TEST ---

  await t.test('7. Scheduler automatically records incidents on failure and resolves on success', async () => {
    // Set up an endpoint that fails (wrong-price-type)
    const endpoint = await Endpoint.create({
      name: 'Scheduler Monitored Endpoint',
      url: `${baseUrl}/mock-api/products/101?scenario=wrong-price-type`,
      method: 'GET',
      isActive: true
    });

    await Contract.create({
      endpoint: endpoint._id,
      name: 'Approved Product Schema',
      schema: productSchema,
      isActive: true
    });

    // 1. First scheduled run (fails)
    await runScheduledChecks({ overrideBaseUrl: baseUrl });

    let incident = await Incident.findOne({ endpoint: endpoint._id, status: 'open' });
    assert.ok(incident);
    assert.equal(incident.occurrenceCount, 1);
    assert.equal(incident.failureType, 'SCHEMA_VIOLATION');

    // 2. Second scheduled run (fails again)
    await runScheduledChecks({ overrideBaseUrl: baseUrl });

    incident = await Incident.findOne({ endpoint: endpoint._id, status: 'open' });
    assert.equal(incident.occurrenceCount, 2);

    // 3. Fix the endpoint (points to healthy URL)
    endpoint.url = `${baseUrl}/mock-api/products/101`;
    await endpoint.save();

    // 4. Third scheduled run (succeeds -> auto-resolves incident)
    await runScheduledChecks({ overrideBaseUrl: baseUrl });

    const openAfterHealthy = await Incident.findOne({ endpoint: endpoint._id, status: 'open' });
    assert.equal(openAfterHealthy, null);

    const resolvedIncident = await Incident.findOne({ endpoint: endpoint._id, status: 'resolved' });
    assert.ok(resolvedIncident);
    assert.equal(resolvedIncident.occurrenceCount, 2);
    assert.ok(resolvedIncident.resolvedAt);
  });
});
