const Incident = require('../models/Incident');

/**
 * Generate human-readable incident titles based on failure type.
 *
 * @param {string} failureType - Failure classification (SCHEMA_VIOLATION, HTTP_ERROR, etc.)
 * @param {string} [endpointName] - Display name of the endpoint
 * @param {number} [httpStatus] - HTTP status code if applicable
 * @returns {string} Human-readable title
 */
function formatIncidentTitle(failureType, endpointName = 'Endpoint', httpStatus = null) {
  switch (failureType) {
    case 'SCHEMA_VIOLATION':
      return `Schema contract violation on ${endpointName}`;
    case 'HTTP_ERROR':
      return `HTTP error ${httpStatus ? `(${httpStatus})` : ''} on ${endpointName}`.replace(/\s+/g, ' ').trim();
    case 'TIMEOUT':
      return `Request timed out on ${endpointName}`;
    case 'NETWORK_ERROR':
      return `Network connection failure on ${endpointName}`;
    case 'INVALID_JSON':
      return `Invalid JSON response received from ${endpointName}`;
    default:
      return `Check failure on ${endpointName}`;
  }
}

/**
 * Handle a failed check: find and update an existing OPEN incident,
 * or create a new OPEN incident if none exists for this endpoint and failure type.
 *
 * @param {Object} options
 * @param {Object} options.endpoint - The endpoint document ({ _id, name, ... })
 * @param {Object} [options.contract] - The associated contract document ({ _id, ... })
 * @param {Object} options.checkResult - Result from detectionEngine ({ failureType, httpStatus, errors, ... })
 * @returns {Promise<Object>} The created or updated Incident document
 */
async function recordIncidentFailure({ endpoint, contract = null, checkResult }) {
  if (!endpoint || !endpoint._id) {
    throw new Error('Endpoint document with _id is required to record an incident');
  }

  const endpointId = endpoint._id;
  const failureType = checkResult.failureType || 'UNKNOWN_FAILURE';
  const errorDescription = Array.isArray(checkResult.errors) && checkResult.errors.length > 0
    ? checkResult.errors.join('; ')
    : 'Endpoint check failed';
  const now = new Date();
  const contractId = contract ? contract._id : null;

  // 1. Try to find and atomically update an existing OPEN incident for this endpoint and failure type
  let incident = await Incident.findOneAndUpdate(
    {
      endpoint: endpointId,
      failureType,
      status: 'open'
    },
    {
      $set: {
        lastSeenAt: now,
        description: errorDescription,
        contract: contractId
      },
      $inc: { occurrenceCount: 1 }
    },
    { returnDocument: 'after' }
  );

  // 2. If no OPEN incident exists, create a new one
  if (!incident) {
    const title = formatIncidentTitle(failureType, endpoint.name, checkResult.httpStatus);
    incident = await Incident.create({
      endpoint: endpointId,
      contract: contractId,
      status: 'open',
      failureType,
      title,
      description: errorDescription,
      firstSeenAt: now,
      lastSeenAt: now,
      occurrenceCount: 1
    });
    console.log(`[IncidentService] Created new OPEN incident for "${endpoint.name}" (${incident._id}): "${title}"`);
  } else {
    console.log(`[IncidentService] Updated existing OPEN incident for "${endpoint.name}" (${incident._id}) - count: ${incident.occurrenceCount}`);
  }

  return incident;
}

/**
 * Auto-resolve all open incidents for an endpoint after a healthy check.
 *
 * Recovery Policy:
 * In this initial version, a single healthy check immediately resolves all active open incidents
 * for the endpoint, setting status to 'resolved' and resolvedAt to the current timestamp.
 * Already resolved incidents are never modified.
 *
 * @param {Object} options
 * @param {string|mongoose.Types.ObjectId} options.endpointId - Endpoint ID whose open incidents should resolve
 * @returns {Promise<Object>} { resolvedCount: number, resolvedAt: Date }
 */
async function resolveEndpointIncidents({ endpointId }) {
  if (!endpointId) {
    throw new Error('endpointId is required to resolve incidents');
  }

  const now = new Date();
  const result = await Incident.updateMany(
    {
      endpoint: endpointId,
      status: 'open'
    },
    {
      $set: {
        status: 'resolved',
        resolvedAt: now
      }
    }
  );

  if (result.modifiedCount > 0) {
    console.log(`[IncidentService] Auto-resolved ${result.modifiedCount} open incident(s) for endpoint ${endpointId}`);
  }

  return {
    resolvedCount: result.modifiedCount,
    resolvedAt: now
  };
}

module.exports = {
  recordIncidentFailure,
  resolveEndpointIncidents,
  formatIncidentTitle
};
