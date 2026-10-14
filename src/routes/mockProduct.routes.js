const express = require('express');
const router = express.Router();

/**
 * In-memory mock product catalog.
 * In Milestone 2, we do not need a database; a predictable in-memory
 * store is perfect for safe, fast, and repeatable testing.
 */
const PRODUCTS = {
  101: { id: 101, name: 'Laptop', price: 50000 },
  102: { id: 102, name: 'Phone', price: 25000 }
};

const SUPPORTED_SCENARIOS = ['missing-price', 'wrong-price-type', 'server-error', 'slow'];

// Helper function to pause execution for a given number of milliseconds
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET /mock-api/products
 * Returns all products in the catalog.
 */
router.get('/', (req, res) => {
  res.status(200).json(Object.values(PRODUCTS));
});

/**
 * GET /mock-api/products/:id
 * Supports query parameter ?scenario=
 *
 * Supported scenarios:
 * - (none)            -> 200 OK with valid product object
 * - missing-price     -> 200 OK with product object missing the price field
 * - wrong-price-type  -> 200 OK with price formatted as string instead of number
 * - server-error      -> 500 Internal Server Error with error details
 * - slow              -> 200 OK after a bounded delay (default 500ms, max 2000ms)
 */
router.get('/:id', async (req, res) => {
  const productId = parseInt(req.params.id, 10);
  const scenario = req.query.scenario;

  // Validate the requested product exists in our mock catalog
  const baseProduct = PRODUCTS[productId];
  if (!baseProduct) {
    return res.status(404).json({
      error: 'NotFound',
      message: `Product with ID ${req.params.id} was not found`
    });
  }

  // If a scenario query parameter is provided, validate it
  if (scenario && !SUPPORTED_SCENARIOS.includes(scenario)) {
    return res.status(400).json({
      error: 'BadRequest',
      message: `Unsupported scenario '${scenario}'. Supported scenarios: ${SUPPORTED_SCENARIOS.join(', ')}`
    });
  }

  // Scenario 1: Server Error (500)
  if (scenario === 'server-error') {
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'Simulated upstream database failure'
    });
  }

  // Scenario 2: Missing field (price omitted)
  if (scenario === 'missing-price') {
    const { price, ...productWithoutPrice } = baseProduct;
    return res.status(200).json(productWithoutPrice);
  }

  // Scenario 3: Wrong data type (price returned as string)
  if (scenario === 'wrong-price-type') {
    return res.status(200).json({
      ...baseProduct,
      price: String(baseProduct.price)
    });
  }

  // Scenario 4: Slow response (simulated latency)
  if (scenario === 'slow') {
    // Safe bounded delay: default 500ms, clamped between 50ms and 2000ms
    const requestedDelay = parseInt(req.query.delay, 10);
    const delayMs = Number.isInteger(requestedDelay)
      ? Math.min(Math.max(requestedDelay, 50), 2000)
      : 500;

    await wait(delayMs);
    return res.status(200).json(baseProduct);
  }

  // Default: Healthy 200 OK response with the expected schema
  return res.status(200).json(baseProduct);
});

module.exports = router;
