/**
 * In-memory sliding-window rate limiter middleware for public endpoints.
 * Protects public status routes from brute force enumeration or excessive polling.
 */
function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60 * 1000; // 1 minute window
  const max = options.max || 60; // Max requests per window
  const message = options.message || 'Too many requests. Please try again later.';

  const ipStore = new Map();

  // Periodically purge expired records to prevent unbounded memory growth
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of ipStore.entries()) {
      if (now > entry.resetTime) {
        ipStore.delete(ip);
      }
    }
  }, Math.max(windowMs, 30000));

  // Ensure interval does not prevent Node from exiting cleanly
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  const rateLimiter = (req, res, next) => {
    // Determine client identifier
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const now = Date.now();

    let entry = ipStore.get(clientIp);

    if (!entry || now > entry.resetTime) {
      entry = {
        count: 1,
        resetTime: now + windowMs
      };
      ipStore.set(clientIp, entry);
    } else {
      entry.count += 1;
    }

    const remaining = Math.max(0, max - entry.count);
    const resetSeconds = Math.ceil((entry.resetTime - now) / 1000);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetSeconds);

    if (entry.count > max) {
      res.setHeader('Retry-After', resetSeconds);
      return res.status(429).json({
        error: 'TooManyRequests',
        message
      });
    }

    next();
  };

  rateLimiter.reset = () => {
    ipStore.clear();
  };

  return rateLimiter;
}

module.exports = {
  createRateLimiter
};
