const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { runProductCheck } = require('../src/services/detectionEngine.service');

test('Detection Engine and Check Route Suite', async (t) => {
  // Bind server to an ephemeral port (port 0) for isolated, parallel-safe testing
  const server = app.listen(0);
  const port = server.address().port;
  const mockBaseUrl = `http://127.0.0.1:${port}/mock-api/products`;
  const checkEndpointUrl = `http://127.0.0.1:${port}/api/checks/mock-product`;

  // Inform Express app about this server's dynamic mock API base URL
  app.set('mockApiBaseUrl', mockBaseUrl);

  t.after(() => {
    server.close();
  });

  // --- UNIT / SERVICE LEVEL TESTS (runProductCheck) ---

  await t.test('1. Healthy product passes schema validation', async () => {
    const result = await runProductCheck({
      url: `${mockBaseUrl}/101`
    });

    assert.equal(result.status, 'healthy');
    assert.equal(result.failureType, null);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.schemaValid, true);
    assert.equal(result.errors.length, 0);
    assert.ok(typeof result.responseTimeMs === 'number');
    assert.ok(result.checkedAt);
  });

  await t.test('2. Missing price causes schema violation', async () => {
    const result = await runProductCheck({
      url: `${mockBaseUrl}/101?scenario=missing-price`
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'SCHEMA_VIOLATION');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.schemaValid, false);
    assert.ok(result.errors.some(err => err.includes("Missing required property 'price'")));
  });

  await t.test('3. String price causes schema violation', async () => {
    const result = await runProductCheck({
      url: `${mockBaseUrl}/101?scenario=wrong-price-type`
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'SCHEMA_VIOLATION');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.schemaValid, false);
    assert.ok(result.errors.some(err => err.includes("Field 'price' must be of type number")));
  });

  await t.test('4. HTTP 500 is identified as HTTP_ERROR, not schema violation', async () => {
    const result = await runProductCheck({
      url: `${mockBaseUrl}/101?scenario=server-error`
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'HTTP_ERROR');
    assert.equal(result.httpStatus, 500);
    assert.equal(result.schemaValid, false);
    assert.ok(result.errors.some(err => err.includes('HTTP failure: server returned status code 500')));
  });

  await t.test('5. Slow response eventually passes schema validation', async () => {
    const result = await runProductCheck({
      url: `${mockBaseUrl}/101?scenario=slow&delay=60`,
      timeoutMs: 1000
    });

    assert.equal(result.status, 'healthy');
    assert.equal(result.failureType, null);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.schemaValid, true);
    assert.ok(result.responseTimeMs >= 50, `Expected elapsed >= 50ms, got ${result.responseTimeMs}ms`);
  });

  await t.test('6. Request timeout is handled safely without crashing', async () => {
    // Upstream has 200ms delay, but our timeout is strictly 50ms
    const result = await runProductCheck({
      url: `${mockBaseUrl}/101?scenario=slow&delay=200`,
      timeoutMs: 50
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'TIMEOUT');
    assert.equal(result.httpStatus, null);
    assert.equal(result.schemaValid, false);
    assert.ok(result.errors.some(err => err.includes('timed out')));
  });

  await t.test('7. Network failure (unreachable host) is handled safely', async () => {
    // Port 1 is not in use and will refuse connection immediately
    const result = await runProductCheck({
      url: 'http://127.0.0.1:1/non-existent'
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'NETWORK_ERROR');
    assert.equal(result.httpStatus, null);
    assert.equal(result.schemaValid, false);
    assert.ok(result.errors.some(err => err.includes('Network request failed')));
  });

  // --- HTTP ROUTE LEVEL TESTS (POST /api/checks/mock-product) ---

  await t.test('8. POST /api/checks/mock-product triggers healthy check', async () => {
    const res = await fetch(checkEndpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'healthy');
    assert.equal(body.schemaValid, true);
  });

  await t.test('9. POST /api/checks/mock-product with scenario wrong-price-type', async () => {
    const res = await fetch(checkEndpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'wrong-price-type' })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'failed');
    assert.equal(body.failureType, 'SCHEMA_VIOLATION');
  });

  await t.test('10. POST /api/checks/mock-product with unsupported scenario returns 400', async () => {
    const res = await fetch(checkEndpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'unknown-scenario' })
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'BadRequest');
    assert.match(body.message, /Unsupported scenario/);
  });
});
