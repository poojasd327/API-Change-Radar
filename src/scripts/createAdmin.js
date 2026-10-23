require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db');
const User = require('../models/User');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/**
 * Parses CLI arguments in the format --key=value or --key value
 */
function parseCliArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const equalsIdx = arg.indexOf('=');
      if (equalsIdx !== -1) {
        const key = arg.slice(2, equalsIdx);
        const val = arg.slice(equalsIdx + 1);
        args[key] = val;
      } else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
        const key = arg.slice(2);
        args[key] = process.argv[i + 1];
        i++;
      }
    }
  }
  return args;
}

/**
 * Securely provisions a platform administrator user.
 * Refuses to create duplicate accounts or overwrite existing users.
 * Never logs plaintext passwords or generated tokens.
 *
 * @param {object} params
 * @param {string} params.name - Full name of admin
 * @param {string} params.email - Admin email address
 * @param {string} params.password - Admin password (min 8 chars)
 * @returns {Promise<{ created: boolean, user?: object, message: string }>}
 */
async function provisionAdminUser({ name, email, password }) {
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    throw new Error('Admin name is required and must be at least 2 characters long');
  }

  if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
    throw new Error('A valid admin email address is required');
  }

  if (!password || typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Admin password is required and must be at least ${MIN_PASSWORD_LENGTH} characters long`);
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Check if user already exists
  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    return {
      created: false,
      user: existingUser,
      message: `User with email "${normalizedEmail}" already exists. Refusing duplicate provisioning.`
    };
  }

  // Create admin user (password is automatically hashed by User pre-save hook)
  const user = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    password,
    role: 'admin',
    isActive: true
  });

  return {
    created: true,
    user,
    message: `Platform admin "${user.name}" (${user.email}) successfully created.`
  };
}

// Standalone CLI execution
if (require.main === module) {
  (async () => {
    try {
      const cliArgs = parseCliArgs();

      const name = process.env.ADMIN_NAME || cliArgs.name;
      const email = process.env.ADMIN_EMAIL || cliArgs.email;
      const password = process.env.ADMIN_PASSWORD || cliArgs.password;

      if (!name || !email || !password) {
        console.error('[Admin Provision] Error: Missing required credentials.');
        console.error('Provide credentials via environment variables (ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD)');
        console.error('Or via CLI flags: node src/scripts/createAdmin.js --name="Admin" --email="admin@example.com" --password="secretpassword"');
        process.exit(1);
      }

      await connectDB();

      const result = await provisionAdminUser({ name, email, password });

      if (result.created) {
        console.log(`[Admin Provision] SUCCESS: ${result.message} [ID: ${result.user._id}]`);
      } else {
        console.warn(`[Admin Provision] WARNING: ${result.message}`);
      }

      await disconnectDB();
      process.exit(0);
    } catch (err) {
      console.error('[Admin Provision] Error:', err.message);
      if (mongoose.connection.readyState !== 0) {
        await disconnectDB();
      }
      process.exit(1);
    }
  })();
}

module.exports = {
  provisionAdminUser
};
