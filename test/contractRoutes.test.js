import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Endpoint from '../src/models/Endpoint.js';
import Contract from '../src/models/Contract.js';
import { generateToken } from '../src/services/auth.service.js';

test('Contract Management & Approval REST API Suite', async (t) => {
  let mongod;
  let server;
  let baseUrl;
  let alice;
  let bob;
  let aliceToken;
  let bobToken;
  let aliceEndpoint;

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-12345';
  process.env.JWT_EXPIRES_IN = '1h';

  alice = await User.create({
    name: 'Alice Developer',
    email: 'alice.contract@example.com',
    password: 'securePassword123',
  });
  aliceToken = generateToken(alice);

  bob = await User.create({
    name: 'Bob Competitor',
    email: 'bob.contract@example.com',
    password: 'securePassword123',
  });
  bobToken = generateToken(bob);

  aliceEndpoint = await Endpoint.create({
    userId: alice._id,
    name: 'Alice GitHub Status API',
    url: 'https://www.githubstatus.com/api/v2/status.json',
    method: 'GET',
    isActive: true,
  });

  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    if (server) server.close();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongod) await mongod.stop();
  });

  const authFetch = (url, token, opts = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      ...opts.headers,
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetch(url, { ...opts, headers });
  };

  await t.test('1. Unauthenticated requests to /api/contracts are rejected with 401', async () => {
    const res = await fetch(`${baseUrl}/api/contracts`);
    assert.equal(res.status, 401);
  });

  await t.test('2. POST /api/contracts/validate validates schema structure and sample data', async () => {
    const validSchema = {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string' },
      },
    };

    // Valid schema & matching sample data
    const res1 = await authFetch(`${baseUrl}/api/contracts/validate`, aliceToken, {
      method: 'POST',
      body: JSON.stringify({
        schema: validSchema,
        sampleData: { status: 'operational' },
      }),
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.valid, true);

    // Valid schema & non-matching sample data
    const res2 = await authFetch(`${baseUrl}/api/contracts/validate`, aliceToken, {
      method: 'POST',
      body: JSON.stringify({
        schema: validSchema,
        sampleData: { wrongField: 123 },
      }),
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.valid, false);
    assert.equal(body2.sampleValid, false);
    assert.ok(body2.sampleErrors.length > 0);

    // Invalid schema structure
    const res3 = await authFetch(`${baseUrl}/api/contracts/validate`, aliceToken, {
      method: 'POST',
      body: JSON.stringify({
        schema: { type: 'non_existent_type_error' },
      }),
    });
    assert.equal(res3.status, 400);
  });

  await t.test('3. POST /api/contracts/infer generates a draft JSON Schema from sample JSON', async () => {
    const sample = {
      page: { id: 'kctbh9vrtdwd', name: 'GitHub' },
      status: { indicator: 'none', description: 'All Systems Operational' },
    };

    const res = await authFetch(`${baseUrl}/api/contracts/infer`, aliceToken, {
      method: 'POST',
      body: JSON.stringify({ sampleData: sample, title: 'GitHub Status Contract' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.schema);
    assert.equal(body.schema.type, 'object');
    assert.ok(body.schema.properties.page);
    assert.ok(body.schema.properties.status);
    assert.deepEqual(body.schema.required, ['page', 'status']);
  });

  await t.test('4. Bob cannot create a contract for Alice endpoint (IDOR prevention)', async () => {
    const res = await authFetch(`${baseUrl}/api/contracts`, bobToken, {
      method: 'POST',
      body: JSON.stringify({
        endpointId: aliceEndpoint._id.toString(),
        name: 'Bob Malicious Contract',
        schema: { type: 'object' },
      }),
    });
    assert.equal(res.status, 404);
  });

  await t.test('5. Alice creates a contract in pending approval status (isApproved: false, isActive: false)', async () => {
    const schema = {
      type: 'object',
      required: ['page', 'status'],
      properties: {
        page: { type: 'object' },
        status: { type: 'object' },
      },
    };

    const res = await authFetch(`${baseUrl}/api/contracts`, aliceToken, {
      method: 'POST',
      body: JSON.stringify({
        endpointId: aliceEndpoint._id.toString(),
        name: 'GitHub Status Schema v1',
        schema,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.contract._id);
    assert.equal(body.contract.version, 1);
    assert.equal(body.contract.isApproved, false);
    assert.equal(body.contract.isActive, false);

    // Verify endpoint still has hasActiveContract: false because contract is pending
    const epRes = await authFetch(`${baseUrl}/api/endpoints/${aliceEndpoint._id}`, aliceToken);
    const epBody = await epRes.json();
    assert.equal(epBody.hasActiveContract, false);
  });

  await t.test('6. GET /api/contracts returns user-scoped contracts', async () => {
    const resAlice = await authFetch(`${baseUrl}/api/contracts`, aliceToken);
    assert.equal(resAlice.status, 200);
    const bodyAlice = await resAlice.json();
    assert.equal(bodyAlice.data.length, 1);
    assert.equal(bodyAlice.data[0].name, 'GitHub Status Schema v1');

    // Bob sees 0 contracts
    const resBob = await authFetch(`${baseUrl}/api/contracts`, bobToken);
    assert.equal(resBob.status, 200);
    const bodyBob = await resBob.json();
    assert.equal(bodyBob.data.length, 0);
  });

  await t.test('7. Explicit approval sets isApproved: true and activates contract for monitoring', async () => {
    const contracts = await Contract.find({ endpoint: aliceEndpoint._id, userId: alice._id });
    assert.equal(contracts.length, 1);
    const contractId = contracts[0]._id.toString();

    // Bob cannot approve Alice contract
    const bobApprove = await authFetch(`${baseUrl}/api/contracts/${contractId}/approve`, bobToken, {
      method: 'POST',
    });
    assert.equal(bobApprove.status, 404);

    // Alice approves her contract
    const aliceApprove = await authFetch(`${baseUrl}/api/contracts/${contractId}/approve`, aliceToken, {
      method: 'POST',
    });
    assert.equal(aliceApprove.status, 200);
    const approveBody = await aliceApprove.json();
    assert.equal(approveBody.contract.isApproved, true);
    assert.equal(approveBody.contract.isActive, true);

    // Now endpoint reports hasActiveContract: true
    const epRes = await authFetch(`${baseUrl}/api/endpoints/${aliceEndpoint._id}`, aliceToken);
    const epBody = await epRes.json();
    assert.equal(epBody.hasActiveContract, true);
    assert.equal(epBody.activeContract._id, contractId);
  });
});
