require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db');
const User = require('../models/User');
const Endpoint = require('../models/Endpoint');
const Contract = require('../models/Contract');
const CheckRun = require('../models/CheckRun');
const Incident = require('../models/Incident');

/**
 * Audits all database collections for unresolved legacy records without an assigned userId.
 * Does not modify any data.
 *
 * @returns {Promise<Object>} Summary counts of unassigned documents per collection
 */
async function auditUnresolvedLegacyRecords() {
  const unassignedFilter = {
    $or: [{ userId: null }, { userId: { $exists: false } }]
  };

  const [endpoints, contracts, checkRuns, incidents] = await Promise.all([
    Endpoint.find(unassignedFilter).select('_id name url createdAt').lean(),
    Contract.find(unassignedFilter).select('_id name endpoint version createdAt').lean(),
    CheckRun.find(unassignedFilter).select('_id endpoint status checkedAt').lean(),
    Incident.find(unassignedFilter).select('_id endpoint status failureType title lastSeenAt').lean()
  ]);

  return {
    endpoints: {
      count: endpoints.length,
      sample: endpoints.slice(0, 5)
    },
    contracts: {
      count: contracts.length,
      sample: contracts.slice(0, 5)
    },
    checkRuns: {
      count: checkRuns.length,
      sample: checkRuns.slice(0, 5)
    },
    incidents: {
      count: incidents.length,
      sample: incidents.slice(0, 5)
    },
    totalUnresolved: endpoints.length + contracts.length + checkRuns.length + incidents.length
  };
}

/**
 * Safely and idempotently assigns unresolved legacy records to a verified user account.
 * Never modifies documents that already have a valid userId.
 *
 * @param {Object} options
 * @param {string} options.targetUserIdentifier - Email or ObjectId of target user
 * @param {string} [options.endpointId] - Optional specific endpoint ID to migrate with related data
 * @returns {Promise<Object>} Migration results
 */
async function assignLegacyOwnership({ targetUserIdentifier, endpointId = null }) {
  if (!targetUserIdentifier) {
    throw new Error('targetUserIdentifier (email or ObjectId) is required');
  }

  // 1. Locate and verify target user
  let targetUser;
  if (mongoose.Types.ObjectId.isValid(targetUserIdentifier)) {
    targetUser = await User.findById(targetUserIdentifier);
  }
  if (!targetUser) {
    targetUser = await User.findOne({ email: targetUserIdentifier.trim().toLowerCase() });
  }

  if (!targetUser) {
    throw new Error(`Target user "${targetUserIdentifier}" was not found in database.`);
  }

  if (!targetUser.isActive) {
    throw new Error(`Target user "${targetUser.email}" is deactivated. Cannot assign ownership.`);
  }

  const unassignedFilter = {
    $or: [{ userId: null }, { userId: { $exists: false } }]
  };

  const endpointFilter = endpointId
    ? { _id: endpointId, ...unassignedFilter }
    : unassignedFilter;

  // 2. Identify unassigned endpoints
  const endpointsToMigrate = await Endpoint.find(endpointFilter);
  const endpointIds = endpointsToMigrate.map(e => e._id);

  // 3. Atomically assign ownership
  const [endpointResult, contractResult, checkRunResult, incidentResult] = await Promise.all([
    Endpoint.updateMany(
      { _id: { $in: endpointIds }, ...unassignedFilter },
      { $set: { userId: targetUser._id } }
    ),
    Contract.updateMany(
      { endpoint: { $in: endpointIds }, ...unassignedFilter },
      { $set: { userId: targetUser._id } }
    ),
    CheckRun.updateMany(
      { endpoint: { $in: endpointIds }, ...unassignedFilter },
      { $set: { userId: targetUser._id } }
    ),
    Incident.updateMany(
      { endpoint: { $in: endpointIds }, ...unassignedFilter },
      { $set: { userId: targetUser._id } }
    )
  ]);

  return {
    targetUser: {
      id: targetUser._id,
      email: targetUser.email,
      name: targetUser.name
    },
    migrated: {
      endpoints: endpointResult.modifiedCount,
      contracts: contractResult.modifiedCount,
      checkRuns: checkRunResult.modifiedCount,
      incidents: incidentResult.modifiedCount
    }
  };
}

// Standalone CLI execution
if (require.main === module) {
  (async () => {
    try {
      await connectDB();

      const args = process.argv.slice(2);
      let targetUserArg = process.env.ASSIGN_TO_USER;
      let endpointIdArg = null;

      for (const arg of args) {
        if (arg.startsWith('--assignToUser=')) {
          targetUserArg = arg.split('=')[1];
        } else if (arg.startsWith('--endpointId=')) {
          endpointIdArg = arg.split('=')[1];
        }
      }

      if (!targetUserArg) {
        console.log('[Migration] --- AUDIT MODE: Scanning for Unresolved Legacy Data ---');
        const audit = await auditUnresolvedLegacyRecords();
        console.log(`Unresolved Endpoints:  ${audit.endpoints.count}`);
        console.log(`Unresolved Contracts:  ${audit.contracts.count}`);
        console.log(`Unresolved CheckRuns:  ${audit.checkRuns.count}`);
        console.log(`Unresolved Incidents:  ${audit.incidents.count}`);
        console.log(`Total Unassigned:      ${audit.totalUnresolved}`);
        console.log('\n[Notice] Unresolved records are hidden from normal users and skipped by the scheduler.');
        console.log('To assign ownership to a specific user, run:');
        console.log('  npm run migrate:ownership -- --assignToUser="user@example.com"');
        console.log('Or assign a specific endpoint and its children:');
        console.log('  npm run migrate:ownership -- --assignToUser="user@example.com" --endpointId="<id>"');
      } else {
        console.log(`[Migration] --- ASSIGNMENT MODE: Assigning to user "${targetUserArg}" ---`);
        const result = await assignLegacyOwnership({
          targetUserIdentifier: targetUserArg,
          endpointId: endpointIdArg
        });
        console.log('[Migration] Success! Records migrated:');
        console.log(`  Endpoints: ${result.migrated.endpoints}`);
        console.log(`  Contracts: ${result.migrated.contracts}`);
        console.log(`  CheckRuns: ${result.migrated.checkRuns}`);
        console.log(`  Incidents: ${result.migrated.incidents}`);
      }

      await disconnectDB();
      process.exit(0);
    } catch (err) {
      console.error('[Migration] Error:', err.message);
      if (mongoose.connection.readyState !== 0) {
        await disconnectDB();
      }
      process.exit(1);
    }
  })();
}

module.exports = {
  auditUnresolvedLegacyRecords,
  assignLegacyOwnership
};
