import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';

test('GET /api/health returns 200 and operational health metadata', async (t) => {
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const response = await fetch(`http://localhost:${port}/api/health`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.message, 'APIChange Radar service is running');
    assert.ok(body.timestamp, 'timestamp should be present');
    assert.equal(typeof body.uptime, 'number');
    assert.equal(typeof body.environment, 'string');
  } finally {
    server.close();
  }
});

test('GET /unknown-route returns 404 Not Found', async (t) => {
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const response = await fetch(`http://localhost:${port}/unknown-route`);
    assert.equal(response.status, 404);

    const body = await response.json();
    assert.equal(body.error, 'Not Found');
  } finally {
    server.close();
  }
});
