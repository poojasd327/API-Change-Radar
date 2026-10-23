const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');

/**
 * Checks whether an IPv4 address belongs to a prohibited range:
 * - Loopback (127.0.0.0/8)
 * - Current network (0.0.0.0/8)
 * - Private RFC 1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - Link-local / Cloud Metadata (169.254.0.0/16)
 * - Carrier-Grade NAT (100.64.0.0/10)
 * - IETF Protocol / Documentation (192.0.0.0/24, 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)
 * - Benchmark (198.18.0.0/15)
 * - Multicast (224.0.0.0/4)
 * - Reserved / Broadcast (240.0.0.0/4, 255.255.255.255)
 *
 * @param {string} ip - IPv4 address string
 * @param {Object} [options]
 * @param {boolean} [options.allowLoopback=false] - If true, permits 127.0.0.0/8 for local mock catalog
 * @returns {boolean} true if prohibited
 */
function isProhibitedIPv4(ip, { allowLoopback = false } = {}) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) {
    return true; // Malformed IPv4 is prohibited
  }

  const [a, b, c, d] = parts;

  // 0.0.0.0/8 - Current network
  if (a === 0) return true;

  // 127.0.0.0/8 - Loopback
  if (a === 127) {
    return !allowLoopback;
  }

  // 10.0.0.0/8 - Private RFC 1918
  if (a === 10) return true;

  // 172.16.0.0/12 - Private RFC 1918 (172.16.0.0 to 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 - Private RFC 1918
  if (a === 192 && b === 168) return true;

  // 169.254.0.0/16 - Link-local / Cloud Metadata IMDS (RFC 3927) - NEVER ALLOWED
  if (a === 169 && b === 254) return true;

  // 100.64.0.0/10 - Carrier-Grade NAT (RFC 6598: 100.64.0.0 to 100.127.255.255)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 192.0.0.0/24 - IETF Protocol Assignments
  if (a === 192 && b === 0 && c === 0) return true;

  // 192.0.2.0/24 - TEST-NET-1 documentation
  if (a === 192 && b === 0 && c === 2) return true;

  // 198.18.0.0/15 - Network benchmark testing (198.18.0.0 to 198.19.255.255)
  if (a === 198 && (b === 18 || b === 19)) return true;

  // 198.51.100.0/24 - TEST-NET-2 documentation
  if (a === 198 && b === 51 && c === 100) return true;

  // 203.0.113.0/24 - TEST-NET-3 documentation
  if (a === 203 && b === 0 && c === 113) return true;

  // 224.0.0.0/4 - Multicast (224.0.0.0 to 239.255.255.255)
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 - Reserved / Future use / Broadcast (240.0.0.0 to 255.255.255.255)
  if (a >= 240) return true;

  return false;
}

/**
 * Parses an IPv6 string into an array of 8 16-bit integers.
 * Handles :: shorthand and IPv4-mapped trailing notation.
 *
 * @param {string} ip - IPv6 string
 * @returns {number[]|null} Array of 8 integers or null if invalid
 */
function parseIPv6Groups(ip) {
  let clean = ip.replace(/^\[|\]$/g, '').toLowerCase();

  // Handle trailing dotted IPv4, e.g. ::ffff:192.168.1.1
  const lastColon = clean.lastIndexOf(':');
  if (lastColon !== -1) {
    const tail = clean.slice(lastColon + 1);
    if (tail.includes('.')) {
      const parts = tail.split('.').map(Number);
      if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) {
        return null;
      }
      const hex1 = (((parts[0] << 8) | parts[1]) >>> 0).toString(16);
      const hex2 = (((parts[2] << 8) | parts[3]) >>> 0).toString(16);
      clean = clean.slice(0, lastColon + 1) + hex1 + ':' + hex2;
    }
  }

  const halves = clean.split('::');
  if (halves.length > 2) return null; // Invalid multiple ::

  let groups = [];
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = clean.split(':');
  }

  if (groups.length !== 8) return null;

  const parsed = groups.map(g => parseInt(g || '0', 16));
  if (parsed.some(n => isNaN(n) || n < 0 || n > 0xffff)) return null;

  return parsed;
}

