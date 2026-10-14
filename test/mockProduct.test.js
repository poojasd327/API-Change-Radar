const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');

test('Mock Product API suite', async (t) => {
  // Start server on an ephemeral port (port 0 lets OS assign a free port)
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/mock-api/products`;

  t.after(() => {
    server.close();
  });

  await t.test('1. Healthy endpoint returns 200 and expected schema fields', async () => {
    const res = await fetch(`${baseUrl}/101`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.id, 101);
    assert.equal(body.name, 'Laptop');
    assert.equal(body.price, 50000);
    assert.equal(typeof body.price, 'number');
  });

  await t.test('2. Scenario missing-price returns 200 but omits price field', async () => {
    const res = await fetch(`${baseUrl}/101?scenario=missing-price`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.id, 101);
    assert.equal(body.name, 'Laptop');
    assert.equal(body.price, undefined);
    assert.equal('price' in body, false);
  });

  await t.test('3. Scenario wrong-price-type returns 200 but price is a string', async () => {
    const res = await fetch(`${baseUrl}/101?scenario=wrong-price-type`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.id, 101);
    assert.equal(body.price, '50000');
    assert.equal(typeof body.price, 'string');
  });

  await t.test('4. Scenario server-error returns HTTP 500 with structured JSON error', async () => {
    const res = await fetch(`${baseUrl}/101?scenario=server-error`);
    assert.equal(res.status, 500);

    const body = await res.json();
    assert.equal(body.error, 'InternalServerError');
    assert.ok(body.message);
  });

  await t.test('5. Scenario slow responds after delay with valid product data', async () => {
    const startTime = Date.now();
    // Test with a short 100ms bounded delay to keep tests fast
    const res = await fetch(`${baseUrl}/101?scenario=slow&delay=100`);
    const elapsedMs = Date.now() - startTime;

    assert.equal(res.status, 200);
    assert.ok(elapsedMs >= 90, `Expected delay >= 90ms, got ${elapsedMs}ms`);

    const body = await res.json();
    assert.equal(body.id, 101);
    assert.equal(body.name, 'Laptop');
    assert.equal(body.price, 50000);
  });

  await t.test('6. Unsupported scenario returns HTTP 400 Bad Request', async () => {
    const res = await fetch(`${baseUrl}/101?scenario=non-existent-scenario`);
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.equal(body.error, 'BadRequest');
    assert.match(body.message, /Unsupported scenario/);
  });

  await t.test('7. Unknown product ID returns HTTP 404', async () => {
    const res = await fetch(`${baseUrl}/9999`);
    assert.equal(res.status, 404);

    const body = await res.json();
    assert.equal(body.error, 'NotFound');
  });
});
