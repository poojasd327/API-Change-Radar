const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Incident = require('../src/models/Incident');
const Endpoint = require('../src/models/Endpoint');
const Contract = require('../src/models/Contract');
const { productSchema } = require('../src/contracts/product.schema');

test('Milestone 6, Step 1: Incident Model Suite', async (t) => {
  let mongod;

  // Spin up an isolated in-memory MongoDB instance for model testing
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  t.after(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongod) {
      await mongod.stop();
    }
  });

  await t.test('1. Validates required fields (endpoint, failureType, title)', async () => {
    const emptyIncident = new Incident({});

    await assert.rejects(
      async () => await emptyIncident.validate(),
      (err) => {
        assert.ok(err.errors.endpoint, 'endpoint should be required');
        assert.ok(err.errors.failureType, 'failureType should be required');
        assert.ok(err.errors.title, 'title should be required');
        return true;
      }
    );
  });

  await t.test('2. Applies default values correctly', async () => {
    const dummyEndpointId = new mongoose.Types.ObjectId();
    const incident = new Incident({
      endpoint: dummyEndpointId,
      failureType: 'SCHEMA_VIOLATION',
      title: 'Price schema mismatch'
    });

    await incident.validate();

    assert.equal(incident.status, 'open', 'status should default to "open"');
    assert.equal(incident.contract, null, 'contract should default to null');
    assert.equal(incident.description, null, 'description should default to null');
    assert.equal(incident.resolvedAt, null, 'resolvedAt should default to null');
    assert.equal(incident.occurrenceCount, 1, 'occurrenceCount should default to 1');
    assert.ok(incident.firstSeenAt instanceof Date, 'firstSeenAt should default to Date');
    assert.ok(incident.lastSeenAt instanceof Date, 'lastSeenAt should default to Date');
  });

  await t.test('3. Enforces status enum ("open", "resolved")', async () => {
    const dummyEndpointId = new mongoose.Types.ObjectId();

    // Valid statuses
    const openIncident = new Incident({
      endpoint: dummyEndpointId,
      failureType: 'HTTP_ERROR',
      title: 'Endpoint returned 500',
      status: 'open'
    });
    await openIncident.validate();

    const resolvedIncident = new Incident({
      endpoint: dummyEndpointId,
      failureType: 'HTTP_ERROR',
      title: 'Endpoint returned 500',
      status: 'resolved'
    });
    await resolvedIncident.validate();

    // Invalid status should be rejected
    const invalidStatusIncident = new Incident({
      endpoint: dummyEndpointId,
      failureType: 'HTTP_ERROR',
      title: 'Endpoint returned 500',
      status: 'closed' // not in enum
    });

    await assert.rejects(
      async () => await invalidStatusIncident.validate(),
      (err) => {
        assert.ok(err.errors.status);
        assert.match(err.errors.status.message, /not a valid incident status/);
        return true;
      }
    );
  });

  await t.test('4. Enforces minimum occurrenceCount of 1', async () => {
    const dummyEndpointId = new mongoose.Types.ObjectId();

    const zeroCount = new Incident({
      endpoint: dummyEndpointId,
      failureType: 'TIMEOUT',
      title: 'Request timed out',
      occurrenceCount: 0
    });

    await assert.rejects(
      async () => await zeroCount.validate(),
      (err) => {
        assert.ok(err.errors.occurrenceCount);
        assert.match(err.errors.occurrenceCount.message, /at least 1/);
        return true;
      }
    );

    const negativeCount = new Incident({
      endpoint: dummyEndpointId,
      failureType: 'TIMEOUT',
      title: 'Request timed out',
      occurrenceCount: -5
    });

    await assert.rejects(
      async () => await negativeCount.validate(),
      (err) => {
        assert.ok(err.errors.occurrenceCount);
        return true;
      }
    );
  });

  await t.test('5. Successfully saves, queries open incidents, and resolves in MongoDB', async () => {
    const endpoint = await Endpoint.create({
      name: 'Incident Test Endpoint',
      url: 'http://127.0.0.1:5001/mock-api/products/101'
    });

    const contract = await Contract.create({
      endpoint: endpoint._id,
      name: 'Incident Test Contract',
      schema: productSchema
    });

    // Create and save an incident
    const incident = await Incident.create({
      endpoint: endpoint._id,
      contract: contract._id,
      failureType: 'SCHEMA_VIOLATION',
      title: 'Missing field: price',
      description: 'Field price was missing from API response'
    });

    assert.ok(incident._id);
    assert.equal(incident.status, 'open');
    assert.equal(incident.occurrenceCount, 1);

    // Query open incident by endpoint and failureType (matching compound index)
    const found = await Incident.findOne({
      endpoint: endpoint._id,
      failureType: 'SCHEMA_VIOLATION',
      status: 'open'
    });
    assert.ok(found);
    assert.equal(found._id.toString(), incident._id.toString());

    // Simulate incident update on repeated failure
    found.occurrenceCount += 1;
    found.lastSeenAt = new Date();
    await found.save();

    const updated = await Incident.findById(incident._id);
    assert.equal(updated.occurrenceCount, 2);

    // Simulate resolution
    updated.status = 'resolved';
    updated.resolvedAt = new Date();
    await updated.save();

    const resolved = await Incident.findById(incident._id);
    assert.equal(resolved.status, 'resolved');
    assert.ok(resolved.resolvedAt);

    // Verify open query now returns null for this failure type
    const stillOpen = await Incident.findOne({
      endpoint: endpoint._id,
      failureType: 'SCHEMA_VIOLATION',
      status: 'open'
    });
    assert.equal(stillOpen, null);
  });
});