/**
 * Checks whether an IPv6 address belongs to a prohibited range:
 * - Unspecified (::/128)
 * - Loopback (::1/128)
 * - IPv4-mapped IPv6 (::ffff:0:0/96) with prohibited IPv4
 * - Unique Local Address (fc00::/7)
 * - Link-Local (fe80::/10)
 * - Multicast (ff00::/8)
 * - Discard-only (100::/64)
 * - Documentation (2001:db8::/32)
 *
 * @param {string} ip - IPv6 string
 * @param {Object} [options]
 * @param {boolean} [options.allowLoopback=false]
 * @returns {boolean} true if prohibited
 */
function isProhibitedIPv6(ip, { allowLoopback = false } = {}) {
  const groups = parseIPv6Groups(ip);
  if (!groups) return true; // Malformed IPv6 is prohibited

  // Unspecified (::)
  if (groups.every(g => g === 0)) return true;

  // Loopback (::1)
  if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1) {
    return !allowLoopback;
  }

  // Unique Local Address (fc00::/7 - fc00:: through fdff::)
  if ((groups[0] & 0xfe00) === 0xfc00) return true;

  // Link-Local (fe80::/10 - fe80:: through febf::)
  if ((groups[0] & 0xffc0) === 0xfe80) return true;

  // Multicast (ff00::/8)
  if ((groups[0] & 0xff00) === 0xff00) return true;

  // Discard-only (100::/64)
  if (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return true;

  // Documentation (2001:db8::/32)
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;

  // IPv4-mapped IPv6 (::ffff:0:0/96)
  if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) {
    const a = (groups[6] >> 8) & 0xff;
    const b = groups[6] & 0xff;
    const c = (groups[7] >> 8) & 0xff;
    const d = groups[7] & 0xff;
    return isProhibitedIPv4(`${a}.${b}.${c}.${d}`, { allowLoopback });
  }

  return false;
}

/**
 * Checks whether an IP address (v4 or v6) is prohibited.
 *
 * @param {string} ip - IP address string
 * @param {Object} [options]
 * @param {boolean} [options.allowLoopback=false]
 * @returns {boolean}
 */
function isProhibitedIp(ip, { allowLoopback = false } = {}) {
  const cleanIp = ip.replace(/^\[|\]$/g, '').trim();
  const family = net.isIP(cleanIp);
  if (family === 4) {
    return isProhibitedIPv4(cleanIp, { allowLoopback });
  }
  if (family === 6) {
    return isProhibitedIPv6(cleanIp, { allowLoopback });
  }
  // Not a valid standard IP string; treat as prohibited
  return true;
}

/**
 * Prohibited hostnames, domains, and cloud metadata targets.
 */
const PROHIBITED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data'
]);

const PROHIBITED_DOMAIN_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home.arpa',
  '.corp',
  '.intranet'
];

/**
 * Checks whether a hostname matches prohibited domain patterns.
 *
 * @param {string} hostname - Hostname to check
 * @param {Object} [options]
 * @param {boolean} [options.allowLoopback=false]
 * @returns {boolean}
 */
function isProhibitedHostname(hostname, { allowLoopback = false } = {}) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');

  if (allowLoopback && (normalized === 'localhost' || normalized.endsWith('.localhost'))) {
    return false;
  }

  if (PROHIBITED_HOSTNAMES.has(normalized)) {
    return true;
  }

  for (const suffix of PROHIBITED_DOMAIN_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a target URL points to the local demo mock product catalog
 * on loopback (127.0.0.1 or localhost) with pathname starting with /mock-api/products.
 *
 * @param {string} urlStr
 * @returns {boolean}
 */
function isInternalMockUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const isLoopbackHost = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    return isLoopbackHost && u.pathname.startsWith('/mock-api/products');
  } catch {
    return false;
  }
}

/**
 * Default DNS lookup implementation using Node.js dns.promises.
 * Returns all resolved IPv4 and IPv6 addresses.
 *
 * @param {string} hostname
 * @returns {Promise<Array<{ address: string, family: number }>>}
 */
async function defaultDnsResolver(hostname) {
  return await dns.promises.lookup(hostname, { all: true });
}

