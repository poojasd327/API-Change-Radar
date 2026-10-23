const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const User = require('../src/models/User');
const { generateToken, verifyToken, sanitizeUser, getJwtSecret } = require('../src/services/auth.service');
const { requireAuth, requireAdmin } = require('../src/middleware/auth.middleware');
const { provisionAdminUser } = require('../src/scripts/createAdmin');

test('Stage 1: Individual User Authentication Suite', async (t) => {
  let mongod;
  let server;
  let baseUrl;

  // Spin up isolated in-memory MongoDB and ephemeral HTTP test server
  mongod = await MongoMemoryServer.create();
  const mongoUri = mongod.getUri();
  await mongoose.connect(mongoUri);

  // Set test JWT secret
  process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only-12345';
  process.env.JWT_EXPIRES_IN = '1h';

  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    if (server) server.close();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongod) await mongod.stop();
  });

  // --- 1. USER MODEL & DATA INTEGRITY TESTS ---

  await t.test('1. User model enforces required fields, defaults, and email normalization', async () => {
    // Missing required fields
    const emptyUser = new User({});
    await assert.rejects(
      async () => await emptyUser.validate(),
      (err) => {
        assert.ok(err.errors.name, 'name error should exist');
        assert.ok(err.errors.email, 'email error should exist');
        assert.ok(err.errors.password, 'password error should exist');
        return true;
      }
    );

    // Invalid email format
    const badEmailUser = new User({
      name: 'Invalid Email User',
      email: 'not-an-email',
      password: 'validPassword123'
    });
    await assert.rejects(
      async () => await badEmailUser.validate(),
      (err) => {
        assert.ok(err.errors.email, 'email validation error expected');
        return true;
      }
    );

    // Short password
    const shortPassUser = new User({
      name: 'Short Pass',
      email: 'short@example.com',
      password: '123'
    });
    await assert.rejects(
      async () => await shortPassUser.validate(),
      (err) => {
        assert.ok(err.errors.password, 'password minlength validation error expected');
        return true;
      }
    );

    // Valid user with email normalization
    const user = await User.create({
      name: '  Alice Developer  ',
      email: '  Alice.Dev@EXAMPLE.COM  ',
      password: 'superSecretPassword123'
    });

    assert.equal(user.name, 'Alice Developer', 'Name should be trimmed');
    assert.equal(user.email, 'alice.dev@example.com', 'Email should be trimmed and lowercase');
    assert.equal(user.role, 'user', 'Default role should be "user"');
    assert.equal(user.isActive, true, 'Default isActive should be true');
    assert.ok(user.createdAt, 'createdAt timestamp should exist');
    assert.ok(user.updatedAt, 'updatedAt timestamp should exist');
  });

  await t.test('2. Password is automatically hashed and verified via comparePassword', async () => {
    const rawPassword = 'mySecurePassword888';
    const user = await User.create({
      name: 'Bob Tester',
      email: 'bob@example.com',
      password: rawPassword
    });

    // Verify raw password is never stored plaintext in DB
    const userInDb = await User.findById(user._id).select('+password');
    assert.notEqual(userInDb.password, rawPassword, 'Password must not be stored in plaintext');
    assert.ok(userInDb.password.startsWith('$2'), 'Password must be a bcrypt hash');

    // Verify comparePassword method
    const isMatch = await userInDb.comparePassword(rawPassword);
    assert.equal(isMatch, true, 'comparePassword should return true for correct password');

    const isWrongMatch = await userInDb.comparePassword('wrongPassword123');
    assert.equal(isWrongMatch, false, 'comparePassword should return false for incorrect password');
  });

  await t.test('3. User model and toJSON strip password and internal versioning', async () => {
    const user = await User.create({
      name: 'Charlie Safe',
      email: 'charlie@example.com',
      password: 'passwordSafety123'
    });

    // Default query excludes password
    const fetched = await User.findById(user._id);
    assert.equal(fetched.password, undefined, 'Default find query must not include password');

    // toJSON strips password even if selected
    const selected = await User.findById(user._id).select('+password');
    const json = selected.toJSON();
    assert.equal(json.password, undefined, 'toJSON must strip password');
    assert.equal(json.__v, undefined, 'toJSON must strip __v');
  });

  // --- 2. REGISTRATION ENDPOINT TESTS ---

  await t.test('4. POST /api/auth/register creates new individual user and returns JWT token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Diana Prince',
        email: 'diana@example.com',
        password: 'amazonWarriorPassword99'
      })
    });

    assert.equal(res.status, 201, 'Should return 201 Created');
    const data = await res.json();

    assert.equal(data.message, 'User registered successfully');
    assert.ok(data.user, 'Response should contain user object');
    assert.equal(data.user.name, 'Diana Prince');
    assert.equal(data.user.email, 'diana@example.com');
    assert.equal(data.user.role, 'user');
    assert.equal(data.user.password, undefined, 'Password must never leak in response');
    assert.ok(data.token, 'Response must contain JWT token');

    // Verify token claims
    const decoded = verifyToken(data.token);
    assert.equal(decoded.userId, data.user.id);
    assert.equal(decoded.email, 'diana@example.com');
    assert.equal(decoded.role, 'user');
  });

  await t.test('5. POST /api/auth/register enforces strict input validation', async () => {
    // Missing name
    const resNoName = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'noname@example.com',
        password: 'validPassword123'
      })
    });
    assert.equal(resNoName.status, 400);
    const bodyNoName = await resNoName.json();
    assert.equal(bodyNoName.error, 'BadRequest');

    // Invalid email
    const resBadEmail = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad Email',
        email: 'invalid-email-address',
        password: 'validPassword123'
      })
    });
    assert.equal(resBadEmail.status, 400);

    // Password too short (<8 chars)
    const resShortPass = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Short Pass',
        email: 'shortpass@example.com',
        password: 'short'
      })
    });
    assert.equal(resShortPass.status, 400);
    const bodyShort = await resShortPass.json();
    assert.ok(bodyShort.message.includes('8 characters'));
  });

  await t.test('6. POST /api/auth/register rejects duplicate emails safely', async () => {
    // Attempt to register with duplicate email (case-insensitive test)
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Diana Imposter',
        email: 'DIANA@EXAMPLE.COM', // exact duplicate of diana@example.com
        password: 'anotherPassword123'
      })
    });

    assert.equal(res.status, 409, 'Should return 409 Conflict');
    const data = await res.json();
    assert.equal(data.error, 'Conflict');
    assert.equal(data.message, 'Email is already registered');
  });

  // --- 3. LOGIN ENDPOINT TESTS ---

  await t.test('7. POST /api/auth/login authenticates valid user and returns token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'diana@example.com',
        password: 'amazonWarriorPassword99'
      })
    });

    assert.equal(res.status, 200, 'Should return 200 OK');
    const data = await res.json();
    assert.equal(data.message, 'Login successful');
    assert.ok(data.token, 'Should return valid token');
    assert.equal(data.user.email, 'diana@example.com');
    assert.equal(data.user.password, undefined, 'Password must not leak');
  });

  await t.test('8. POST /api/auth/login rejects incorrect password with generic error', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'diana@example.com',
        password: 'incorrectPassword123'
      })
    });

    assert.equal(res.status, 401, 'Should return 401 Unauthorized');
    const data = await res.json();
    assert.equal(data.error, 'Unauthorized');
    assert.equal(data.message, 'Invalid email or password');
  });

  await t.test('9. POST /api/auth/login rejects non-existent email with generic error', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'nobody@example.com',
        password: 'somePassword123'
      })
    });

    assert.equal(res.status, 401, 'Should return 401 Unauthorized');
    const data = await res.json();
    assert.equal(data.error, 'Unauthorized');
    // Prevents user enumeration by keeping message identical to incorrect password
    assert.equal(data.message, 'Invalid email or password');
  });

  await t.test('10. POST /api/auth/login rejects deactivated user account', async () => {
    const deactivatedUser = await User.create({
      name: 'Deactivated User',
      email: 'deactivated@example.com',
      password: 'password123456',
      isActive: false
    });

    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'deactivated@example.com',
        password: 'password123456'
      })
    });

    assert.equal(res.status, 401, 'Should return 401 Unauthorized for deactivated account');
    const data = await res.json();
    assert.equal(data.error, 'Unauthorized');
    assert.equal(data.message, 'Invalid email or password');
  });

  // --- 4. CURRENT USER PROFILE (GET /api/auth/me) & MIDDLEWARE TESTS ---

  await t.test('11. GET /api/auth/me retrieves current user with valid Bearer token', async () => {
    // Log in as Diana
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'diana@example.com',
        password: 'amazonWarriorPassword99'
      })
    });
    const { token } = await loginRes.json();

    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.user);
    assert.equal(data.user.email, 'diana@example.com');
    assert.equal(data.user.name, 'Diana Prince');
    assert.equal(data.user.role, 'user');
    assert.equal(data.user.isActive, true);
    assert.equal(data.user.password, undefined);
  });

  await t.test('12. GET /api/auth/me rejects missing, malformed, and invalid tokens', async () => {
    // Missing Authorization header
    const resMissing = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(resMissing.status, 401);
    const bodyMissing = await resMissing.json();
    assert.equal(bodyMissing.error, 'Unauthorized');

    // Malformed Authorization header (missing Bearer prefix)
    const resBadFormat = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: 'Basic someCredentials123' }
    });
    assert.equal(resBadFormat.status, 401);

    // Random invalid token
    const resInvalid = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: 'Bearer this-is-not-a-valid-jwt' }
    });
    assert.equal(resInvalid.status, 401);
    const bodyInvalid = await resInvalid.json();
    assert.ok(bodyInvalid.message.includes('Invalid or malformed'));

    // Token signed with wrong secret
    const badSecretToken = jwt.sign({ userId: 'some-id', email: 'fake@example.com' }, 'wrong-secret');
    const resBadSecret = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${badSecretToken}` }
    });
    assert.equal(resBadSecret.status, 401);
  });

  await t.test('13. GET /api/auth/me rejects expired JWT tokens with clear message', async () => {
    // Generate an already-expired token (-1s)
    const expiredUser = await User.findOne({ email: 'diana@example.com' });
    const expiredToken = generateToken(expiredUser, { expiresIn: '-1s' });

    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${expiredToken}` }
    });

    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, 'Unauthorized');
    assert.equal(data.message, 'Authentication token has expired');
  });

  await t.test('14. GET /api/auth/me rejects token if user has been deactivated in DB', async () => {
    // Create active user, generate token, then deactivate user in DB
    const tempUser = await User.create({
      name: 'Temp Deactivate',
      email: 'temp@example.com',
      password: 'password12345'
    });
    const token = generateToken(tempUser);

    // Deactivate user in DB
    tempUser.isActive = false;
    await tempUser.save();

    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.message, 'User account has been deactivated');
  });

  // --- 5. LOGOUT ENDPOINT TESTS ---

  await t.test('15. POST /api/auth/logout succeeds and provides client guidance', async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST'
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.message.includes('Logged out successfully'));
  });

  // --- 6. PLATFORM ADMIN PROVISIONING & AUTHORIZATION TESTS ---

  await t.test('16. provisionAdminUser creates platform admin and rejects duplicates', async () => {
    // First creation succeeds
    const result1 = await provisionAdminUser({
      name: 'Super Admin',
      email: 'admin@apichange-radar.local',
      password: 'superAdminMasterPassword123'
    });

    assert.equal(result1.created, true);
    assert.equal(result1.user.role, 'admin');
    assert.equal(result1.user.email, 'admin@apichange-radar.local');

    // Password must be hashed in DB
    const adminInDb = await User.findById(result1.user._id).select('+password');
    assert.ok(adminInDb.password.startsWith('$2'));

    // Second creation with same email is refused
    const result2 = await provisionAdminUser({
      name: 'Duplicate Admin',
      email: 'ADMIN@apichange-radar.local',
      password: 'differentPassword123'
    });

    assert.equal(result2.created, false);
    assert.ok(result2.message.includes('already exists'));
  });

  await t.test('17. requireAdmin middleware restricts access to admins only', async () => {
    // 1. Normal user (role: 'user') is rejected with 403 Forbidden
    let forbiddenStatus = null;
    let forbiddenBody = null;
    let forbiddenNextCalled = false;

    const normalReq = {
      user: { role: 'user', email: 'diana@example.com' }
    };
    const normalRes = {
      status(code) {
        forbiddenStatus = code;
        return {
          json(data) {
            forbiddenBody = data;
            return this;
          }
        };
      }
    };
    const normalNext = () => {
      forbiddenNextCalled = true;
    };

    requireAdmin(normalReq, normalRes, normalNext);

    assert.equal(forbiddenStatus, 403, 'Normal user should receive 403 Forbidden');
    assert.equal(forbiddenBody.error, 'Forbidden');
    assert.equal(forbiddenBody.message, 'Administrator privileges are required');
    assert.equal(forbiddenNextCalled, false, 'next() must not be called when forbidden');

    // 2. Admin user (role: 'admin') passes check and calls next()
    let adminNextCalled = false;
    const adminReq = {
      user: { role: 'admin', email: 'admin@apichange-radar.local' }
    };
    const adminRes = {};
    const adminNext = () => {
      adminNextCalled = true;
    };

    requireAdmin(adminReq, adminRes, adminNext);
    assert.equal(adminNextCalled, true, 'next() must be called for admin users');

    // 3. Request without user object is rejected
    let unauthStatus = null;
    let unauthBody = null;
    const unauthReq = {};
    const unauthRes = {
      status(code) {
        unauthStatus = code;
        return {
          json(data) {
            unauthBody = data;
            return this;
          }
        };
      }
    };
    requireAdmin(unauthReq, unauthRes, () => {});
    assert.equal(unauthStatus, 403, 'Unauthenticated request should receive 403 Forbidden');
    assert.equal(unauthBody.error, 'Forbidden');
  });
});
