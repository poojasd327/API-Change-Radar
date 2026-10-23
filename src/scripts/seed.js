require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db');
const Endpoint = require('../models/Endpoint');
const Contract = require('../models/Contract');
const { productSchema } = require('../contracts/product.schema');

/**
 * Idempotently seeds the initial demo Endpoint and approved Contract.
 * Running this multiple times will never create duplicate documents.
 */
async function seedDemoData(userId = null) {
  const port = process.env.PORT || 5001;
  const demoUrl = process.env.MOCK_API_BASE_URL || `http://127.0.0.1:${port}/mock-api/products/101`;
  const endpointName = 'Mock Product API - Item 101';
  const contractName = 'Approved Product Schema v1';

  // 1. Find or create the demo Endpoint
  const endpointQuery = { name: endpointName, userId: userId || null };
  let endpoint = await Endpoint.findOne(endpointQuery);
  if (!endpoint) {
    endpoint = await Endpoint.create({
      userId: userId || null,
      name: endpointName,
      url: demoUrl,
      method: 'GET',
      isActive: true
    });
    console.log(`[Seed] Created demo Endpoint: "${endpoint.name}" (ID: ${endpoint._id}, User: ${userId || 'none'})`);
  } else {
    console.log(`[Seed] Demo Endpoint already exists: "${endpoint.name}" (ID: ${endpoint._id})`);
  }

  // 2. Find or create the approved Contract for this endpoint
  let contract = await Contract.findOne({ endpoint: endpoint._id, isActive: true });
  if (!contract) {
    contract = await Contract.create({
      userId: userId || null,
      endpoint: endpoint._id,
      name: contractName,
      schema: productSchema,
      version: 1,
      isActive: true
    });
    console.log(`[Seed] Created approved Contract: "${contract.name}" (ID: ${contract._id}, User: ${userId || 'none'})`);
  } else {
    console.log(`[Seed] Approved Contract already exists: "${contract.name}" (ID: ${contract._id})`);
  }

  return { endpoint, contract };
}

// Allow direct execution from command line (e.g. npm run seed)
if (require.main === module) {
  (async () => {
    try {
      await connectDB();
      await seedDemoData();
      await disconnectDB();
      console.log('[Seed] Seeding completed successfully.');
      process.exit(0);
    } catch (err) {
      console.error('[Seed] Seeding failed:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = {
  seedDemoData
};