/**
 * Comprehensive SSRF validator for target URLs (used at registration time).
 *
 * @param {string} urlString - URL string to validate
 * @param {Object} [options]
 * @param {Function} [options.dnsResolver] - Custom DNS resolver for deterministic testing
 * @param {boolean} [options.allowLocal=false] - For explicit local-only development mode if ever needed
 * @returns {Promise<{ isValid: boolean, normalizedUrl?: string, reason?: string }>}
 */
async function validateEndpointUrl(urlString, options = {}) {
  const { dnsResolver = defaultDnsResolver, allowLocal = false } = options;

  if (typeof urlString !== 'string' || urlString.trim() === '') {
    return { isValid: false, reason: 'URL must be a non-empty string' };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(urlString.trim());
  } catch {
    return { isValid: false, reason: 'Malformed URL syntax' };
  }

  // 1. Protocol check: only http: and https: allowed
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return {
      isValid: false,
      reason: `Protocol '${parsedUrl.protocol}' is prohibited. Only HTTP and HTTPS are permitted.`
    };
  }

  // 2. Reject URLs containing embedded credentials / userinfo
  if (parsedUrl.username || parsedUrl.password) {
    return {
      isValid: false,
      reason: 'URLs containing embedded credentials (user:password) are prohibited'
    };
  }

  // 3. Port check: if specified, must be between 1 and 65535
  if (parsedUrl.port) {
    const portNum = Number(parsedUrl.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return { isValid: false, reason: `Port '${parsedUrl.port}' is invalid` };
    }
  }

  // 4. Hostname check
  const rawHostname = parsedUrl.hostname;
  if (!rawHostname) {
    return { isValid: false, reason: 'URL hostname is missing' };
  }

  // Strip IPv6 enclosing brackets if present
  const cleanHost = rawHostname.replace(/^\[|\]$/g, '').toLowerCase();

  // If local addresses are not explicitly allowed, perform strict checks
  if (!allowLocal) {
    // Check prohibited hostname list/suffixes
    if (isProhibitedHostname(cleanHost, { allowLoopback: false })) {
      return {
        isValid: false,
        reason: 'Target URL hostname is prohibited by SSRF security policy'
      };
    }

    // Check if the hostname is an IP literal
    const ipFamily = net.isIP(cleanHost);
    if (ipFamily !== 0) {
      if (isProhibitedIp(cleanHost, { allowLoopback: false })) {
        return {
          isValid: false,
          reason: 'Target URL resolves to a prohibited or private IP address'
        };
      }
    } else {
      // Hostname is a domain name: resolve DNS and check all resolved IP addresses
      try {
        const records = await dnsResolver(cleanHost);
        if (!records || records.length === 0) {
          return {
            isValid: false,
            reason: `Unable to resolve host '${cleanHost}'`
          };
        }

        for (const record of records) {
          const resolvedIp = typeof record === 'string' ? record : record.address;
          if (isProhibitedIp(resolvedIp, { allowLoopback: false })) {
            return {
              isValid: false,
              reason: 'Target URL domain resolves to a prohibited destination'
            };
          }
        }
      } catch (dnsErr) {
        return {
          isValid: false,
          reason: `Hostname DNS resolution failed: ${dnsErr.message || 'Host not found'}`
        };
      }
    }
  }

  return {
    isValid: true,
    normalizedUrl: parsedUrl.toString()
  };
}

/**
 * Creates a connection-time socket lookup function for Node's net.Socket / http.request / https.request.
 * This intercepts the DNS resolution immediately prior to socket creation, validating all returned
 * IPv4 and IPv6 addresses against prohibited ranges.
 *
 * This completely eliminates the DNS rebinding (TOCTOU) vulnerability because the validated IP
 * is passed directly to the socket connection callback.
 *
 * @param {Object} [options]
 * @param {boolean} [options.allowLoopback=false]
 * @param {Function} [options.dnsResolver=null]
 * @returns {Function} (hostname, lookupOptions, callback) => void
 */
