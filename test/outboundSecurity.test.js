const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { runProductCheck } = require('../src/services/detectionEngine.service');
const { safeHttpRequest } = require('../src/services/ssrfProtection.service');
const { productSchema } = require('../src/contracts/product.schema');

test('Milestone 7B: Outbound Request Security Hardening Suite', async (t) => {
  let server;
  let serverPort;
  let serverBase;

  // Controlled local test server mimicking various safe and hostile upstream responses
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    switch (url.pathname) {
      case '/api/healthy':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 101,
          name: 'Mechanical Keyboard',
          price: 99.99
        }));
        break;

      case '/api/schema-violation':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 101,
          name: 'Mechanical Keyboard',
          price: 'ninety-nine' // Invalid type: string instead of number
        }));
        break;

      case '/api/server-error':
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
        break;

      case '/api/invalid-json':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('Malformed JSON response {');
        break;

      case '/api/slow':
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 101,
            name: 'Mechanical Keyboard',
            price: 99.99
          }));
        }, 150);
        break;

      case '/api/safe-relative-redirect':
        res.writeHead(302, { Location: '/api/healthy' });
        res.end();
        break;

      case '/api/safe-absolute-redirect':
        res.writeHead(302, { Location: `http://safe-public.test:${serverPort}/api/healthy` });
        res.end();
        break;

      case '/api/redirect-loop-a':
        res.writeHead(302, { Location: '/api/redirect-loop-b' });
        res.end();
        break;

      case '/api/redirect-loop-b':
        res.writeHead(302, { Location: '/api/redirect-loop-a' });
        res.end();
        break;

      case '/api/redirect-hop-1':
        res.writeHead(302, { Location: '/api/redirect-hop-2' });
        res.end();
        break;

      case '/api/redirect-hop-2':
        res.writeHead(302, { Location: '/api/redirect-hop-3' });
        res.end();
        break;

      case '/api/redirect-hop-3':
        res.writeHead(302, { Location: '/api/healthy' });
        res.end();
        break;

      case '/api/redirect-to-loopback':
        res.writeHead(302, { Location: 'http://127.0.0.1:9090/admin' });
        res.end();
        break;

      case '/api/redirect-to-private':
        res.writeHead(302, { Location: 'http://10.0.0.1:8080/internal' });
        res.end();
        break;

      case '/api/redirect-to-metadata':
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
        res.end();
        break;

      case '/api/redirect-to-ipv6-loopback':
        res.writeHead(302, { Location: 'http://[::1]:8080/internal' });
        res.end();
        break;

      case '/api/cross-origin-start':
        res.writeHead(302, { Location: `http://secondary-origin.test:${serverPort}/api/inspect-headers` });
        res.end();
        break;

      case '/api/inspect-headers':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          headers: req.headers
        }));
        break;

      default:
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NotFound' }));
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  serverPort = server.address().port;
  serverBase = `http://127.0.0.1:${serverPort}`;

  t.after(() => {
    if (server) server.close();
  });

  // Mock DNS resolver map for isolated, network-independent testing
  const mockDnsMap = {
    'safe-public.test': [{ address: '127.0.0.1', family: 4 }], // permitted only when allowLocal: true
    'secondary-origin.test': [{ address: '127.0.0.1', family: 4 }],
    'rebind-loopback.test': [{ address: '127.0.0.1', family: 4 }],
    'rebind-private.test': [{ address: '10.0.0.5', family: 4 }],
    'rebind-imds.test': [{ address: '169.254.169.254', family: 4 }],
    'rebind-cgnat.test': [{ address: '100.64.0.1', family: 4 }],
    'rebind-ipv6-loopback.test': [{ address: '::1', family: 6 }],
    'rebind-ipv6-linklocal.test': [{ address: 'fe80::1', family: 6 }],
    'rebind-ipv6-ula.test': [{ address: 'fc00::1', family: 6 }]
  };

  const testDnsResolver = async (hostname) => {
    if (mockDnsMap[hostname]) {
      return mockDnsMap[hostname];
    }
    const err = new Error(`ENOTFOUND ${hostname}`);
    err.code = 'ENOTFOUND';
    throw err;
  };

  // =========================================================================
  // 1. DNS REBINDING DEFENSE AT CONNECTION TIME
  // =========================================================================

  await t.test('1. Blocks connection to domain rebinding to loopback 127.0.0.1', async () => {
    const result = await runProductCheck({
      url: `http://rebind-loopback.test:${serverPort}/api/healthy`,
      dnsResolver: testDnsResolver,
      allowLocal: false
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'NETWORK_ERROR');
    assert.ok(result.errors.some(err => err.includes('prohibited IP address: 127.0.0.1')));
  });

  await t.test('2. Blocks connection to domain rebinding to private IP 10.0.0.5', async () => {
    const result = await runProductCheck({
      url: `http://rebind-private.test:${serverPort}/api/healthy`,
      dnsResolver: testDnsResolver,
      allowLocal: false
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'NETWORK_ERROR');
    assert.ok(result.errors.some(err => err.includes('prohibited IP address: 10.0.0.5')));
  });

  await t.test('3. Blocks connection to domain rebinding to Cloud Metadata IMDS 169.254.169.254', async () => {
    const result = await runProductCheck({
      url: `http://rebind-imds.test:${serverPort}/api/healthy`,
      dnsResolver: testDnsResolver,
      allowLocal: false
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'NETWORK_ERROR');
    assert.ok(result.errors.some(err => err.includes('prohibited IP address: 169.254.169.254')));
  });

  await t.test('4. Blocks connection to domain rebinding to IPv6 loopback [::1]', async () => {
    const result = await runProductCheck({
      url: `http://rebind-ipv6-loopback.test:${serverPort}/api/healthy`,
      dnsResolver: testDnsResolver,
      allowLocal: false
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'NETWORK_ERROR');
    assert.ok(result.errors.some(err => err.includes('prohibited IP address: ::1')));
  });

  await t.test('5. Blocks connection to domain rebinding to IPv6 link-local [fe80::1]', async () => {
    const result = await runProductCheck({
      url: `http://rebind-ipv6-linklocal.test:${serverPort}/api/healthy`,
      dnsResolver: testDnsResolver,
      allowLocal: false
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'NETWORK_ERROR');
    assert.ok(result.errors.some(err => err.includes('prohibited IP address: fe80::1')));
  });

  await t.test('6. Blocks connection to domain rebinding to IPv6 ULA [fc00::1]', async () => {
    const result = await runProductCheck({
      url: `http://rebind-ipv6-ula.test:${serverPort}/api/healthy`,
      dnsResolver: testDnsResolver,
      allowLocal: false
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'NETWORK_ERROR');
    assert.ok(result.errors.some(err => err.includes('prohibited IP address: fc00::1')));
  });

  // =========================================================================
  // 2. DIRECT PROHIBITED IP & PROTOCOL ATTEMPTS
  // =========================================================================

  await t.test('7. Blocks direct connection to prohibited IP addresses (IPv4 & IPv6)', async () => {
    const prohibitedTargets = [
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/admin',
      'http://172.16.0.1/status',
      'http://192.168.1.1/router',
      'http://100.64.0.1/cgnat',
      'http://[::1]/status',
      'http://[fe80::1]/linklocal',
      'http://[fc00::1]/ula',
      'http://[::ffff:127.0.0.1]/status'
    ];

    for (const targetUrl of prohibitedTargets) {
      const result = await runProductCheck({
        url: targetUrl,
        allowLocal: false
      });

      assert.equal(result.status, 'failed', `Expected failure for target: ${targetUrl}`);
      assert.equal(result.failureType, 'NETWORK_ERROR');
      assert.ok(result.errors.some(err => err.includes('prohibited by SSRF security policy')));
    }
  });

  // =========================================================================
  // 3. REDIRECT SECURITY CONTROLS
  // =========================================================================

  await t.test('8. Follows safe relative redirect to valid product', async () => {
    const result = await runProductCheck({
      url: `${serverBase}/api/safe-relative-redirect`,
      allowLocal: true
    });

    assert.equal(result.status, 'healthy');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.schemaValid, true);
  });

  await t.test('9. Follows safe absolute redirect when destination is safe', async () => {
    const result = await runProductCheck({
      url: `${serverBase}/api/safe-absolute-redirect`,
      allowLocal: true,
      dnsResolver: testDnsResolver
    });

    assert.equal(result.status, 'healthy');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.schemaValid, true);
  });

  await t.test('10. Blocks redirect targeting Cloud Metadata IMDS (169.254.169.254)', async () => {
    const result = await runProductCheck({
      url: `${serverBase}/api/redirect-to-metadata`,
      allowLocal: true // Even with allowLocal, metadata is strictly prohibited
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'NETWORK_ERROR');
    assert.ok(result.errors.some(err => err.includes('prohibited by SSRF security policy')));
  });

  await t.test('11. Blocks redirect targeting private network (10.0.0.1)', async () => {
    const result = await runProductCheck({
      url: `${serverBase}/api/redirect-to-private`,
      allowLocal: true
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'NETWORK_ERROR');
    assert.ok(result.errors.some(err => err.includes('prohibited by SSRF security policy')));
  });

  await t.test('12. Blocks redirect targeting loopback address when allowLocal is false', async () => {
    const result = await runProductCheck({
      url: `${serverBase}/api/redirect-to-loopback`,
      allowLocal: false
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'NETWORK_ERROR');
    assert.ok(result.errors.some(err => err.includes('prohibited by SSRF security policy')));
  });

  await t.test('13. Blocks redirect targeting IPv6 loopback [::1]', async () => {
    const result = await runProductCheck({
      url: `${serverBase}/api/redirect-to-ipv6-loopback`,
      allowLocal: false
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'NETWORK_ERROR');
    assert.ok(result.errors.some(err => err.includes('prohibited by SSRF security policy')));
  });

  await t.test('14. Detects and blocks redirect loop (A -> B -> A)', async () => {
    const result = await runProductCheck({
      url: `${serverBase}/api/redirect-loop-a`,
      allowLocal: true
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'NETWORK_ERROR');
    assert.ok(result.errors.some(err => err.includes('Redirect loop detected')));
  });

  await t.test('15. Enforces maxRedirects limit on excessive redirect chains', async () => {
    // Upstream has 3 redirect hops, but limit is set strictly to 2
    const result = await runProductCheck({
      url: `${serverBase}/api/redirect-hop-1`,
      allowLocal: true,
      maxRedirects: 2
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'NETWORK_ERROR');
    assert.ok(result.errors.some(err => err.includes('Too many redirects')));
  });

  await t.test('16. Strips sensitive Authorization and Cookie headers across origins', async () => {
    const res = await safeHttpRequest({
      url: `${serverBase}/api/cross-origin-start`,
      headers: {
        'Authorization': 'Bearer super-secret-token',
        'Cookie': 'sessionId=abc123xyz',
        'X-Safe-Header': 'keep-me'
      },
      allowLocal: true,
      dnsResolver: testDnsResolver
    });

    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.headers['authorization'], undefined);
    assert.equal(body.headers['cookie'], undefined);
    assert.equal(body.headers['x-safe-header'], 'keep-me');
  });

  // =========================================================================
  // 4. REGRESSION VERIFICATION FOR DETECTION ENGINE CORE BEHAVIOR
  // =========================================================================

  await t.test('17. Healthy response passes contract validation', async () => {
    const result = await runProductCheck({
      url: `${serverBase}/api/healthy`,
      allowLocal: true
    });

    assert.equal(result.status, 'healthy');
    assert.equal(result.failureType, null);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.schemaValid, true);
    assert.equal(result.errors.length, 0);
  });

  await t.test('18. Schema violation is correctly identified', async () => {
    const result = await runProductCheck({
      url: `${serverBase}/api/schema-violation`,
      allowLocal: true
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'SCHEMA_VIOLATION');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.schemaValid, false);
    assert.ok(result.errors.some(err => err.includes("Field 'price' must be of type number")));
  });

  await t.test('19. HTTP 500 server error is reported as HTTP_ERROR', async () => {
    const result = await runProductCheck({
      url: `${serverBase}/api/server-error`,
      allowLocal: true
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'HTTP_ERROR');
    assert.equal(result.httpStatus, 500);
    assert.equal(result.schemaValid, false);
    assert.ok(result.errors.some(err => err.includes('HTTP failure: server returned status code 500')));
  });

  await t.test('20. Invalid JSON response is reported as INVALID_JSON', async () => {
    const result = await runProductCheck({
      url: `${serverBase}/api/invalid-json`,
      allowLocal: true
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'INVALID_JSON');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.schemaValid, false);
    assert.ok(result.errors.some(err => err.includes('Response body could not be parsed as valid JSON')));
  });

  await t.test('21. Slow response times out cleanly and is reported as TIMEOUT', async () => {
    const result = await runProductCheck({
      url: `${serverBase}/api/slow`,
      timeoutMs: 40,
      allowLocal: true
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failureType, 'TIMEOUT');
    assert.equal(result.httpStatus, null);
    assert.equal(result.schemaValid, false);
    assert.ok(result.errors.some(err => err.includes('timed out')));
  });
});
