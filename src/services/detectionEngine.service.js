const Ajv = require('ajv');
const { productSchema } = require('../contracts/product.schema');

// Initialize Ajv with allErrors: true to report all schema violations, not just the first one
const ajv = new Ajv({ allErrors: true });
const validateProduct = ajv.compile(productSchema);

/**
 * Format Ajv error objects into friendly, human-readable strings.
 */
function formatSchemaErrors(ajvErrors) {
  if (!ajvErrors || ajvErrors.length === 0) return [];

  return ajvErrors.map((err) => {
    if (err.keyword === 'required') {
      return `Missing required property '${err.params.missingProperty}'`;
    }
    if (err.keyword === 'type') {
      const field = err.instancePath ? err.instancePath.replace(/^\//, '') : 'value';
      return `Field '${field}' must be of type ${err.params.type}`;
    }
    if (err.keyword === 'additionalProperties') {
      return `Unexpected property '${err.params.additionalProperty}' not allowed by contract`;
    }
    const location = err.instancePath ? `at '${err.instancePath}' ` : '';
    return `Contract error ${location}${err.message}`;
  });
}

/**
 * Execute an API contract check against a target product endpoint.
 *
 * @param {Object} options
 * @param {string} options.url - The target URL to check.
 * @param {number} [options.timeoutMs=3000] - Request timeout limit in milliseconds.
 * @param {Function} [options.validator] - Compiled Ajv validation function.
 * @param {Object} [options.schema] - Optional JSON Schema object to validate against.
 * @returns {Promise<Object>} Structured check result.
 */
async function runProductCheck({ url, timeoutMs = 3000, validator = null, schema = null }) {
  const activeValidator = validator || (schema ? ajv.compile(schema) : validateProduct);
  const checkedAt = new Date().toISOString();
  const startTime = performance.now();

  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, { signal });
    const responseTimeMs = Math.round(performance.now() - startTime);
    const httpStatus = response.status;

    // 1. Check HTTP Status
    // Any status >= 400 is an HTTP-level failure (e.g. 500 Server Error, 404 Not Found)
    // Important: A 500 error must NOT be treated as a schema violation!
    if (httpStatus >= 400) {
      return {
        status: 'failed',
        failureType: 'HTTP_ERROR',
        httpStatus,
        responseTimeMs,
        schemaValid: false,
        errors: [`HTTP failure: server returned status code ${httpStatus}`],
        checkedAt,
        endpoint: url
      };
    }

    // 2. Parse response body as JSON safely
    let responseBody;
    try {
      responseBody = await response.json();
    } catch (parseErr) {
      return {
        status: 'failed',
        failureType: 'INVALID_JSON',
        httpStatus,
        responseTimeMs,
        schemaValid: false,
        errors: [`Response body could not be parsed as valid JSON: ${parseErr.message}`],
        checkedAt,
        endpoint: url
      };
    }

    // 3. Validate against the approved JSON Schema contract using Ajv
    const isSchemaValid = Boolean(activeValidator(responseBody));

    if (!isSchemaValid) {
      const schemaErrors = formatSchemaErrors(activeValidator.errors);
      return {
        status: 'failed',
        failureType: 'SCHEMA_VIOLATION',
        httpStatus,
        responseTimeMs,
        schemaValid: false,
        errors: schemaErrors,
        checkedAt,
        endpoint: url
      };
    }

    // 4. Everything succeeded: Healthy result
    return {
      status: 'healthy',
      failureType: null,
      httpStatus,
      responseTimeMs,
      schemaValid: true,
      errors: [],
      checkedAt,
      endpoint: url
    };
  } catch (err) {
    const responseTimeMs = Math.round(performance.now() - startTime);

    // Handle request timeout
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return {
        status: 'failed',
        failureType: 'TIMEOUT',
        httpStatus: null,
        responseTimeMs,
        schemaValid: false,
        errors: [`Request timed out after ${timeoutMs}ms`],
        checkedAt,
        endpoint: url
      };
    }

    // Handle general network failure (connection refused, DNS resolution error, etc.)
    return {
      status: 'failed',
      failureType: 'NETWORK_ERROR',
      httpStatus: null,
      responseTimeMs,
      schemaValid: false,
      errors: [`Network request failed: ${err.message}`],
      checkedAt,
      endpoint: url
    };
  }
}

module.exports = {
  runProductCheck,
  formatSchemaErrors,
  validateProduct
};