function createSafeLookup(options = {}) {
  const { allowLoopback = false, dnsResolver = null } = options;

  return function safeLookup(hostname, lookupOptions, callback) {
    // 1. If a custom resolver is supplied (e.g. for testing)
    if (dnsResolver) {
      Promise.resolve(dnsResolver(hostname))
        .then((records) => {
          if (!records || records.length === 0) {
            const err = new Error(`ENOTFOUND ${hostname}`);
            err.code = 'ENOTFOUND';
            return callback(err);
          }
          // Validate every resolved record
          for (const rec of records) {
            const ip = typeof rec === 'string' ? rec : rec.address;
            if (isProhibitedIp(ip, { allowLoopback })) {
              const err = new Error(`DNS resolution for '${hostname}' returned prohibited IP address: ${ip}`);
              err.code = 'ERR_SSRF_PROHIBITED_IP';
              return callback(err);
            }
          }
          const chosen = records[0];
          const chosenIp = typeof chosen === 'string' ? chosen : chosen.address;
          const family = typeof chosen === 'object' && chosen.family ? chosen.family : (net.isIP(chosenIp) || 4);
          if (lookupOptions && lookupOptions.all) {
            return callback(null, records.map(r => typeof r === 'string' ? { address: r, family: net.isIP(r) || 4 } : r));
          }
          return callback(null, chosenIp, family);
        })
        .catch(err => callback(err));
      return;
    }

    // 2. Standard resolution via Node.js dns.lookup
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses || addresses.length === 0) {
        const notFoundErr = new Error(`ENOTFOUND ${hostname}`);
        notFoundErr.code = 'ENOTFOUND';
        return callback(notFoundErr);
      }
      for (const rec of addresses) {
        const ip = rec.address;
        if (isProhibitedIp(ip, { allowLoopback })) {
          const prohibitedErr = new Error(`DNS resolution for '${hostname}' returned prohibited IP address: ${ip}`);
          prohibitedErr.code = 'ERR_SSRF_PROHIBITED_IP';
          return callback(prohibitedErr);
        }
      }
      if (lookupOptions && lookupOptions.all) {
        return callback(null, addresses);
      }
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/**
 * Safely executes an outbound HTTP/HTTPS request with:
 * 1. Connection-time DNS lookup validation (preventing DNS rebinding).
 * 2. Manual redirect following with SSRF inspection on every hop.
 * 3. Relative Location resolution against the current URL.
 * 4. Redirect loop detection via visited URLs Set.
 * 5. Configurable max redirect limit (default 5).
 * 6. Stripping Authorization/Cookie headers on cross-origin redirects.
 * 7. Accurate timeout enforcement across the entire redirect chain.
 *
 * @param {Object} options
 * @param {string} options.url - Target URL
 * @param {string} [options.method='GET'] - HTTP Method
 * @param {Object} [options.headers={}] - Request headers
 * @param {string|Buffer} [options.body=null] - Request body
 * @param {number} [options.timeoutMs=3000] - Total timeout limit in milliseconds
 * @param {number} [options.maxRedirects=5] - Maximum permitted redirect hops
 * @param {boolean} [options.allowLocal] - Explicitly permit loopback for internal mock API
 * @param {Function} [options.dnsResolver] - Injectable DNS resolver for testing
 * @returns {Promise<{ status: number, headers: Object, body: string, responseTimeMs: number, finalUrl: string, json: Function }>}
 */
async function safeHttpRequest(options = {}) {
  const {
    url,
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 3000,
    maxRedirects = 5,
    dnsResolver = null
  } = options;

  let currentUrl = url;
  let redirectCount = 0;
  const visitedUrls = new Set();
  const currentHeaders = { ...headers };

  // Determine whether loopback is permitted for the initial request
  const allowLoopback = options.allowLocal !== undefined
    ? options.allowLocal
    : isInternalMockUrl(currentUrl);

  const startTime = performance.now();

  while (true) {
    let parsedUrl;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      throw new Error(`Malformed URL '${currentUrl}'`);
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Unsupported protocol '${parsedUrl.protocol}'. Only HTTP and HTTPS are permitted.`);
    }

    if (parsedUrl.username || parsedUrl.password) {
      throw new Error('URLs containing embedded credentials are prohibited');
    }

    const cleanHost = parsedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();

    // Check IP literal before creating socket (since Node skips lookup for IP literals)
    const ipFamily = net.isIP(cleanHost);
    if (ipFamily !== 0) {
      if (isProhibitedIp(cleanHost, { allowLoopback })) {
        throw new Error(`Target IP '${cleanHost}' is prohibited by SSRF security policy`);
      }
    } else {
      if (isProhibitedHostname(cleanHost, { allowLoopback })) {
        throw new Error(`Target hostname '${cleanHost}' is prohibited by SSRF security policy`);
      }
    }

    visitedUrls.add(parsedUrl.toString());

    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;
    const port = parsedUrl.port ? Number(parsedUrl.port) : defaultPort;

    const remainingTimeoutMs = Math.max(1, timeoutMs - Math.round(performance.now() - startTime));

    // Execute single hop
    const hopResult = await new Promise((resolve, reject) => {
      let isSettled = false;
      let timer = null;

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: {
          'Host': parsedUrl.host,
          'User-Agent': 'APIChange-Radar/1.0',
          ...currentHeaders
        },
        lookup: createSafeLookup({ allowLoopback, dnsResolver })
      };

      const req = client.request(reqOptions, (res) => {
        const statusCode = res.statusCode || 200;
        const location = res.headers.location;

        // Check if redirect
        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          res.resume(); // Discard body
          if (timer) clearTimeout(timer);
          isSettled = true;
          return resolve({
            isRedirect: true,
            statusCode,
            location
          });
        }

        // Normal response: collect body
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          if (timer) clearTimeout(timer);
          if (isSettled) return;
          isSettled = true;
          const rawBuffer = Buffer.concat(chunks);
          const rawBody = rawBuffer.toString('utf8');
          resolve({
            isRedirect: false,
            statusCode,
            headers: res.headers,
            body: rawBody
          });
        });
      });

      req.on('error', (err) => {
        if (timer) clearTimeout(timer);
        if (isSettled) return;
        isSettled = true;
        reject(err);
      });

      timer = setTimeout(() => {
        if (isSettled) return;
        isSettled = true;
        req.destroy();
        const timeoutErr = new Error(`Request timed out after ${timeoutMs}ms`);
        timeoutErr.name = 'TimeoutError';
        reject(timeoutErr);
      }, remainingTimeoutMs);

      if (body) {
        req.write(body);
      }
      req.end();
    });

    if (!hopResult.isRedirect) {
      const responseTimeMs = Math.round(performance.now() - startTime);
      return {
        status: hopResult.statusCode,
        headers: hopResult.headers,
        body: hopResult.body,
        responseTimeMs,
        finalUrl: currentUrl,
        json: () => JSON.parse(hopResult.body)
      };
    }

    // Process redirect
    redirectCount++;
    if (redirectCount > maxRedirects) {
      throw new Error(`Too many redirects: exceeded limit of ${maxRedirects}`);
    }

    let nextUrlObj;
    try {
      nextUrlObj = new URL(hopResult.location, currentUrl);
    } catch {
      throw new Error(`Invalid redirect Location header: '${hopResult.location}'`);
    }

    const nextUrlStr = nextUrlObj.toString();
    if (visitedUrls.has(nextUrlStr)) {
      throw new Error(`Redirect loop detected to '${nextUrlStr}'`);
    }

    // Validate redirect destination hostname and IP
    const redirectHost = nextUrlObj.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (isProhibitedHostname(redirectHost, { allowLoopback })) {
      throw new Error(`Redirect destination hostname '${redirectHost}' is prohibited by SSRF security policy`);
    }
    const redirectIpFamily = net.isIP(redirectHost);
    if (redirectIpFamily !== 0 && isProhibitedIp(redirectHost, { allowLoopback })) {
      throw new Error(`Redirect destination IP '${redirectHost}' is prohibited by SSRF security policy`);
    }

    // Strip sensitive authentication headers on cross-origin redirects
    if (nextUrlObj.origin !== parsedUrl.origin) {
      delete currentHeaders['authorization'];
      delete currentHeaders['Authorization'];
      delete currentHeaders['cookie'];
      delete currentHeaders['Cookie'];
      delete currentHeaders['proxy-authorization'];
      delete currentHeaders['Proxy-Authorization'];
    }

    currentUrl = nextUrlStr;
  }
}

module.exports = {
  isProhibitedIPv4,
  isProhibitedIPv6,
  isProhibitedIp,
  isProhibitedHostname,
  isInternalMockUrl,
  validateEndpointUrl,
  defaultDnsResolver,
  createSafeLookup,
  safeHttpRequest
};
