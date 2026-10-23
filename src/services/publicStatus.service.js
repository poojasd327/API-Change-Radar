const { StatusPage } = require('../models/StatusPage');
const Endpoint = require('../models/Endpoint');
const CheckRun = require('../models/CheckRun');
const Incident = require('../models/Incident');

/**
 * Calculates a sanitized public status for a single monitored endpoint.
 *
 * Rules:
 * - Missing or stale check data (>15m, 3 missed cycles) => 'unknown'
 * - Active open incident with NETWORK_ERROR, TIMEOUT, or HTTP 5xx => 'major_outage'
 * - Active open incident with SCHEMA_VIOLATION or HTTP 4xx => 'degraded'
 * - Latest check failed (NETWORK_ERROR/TIMEOUT/5xx) => 'major_outage'
 * - Latest check failed (SCHEMA_VIOLATION/4xx) => 'degraded'
 * - Recent check healthy with no open incident => 'operational'
 * - 24-hour uptime percentage calculated only from documented CheckRuns within the window
 */
async function calculateServiceStatus(endpoint, userId, now = new Date()) {
  // Query 10 most recent checks for status and recent check history
  const recentChecksDocs = await CheckRun.find({
    endpoint: endpoint._id,
    userId
  })
    .sort({ checkedAt: -1 })
    .limit(10);

  // Query open incidents for this endpoint
  const openIncidents = await Incident.find({
    endpoint: endpoint._id,
    userId,
    status: 'open'
  });

  // Query check runs in the last 24 hours for uptime percentage
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const checks24h = await CheckRun.find({
    endpoint: endpoint._id,
    userId,
    checkedAt: { $gte: oneDayAgo }
  }).select('status checkedAt failureType httpStatus');

  let status = 'unknown';
  let lastCheckedAt = null;

  if (recentChecksDocs.length === 0) {
    status = 'unknown';
  } else {
    const latest = recentChecksDocs[0];
    lastCheckedAt = latest.checkedAt;

    const isStale = (now.getTime() - new Date(latest.checkedAt).getTime()) > 15 * 60 * 1000;

    if (isStale) {
      status = 'unknown';
    } else if (openIncidents.length > 0) {
      const hasMajorIncident = openIncidents.some(inc =>
        ['NETWORK_ERROR', 'TIMEOUT'].includes(inc.failureType) ||
        (inc.description && /5\d{2}/.test(inc.description))
      );
      status = hasMajorIncident ? 'major_outage' : 'degraded';
    } else if (latest.status === 'failed') {
      const isMajorFailure =
        ['NETWORK_ERROR', 'TIMEOUT'].includes(latest.failureType) ||
        (typeof latest.httpStatus === 'number' && latest.httpStatus >= 500);
      status = isMajorFailure ? 'major_outage' : 'degraded';
    } else if (latest.status === 'healthy') {
      status = 'operational';
    }
  }

  // Calculate 24-hour uptime percentage
  let uptimePercentage24h = null;
  if (checks24h.length > 0) {
    const healthyCount = checks24h.filter(c => c.status === 'healthy').length;
    uptimePercentage24h = Number(((healthyCount / checks24h.length) * 100).toFixed(2));
  }

  // Format bounded recent checks history (no raw errors or private data)
  const recentChecks = recentChecksDocs.map(c => {
    let checkStatus = 'operational';
    if (c.status === 'failed') {
      const isMajor = ['NETWORK_ERROR', 'TIMEOUT'].includes(c.failureType) ||
        (typeof c.httpStatus === 'number' && c.httpStatus >= 500);
      checkStatus = isMajor ? 'major_outage' : 'degraded';
    }
    return {
      timestamp: c.checkedAt,
      status: checkStatus
    };
  });

  return {
    name: endpoint.name,
    status,
    lastCheckedAt,
    uptimePercentage24h,
    recentChecks
  };
}

/**
 * Retrieves and sanitizes the public status page for a given slug.
 * Returns null if the status page does not exist or is not published.
 */
async function getPublicStatusData(slug, now = new Date()) {
  if (!slug || typeof slug !== 'string') {
    return null;
  }

  const statusPage = await StatusPage.findOne({ slug });

  // Only published status pages can be retrieved publicly
  if (!statusPage || !statusPage.isPublished) {
    return null;
  }

  // If no services are selected for publication, return clean operational empty page
  if (!Array.isArray(statusPage.selectedEndpoints) || statusPage.selectedEndpoints.length === 0) {
    return {
      title: statusPage.title,
      description: statusPage.description || null,
      systemStatus: 'operational',
      updatedAt: statusPage.updatedAt,
      services: []
    };
  }

  // Fetch only active endpoints belonging to this status page owner
  const endpoints = await Endpoint.find({
    _id: { $in: statusPage.selectedEndpoints },
    userId: statusPage.userId,
    isActive: true
  });

  // Maintain the user's selected endpoint ordering
  const endpointMap = new Map(endpoints.map(e => [e._id.toString(), e]));
  const orderedEndpoints = statusPage.selectedEndpoints
    .map(id => endpointMap.get(id.toString()))
    .filter(Boolean);

  // Map each service to its public status
  const services = await Promise.all(
    orderedEndpoints.map(ep => calculateServiceStatus(ep, statusPage.userId, now))
  );

  // Compute aggregate system status
  let systemStatus = 'operational';
  if (services.length > 0) {
    if (services.some(s => s.status === 'major_outage')) {
      systemStatus = 'major_outage';
    } else if (services.some(s => s.status === 'degraded')) {
      systemStatus = 'degraded';
    } else if (services.every(s => s.status === 'unknown')) {
      systemStatus = 'unknown';
    } else {
      systemStatus = 'operational';
    }
  }

  return {
    title: statusPage.title,
    description: statusPage.description || null,
    systemStatus,
    updatedAt: statusPage.updatedAt,
    services
  };
}

module.exports = {
  calculateServiceStatus,
  getPublicStatusData
};
