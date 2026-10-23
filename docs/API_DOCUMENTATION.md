# APIChange Radar — Backend REST API Documentation

This document describes all implemented HTTP routes in the APIChange Radar backend.

---

## Table of Contents
1. [Overview & Conventions](#overview--conventions)
2. [Per-User Data Isolation & Ownership (Stage 2)](#per-user-data-isolation--ownership-stage-2)
3. [Health Routes](#health-routes)
4. [User Authentication Routes (Stage 1)](#user-authentication-routes-stage-1)
5. [Endpoint Management Routes (Milestone 7A & Stage 2)](#endpoint-management-routes)
6. [Check & Monitoring Routes](#check--monitoring-routes)
7. [Incident Management Routes](#incident-management-routes)
8. [Status Page Management Routes (Stage 3)](#status-page-management-routes-stage-3)
9. [Public Status API & Safe Publishing (Stage 3)](#public-status-api--safe-publishing-stage-3)
10. [Mock Product API Routes](#mock-product-api-routes)
11. [Scheduled Monitoring Architecture (Stage 2 Multi-User Safe)](#scheduled-monitoring-architecture)
12. [Legacy Data Migration Procedure](#legacy-data-migration-procedure)
13. [Security Controls & SSRF Protection](#security-controls--ssrf-protection)
14. [Security & Operational Limitations](#security--operational-limitations)

---

## Overview & Conventions

- **Base URL**: `http://localhost:5001` (default)
- **Content Type**: `application/json`
- **Authentication**: Bearer Token via HTTP Header:
  ```http
  Authorization: Bearer <your-jwt-token>
  ```
- **Standard Error Response**:
  ```json
  {
    "error": "BadRequest | Unauthorized | Forbidden | NotFound | Conflict | ServiceUnavailable | Internal Server Error",
    "message": "Human-readable description of the error"
  }
  ```
- **Data Isolation & IDOR Protection**:
  - All private monitoring resources (`endpoints`, `contracts`, `checks`, `incidents`) are strictly isolated to the authenticated individual user.
  - When querying or accessing a resource by ID, if the resource belongs to another user or does not exist, the API returns **`404 Not Found`**. This prevents Insecure Direct Object References (IDOR) and avoids disclosing the existence of other users' resources.
  - Submitting a client-provided `userId` in request bodies or query parameters is ignored or forbidden; ownership is always derived exclusively from the verified JWT payload.
- **Standard Pagination Shape**:
  ```json
  {
    "data": [ ... ],
    "pagination": {
      "total": 100,
      "page": 1,
      "limit": 20,
      "totalPages": 5,
      "hasNextPage": true,
      "hasPrevPage": false
    }
  }
  ```

---

## Per-User Data Isolation & Ownership (Stage 2)

APIChange Radar enforces complete per-user data isolation and authorization across all monitoring resources.

### Ownership Architecture
- **Individual Users**: The system is designed for individual developers and engineers. There are no organizations, shared team accounts, or cross-tenant permissions.
- **Mongoose Ownership References**: The `Endpoint`, `Contract`, `CheckRun`, and `Incident` models each declare a mandatory `userId` reference pointing to `User` (`ObjectId`, ref: `'User'`).
- **Compound Scoped Indexes**: High-performance indexes ensure multi-tenant query efficiency and safety:
  - `Endpoint`: `{ userId: 1, isActive: 1 }`, `{ userId: 1, name: 1 }`, `{ userId: 1, url: 1 }`
  - `Contract`: `{ userId: 1, endpoint: 1, isActive: 1 }`
  - `CheckRun`: `{ userId: 1, checkedAt: -1 }`, `{ userId: 1, endpoint: 1, checkedAt: -1 }`
  - `Incident`: `{ userId: 1, endpoint: 1, status: 1, failureType: 1 }`, `{ userId: 1, status: 1, lastSeenAt: -1 }`
- **Server-Derived Identity**: The owner identity is always derived exclusively from the verified JWT payload (`req.userId = user._id`). Untrusted client-supplied `userId` values in request bodies or query parameters are strictly stripped and ignored.

### Access Control Rules
| Resource Route | Authentication Required | Cross-User Access (IDOR Attempt) |
|---|---|---|
| `GET /api/endpoints` | Yes (`Bearer <token>`) | Scoped only to user's endpoints |
| `GET /api/endpoints/:id` | Yes (`Bearer <token>`) | Returns **`404 Not Found`** |
| `POST /api/endpoints` | Yes (`Bearer <token>`) | Automatically saved with authenticated `userId` |
| `PATCH /api/endpoints/:id` | Yes (`Bearer <token>`) | Returns **`404 Not Found`** |
| `POST /api/checks/mock-product` | Yes (`Bearer <token>`) | CheckRun saved with authenticated `userId` |
| `GET /api/checks/history` | Yes (`Bearer <token>`) | Scoped only to user's CheckRuns |
| `GET /api/checks/history/latest`| Yes (`Bearer <token>`) | Scoped only to user's latest CheckRun |
| `GET /api/incidents` | Yes (`Bearer <token>`) | Scoped only to user's incidents |
| `GET /api/incidents/:id` | Yes (`Bearer <token>`) | Returns **`404 Not Found`** |
| `POST /api/status-page` | Yes (`Bearer <token>`) | Automatically saved with authenticated `userId` |
| `GET /api/status-page/me` | Yes (`Bearer <token>`) | Scoped only to user's status page |
| `PATCH /api/status-page/me` | Yes (`Bearer <token>`) | Modifies only user's status page |
| `PUT /api/status-page/me/services` | Yes (`Bearer <token>`) | Rejects foreign or inactive endpoints |
| `POST /api/status-page/me/regenerate-slug` | Yes (`Bearer <token>`) | Regenerates user's public slug |
| `GET /api/public/status/:slug` | No (Public) | Read-only sanitized status for published pages |
| `GET /api/health` | No (Public) | Public service health check |
| `GET /mock-api/products/*` | No (Public) | Isolated sandbox mock products |

---

## Health Routes

### `GET /api/health`
Checks backend service availability and MongoDB connection status.

- **Request**: No parameters or body required.
- **Success Response (200 OK)**:
  ```json
  {
    "status": "healthy",
    "service": "APIChange Radar Backend",
    "timestamp": "2026-10-22T10:00:00.000Z",
    "database": {
      "status": "connected",
      "readyState": 1
    }
  }
  ```
- **Degraded Response (200 OK)**:
  ```json
  {
    "status": "degraded",
    "service": "APIChange Radar Backend",
    "timestamp": "2026-10-22T10:00:00.000Z",
    "database": {
      "status": "disconnected",
      "readyState": 0
    }
  }
  ```

---

## User Authentication Routes (Stage 1)

APIChange Radar uses JSON Web Tokens (JWT) for individual user authentication.
Requests to protected endpoints must provide the access token in the `Authorization` header:
```http
Authorization: Bearer <your-jwt-token>
```

### `POST /api/auth/register`
Registers a new individual user account. Automatically hashes the password using `bcryptjs` and returns an initial access token.

- **Request Body**:
  ```json
  {
    "name": "Jane Doe",
    "email": "jane@example.com",
    "password": "securePassword123"
  }
  ```
- **Validation Rules**:
  - `name`: String, required, trimmed, 2–50 characters.
  - `email`: String, required, valid email format, normalized to lowercase. Must be unique.
  - `password`: String, required, minimum 8 characters.
  - `role`: Public registration always defaults to `'user'`. Administrator accounts cannot be created via this endpoint.
- **Success Response (201 Created)**:
  ```json
  {
    "message": "User registered successfully",
    "user": {
      "id": "6ad9f81a0a6aa4ca9c352d50",
      "name": "Jane Doe",
      "email": "jane@example.com",
      "role": "user",
      "isActive": true,
      "createdAt": "2026-10-22T11:50:00.000Z",
      "updatedAt": "2026-10-22T11:50:00.000Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: Validation failure (missing fields, invalid email format, short password).
  - `409 Conflict`: Email is already registered (`{ "error": "Conflict", "message": "Email is already registered" }`).

---

### `POST /api/auth/login`
Authenticates an existing user via email and password, returning a signed JWT access token.

- **Request Body**:
  ```json
  {
    "email": "jane@example.com",
    "password": "securePassword123"
  }
  ```
- **Success Response (200 OK)**:
  ```json
  {
    "message": "Login successful",
    "user": {
      "id": "6ad9f81a0a6aa4ca9c352d50",
      "name": "Jane Doe",
      "email": "jane@example.com",
      "role": "user"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: Missing email or password.
  - `401 Unauthorized`: Invalid email or password, or deactivated account (`{ "error": "Unauthorized", "message": "Invalid email or password" }`).

---

### `GET /api/auth/me`
Retrieves the profile of the currently authenticated user. Requires valid Bearer token.

- **Headers**: `Authorization: Bearer <token>`
- **Success Response (200 OK)**:
  ```json
  {
    "user": {
      "id": "6ad9f81a0a6aa4ca9c352d50",
      "name": "Jane Doe",
      "email": "jane@example.com",
      "role": "user",
      "isActive": true,
      "createdAt": "2026-10-22T11:50:00.000Z",
      "updatedAt": "2026-10-22T11:50:00.000Z"
    }
  }
  ```
- **Error Responses**:
  - `401 Unauthorized`: Missing token, invalid token signature, expired token, or deactivated user.

---

### `POST /api/auth/logout`
Provides logout endpoint. As JWTs are stateless, the client should discard the token from local storage.

- **Success Response (200 OK)**:
  ```json
  {
    "message": "Logged out successfully. Please discard the authorization token on the client."
  }
  ```

---

### Controlled Platform Administrator Provisioning
Platform administrators cannot register via public endpoints. They are provisioned through a controlled CLI command:
```bash
# Via environment variables:
ADMIN_NAME="Platform Admin" ADMIN_EMAIL="admin@example.com" ADMIN_PASSWORD="securePassword123" npm run create-admin

# Or via CLI arguments:
node src/scripts/createAdmin.js --name="Platform Admin" --email="admin@example.com" --password="securePassword123"
```
- Refuses to overwrite existing accounts.
- Automatically hashes password before persisting.
- Never prints passwords or tokens in console output.

---

## Endpoint Management Routes

### `GET /api/endpoints`
Returns a paginated list of registered endpoints, sorted newest first (`createdAt: -1`). Enriched with a safe summary of the latest check run and active contract status.

- **Query Parameters**:
  - `page` *(optional, default: 1)*: Positive integer >= 1.
  - `limit` *(optional, default: 20)*: Integer between 1 and 100.
  - `isActive` *(optional)*: Filter by active status (`true` or `false`).
- **Success Response (200 OK)**:
  ```json
  {
    "data": [
      {
        "_id": "6ad9e55f6d719652df050247",
        "name": "Public Catalog Service",
        "url": "https://api.example.com/v1/products",
        "method": "GET",
        "isActive": true,
        "hasActiveContract": true,
        "latestCheck": {
          "status": "healthy",
          "failureType": null,
          "httpStatus": 200,
          "responseTimeMs": 42,
          "checkedAt": "2026-10-22T10:15:00.000Z"
        },
        "createdAt": "2026-10-22T10:00:00.000Z",
        "updatedAt": "2026-10-22T10:00:00.000Z"
      }
    ],
    "pagination": {
      "total": 1,
      "page": 1,
      "limit": 20,
      "totalPages": 1,
      "hasNextPage": false,
      "hasPrevPage": false
    }
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: Invalid `page`, `limit`, or `isActive`.
  - `503 Service Unavailable`: MongoDB disconnected.

---

### `GET /api/endpoints/:id`
Returns a single endpoint by its MongoDB ObjectId.

- **URL Parameters**:
  - `id` *(required)*: 24-character hexadecimal MongoDB ObjectId.
- **Success Response (200 OK)**:
  ```json
  {
    "_id": "6ad9e55f6d719652df050247",
    "name": "Public Catalog Service",
    "url": "https://api.example.com/v1/products",
    "method": "GET",
    "isActive": true,
    "hasActiveContract": true,
    "activeContract": {
      "_id": "6ad9e55f6d719652df050248",
      "name": "Approved Product Contract v1",
      "version": 1,
      "isActive": true
    },
    "latestCheck": {
      "status": "healthy",
      "failureType": null,
      "httpStatus": 200,
      "responseTimeMs": 42,
      "checkedAt": "2026-10-22T10:15:00.000Z"
    },
    "createdAt": "2026-10-22T10:00:00.000Z",
    "updatedAt": "2026-10-22T10:00:00.000Z"
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: Malformed ObjectId format.
  - `404 Not Found`: Endpoint does not exist.
  - `503 Service Unavailable`: MongoDB disconnected.

---

### `POST /api/endpoints`
Registers a new monitored endpoint. Enforces strict SSRF protections against internal, private, loopback, link-local, and cloud metadata destinations.

- **Request Body**:
  ```json
  {
    "name": "Weather Forecast API",
    "url": "https://api.weather.com/v1/forecast",
    "method": "GET",
    "isActive": true
  }
  ```
  - `name` *(required, string)*: 1 to 200 characters.
  - `url` *(required, string)*: Valid public HTTP/HTTPS URL. Must pass SSRF security inspection.
  - `method` *(optional, string, default: 'GET')*: One of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.
  - `isActive` *(optional, boolean, default: true)*: Active monitoring state.
  - *Prohibited fields*: Custom headers, credentials, body payloads, or database IDs are strictly rejected.
- **Success Response (201 Created)**:
  ```json
  {
    "_id": "6ad9e55f6d719652df050249",
    "name": "Weather Forecast API",
    "url": "https://api.weather.com/v1/forecast",
    "method": "GET",
    "isActive": true,
    "hasActiveContract": false,
    "createdAt": "2026-10-22T10:20:00.000Z",
    "updatedAt": "2026-10-22T10:20:00.000Z",
    "message": "Endpoint created successfully. Note: An approved contract must be registered before automated checks can run on this endpoint."
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: Missing/empty required fields, invalid URL syntax, SSRF security policy violation, unapproved fields, or unsupported method.
  - `409 Conflict`: Endpoint with identical URL or Name already exists.
  - `503 Service Unavailable`: MongoDB disconnected.

---

### `PATCH /api/endpoints/:id`
Updates approved fields on an existing endpoint (`name`, `isActive`). Allows pausing and resuming monitoring. Protected fields (`_id`, `url`, `method`, timestamps) cannot be modified.

- **URL Parameters**:
  - `id` *(required)*: 24-character hexadecimal MongoDB ObjectId.
- **Request Body** *(at least one field required)*:
  ```json
  {
    "name": "Updated Weather API Name",
    "isActive": false
  }
  ```
- **Success Response (200 OK)**:
  ```json
  {
    "_id": "6ad9e55f6d719652df050249",
    "name": "Updated Weather API Name",
    "url": "https://api.weather.com/v1/forecast",
    "method": "GET",
    "isActive": false,
    "hasActiveContract": false,
    "createdAt": "2026-10-22T10:20:00.000Z",
    "updatedAt": "2026-10-22T10:25:00.000Z"
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: Empty body, malformed ObjectId, or attempt to modify prohibited fields.
  - `404 Not Found`: Endpoint does not exist.
  - `409 Conflict`: New name conflicts with another endpoint.
  - `503 Service Unavailable`: MongoDB disconnected.

---

## Check & Monitoring Routes

### `POST /api/checks/mock-product`
Triggers an immediate contract check against the demo Mock Product API and persists a `CheckRun` document to MongoDB.

- **Request Body** *(optional)*:
  ```json
  {
    "scenario": "wrong-price-type",
    "delay": 500,
    "timeoutMs": 3000
  }
  ```
  - `scenario` *(optional)*: One of `missing-price`, `wrong-price-type`, `server-error`, `slow`.
  - `delay` *(optional, integer)*: Used with scenario `slow`.
  - `timeoutMs` *(optional, integer, default: 3000)*: Request timeout limit (50 to 10000ms).
- **Success Response (200 OK)**:
  ```json
  {
    "status": "failed",
    "failureType": "SCHEMA_VIOLATION",
    "httpStatus": 200,
    "responseTimeMs": 12,
    "schemaValid": false,
    "errors": ["Field 'price' must be of type number"],
    "checkedAt": "2026-10-22T10:30:00.000Z",
    "endpoint": "http://127.0.0.1:5001/mock-api/products/101?scenario=wrong-price-type",
    "checkRunId": "6ad9e55f6d719652df050250"
  }
  ```

---

### `GET /api/checks/history/latest`
Returns the single most recent check run across all endpoints.

- **Success Response (200 OK)**: Returns the latest `CheckRun` document populated with `endpoint` and `contract`.
- **Error Responses**:
  - `404 Not Found`: No check runs in database.
  - `503 Service Unavailable`: MongoDB disconnected.

---

### `GET /api/checks/history`
Returns paginated check runs sorted newest first (`checkedAt: -1`).

- **Query Parameters**:
  - `page` *(optional, default: 1)*: Positive integer >= 1.
  - `limit` *(optional, default: 20)*: Integer between 1 and 100.
- **Success Response (200 OK)**: Returns paginated `CheckRun` items.

---

## Incident Management Routes

### `GET /api/incidents`
Lists incidents sorted by newest activity (`lastSeenAt: -1`).

- **Query Parameters**:
  - `status` *(optional)*: `'open'` or `'resolved'`.
  - `page` *(optional, default: 1)*: Positive integer >= 1.
  - `limit` *(optional, default: 20)*: Integer between 1 and 100.
- **Success Response (200 OK)**:
  ```json
  {
    "data": [
      {
        "_id": "6ad9e55f6d719652df050255",
        "endpoint": {
          "_id": "6ad9e55f6d719652df050247",
          "name": "Public Catalog Service",
          "url": "https://api.example.com/v1/products",
          "method": "GET"
        },
        "contract": {
          "_id": "6ad9e55f6d719652df050248",
          "name": "Approved Product Contract v1",
          "version": 1
        },
        "status": "open",
        "failureType": "SCHEMA_VIOLATION",
        "title": "Schema contract violation on Public Catalog Service",
        "description": "Field 'price' must be of type number",
        "firstSeenAt": "2026-10-22T10:00:00.000Z",
        "lastSeenAt": "2026-10-22T10:30:00.000Z",
        "occurrenceCount": 4,
        "resolvedAt": null
      }
    ],
    "pagination": { ... }
  }
  ```

---

### `GET /api/incidents/:id`
Retrieves a single incident by its MongoDB ObjectId.

- **URL Parameters**:
  - `id` *(required)*: 24-character hexadecimal MongoDB ObjectId.
- **Success Response (200 OK)**: Single populated incident document.
- **Error Responses**:
  - `400 Bad Request`: Malformed ID format.
  - `404 Not Found`: Incident not found.
  - `503 Service Unavailable`: MongoDB disconnected.

---

## Status Page Management Routes (Stage 3)

All status-page management routes require user authentication via `Authorization: Bearer <token>`.
Responses on these private routes always include `Cache-Control: no-store, no-cache, must-revalidate, private` to prevent caching of administrative state.

### `POST /api/status-page`
Creates a new status page configuration for the authenticated user.
The status page is created in an **unpublished/disabled** state by default (`isPublished: false`).

- **Request Body** *(optional)*:
  ```json
  {
    "title": "Acme Platform Status",
    "description": "Real-time service health and availability."
  }
  ```
  - `title` *(optional, string)*: 1 to 100 characters. Default: `"Service Status"`.
  - `description` *(optional, string)*: Max 500 characters. Default: `""`.
  - *Note*: Ownership is derived exclusively from `req.userId`. Client-supplied `userId` or `isPublished` values are ignored.
- **Success Response (201 Created)**:
  ```json
  {
    "_id": "6ada10a01234567890abcdef",
    "userId": "6ada0de2c4503cc07ecb49c1",
    "slug": "8d3e91b24f5a6c789012",
    "title": "Acme Platform Status",
    "description": "Real-time service health and availability.",
    "isPublished": false,
    "selectedEndpoints": [],
    "createdAt": "2026-10-22T13:40:00.000Z",
    "updatedAt": "2026-10-22T13:40:00.000Z"
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: Invalid title or description lengths.
  - `401 Unauthorized`: Missing or invalid Bearer token.
  - `409 Conflict`: A status page already exists for this user account.

---

### `GET /api/status-page/me`
Retrieves the authenticated user's current status page configuration, including populated selected endpoints.

- **Headers**: `Authorization: Bearer <token>`
- **Success Response (200 OK)**:
  ```json
  {
    "_id": "6ada10a01234567890abcdef",
    "userId": "6ada0de2c4503cc07ecb49c1",
    "slug": "8d3e91b24f5a6c789012",
    "title": "Acme Platform Status",
    "description": "Real-time service health and availability.",
    "isPublished": false,
    "selectedEndpoints": [
      {
        "_id": "6ada0de3c4503cc07ecb49c6",
        "name": "Public Catalog Service",
        "method": "GET",
        "isActive": true
      }
    ],
    "createdAt": "2026-10-22T13:40:00.000Z",
    "updatedAt": "2026-10-22T13:40:00.000Z"
  }
  ```
- **Error Responses**:
  - `401 Unauthorized`: Missing or invalid Bearer token.
  - `404 Not Found`: No status page configured for this account.

---

### `PATCH /api/status-page/me`
Updates approved status page fields (`title`, `description`, `isPublished`).

- **Headers**: `Authorization: Bearer <token>`
- **Request Body** *(at least one field required)*:
  ```json
  {
    "title": "Updated Acme Status",
    "description": "Updated availability notice",
    "isPublished": true
  }
  ```
  - `title` *(optional, string)*: 1 to 100 characters.
  - `description` *(optional, string)*: Max 500 characters.
  - `isPublished` *(optional, boolean)*: Toggles public visibility. Setting `false` immediately makes the public status page return `404 Not Found`.
- **Success Response (200 OK)**: Returns the updated status page configuration.
- **Error Responses**:
  - `400 Bad Request`: Empty body, invalid field types, or attempt to modify protected fields (`userId`, `_id`, `slug`, `selectedEndpoints`).
  - `401 Unauthorized`: Missing or invalid Bearer token.
  - `404 Not Found`: Status page not found for this account.

---

### `PUT /api/status-page/me/services`
Sets which of the authenticated user's monitored endpoints appear on the public status page.

- **Headers**: `Authorization: Bearer <token>`
- **Request Body**:
  ```json
  {
    "endpointIds": [
      "6ada0de3c4503cc07ecb49c6",
      "6ada0de3c4503cc07ecb49c9"
    ]
  }
  ```
- **Validation & Security Controls**:
  - `endpointIds` must be an array of valid MongoDB ObjectIds.
  - Duplicates are rejected with `400 Bad Request`.
  - Every ID must belong to `req.userId`. Foreign or non-existent endpoint IDs are rejected with `400 Bad Request`.
  - Inactive endpoints (`isActive: false`) cannot be selected and are rejected with `400 Bad Request`.
- **Success Response (200 OK)**: Returns the updated status page object with updated `selectedEndpoints`.
- **Error Responses**:
  - `400 Bad Request`: Malformed IDs, duplicates, inactive endpoints, or endpoints owned by another user.
  - `401 Unauthorized`: Missing or invalid Bearer token.
  - `404 Not Found`: Status page not found for this account.

---

### `POST /api/status-page/me/regenerate-slug`
Generates a new, unpredictable 20-character public slug for the status page.
Invalidates the old slug immediately.

- **Headers**: `Authorization: Bearer <token>`
- **Success Response (200 OK)**:
  ```json
  {
    "message": "Public status page slug regenerated successfully. Previous public links will no longer work.",
    "slug": "f4b7a12908c3e5d67890",
    "statusPage": { ... }
  }
  ```
- **Error Responses**:
  - `401 Unauthorized`: Missing or invalid Bearer token.
  - `404 Not Found`: Status page not found for this account.

---

## Public Status API & Safe Publishing (Stage 3)

The public status route is an unauthenticated, read-only endpoint designed to power the separate public status website.

### `GET /api/public/status/:slug`
Retrieves sanitized, public health information for an explicitly published status page.

- **Authentication**: None (Public).
- **Rate Limit**: 60 requests per minute per IP address. Exceeding triggers `429 Too Many Requests`.
- **Cache-Control**: `public, max-age=30, must-revalidate` (short-lived 30-second edge cache).
- **URL Parameters**:
  - `slug` *(required)*: Unguessable status page slug.
- **Success Response (200 OK)**:
  ```json
  {
    "title": "Acme Platform Status",
    "description": "Real-time service health and availability.",
    "systemStatus": "operational",
    "updatedAt": "2026-10-22T13:40:00.000Z",
    "services": [
      {
        "name": "Public Catalog Service",
        "status": "operational",
        "lastCheckedAt": "2026-10-22T13:35:00.000Z",
        "uptimePercentage24h": 100.0,
        "recentChecks": [
          {
            "timestamp": "2026-10-22T13:35:00.000Z",
            "status": "operational"
          },
          {
            "timestamp": "2026-10-22T13:30:00.000Z",
            "status": "operational"
          }
        ]
      }
    ]
  }
  ```
- **Error Responses**:
  - `404 Not Found`: Returned when the slug does not exist, is invalid, OR when the status page has `isPublished: false`. This avoids disclosing whether a private status page exists.
    ```json
    {
      "error": "NotFound",
      "message": "Status page not found or is currently private"
    }
    ```
  - `429 Too Many Requests`: Triggered when the per-IP rate limit is exceeded.
    ```json
    {
      "error": "TooManyRequests",
      "message": "Too many requests to public status. Please try again later."
    }
    ```

---

### Public Status Calculation & Mapping Rules

Public status is calculated in `src/services/publicStatus.service.js` based on documented, deterministic rules:

| Condition | Public Service Status | System Status Impact |
|---|---|---|
| No check records exist, or most recent check is > 15 minutes old (> 3 missed 5-minute scheduler cycles) | `unknown` | Evaluates to `unknown` if all services are unknown |
| Active open incident with `NETWORK_ERROR`, `TIMEOUT`, or HTTP 5xx | `major_outage` | Promotes overall `systemStatus` to `major_outage` |
| Active open incident with `SCHEMA_VIOLATION` or HTTP 4xx | `degraded` | Promotes overall `systemStatus` to `degraded` |
| Most recent check failed with `NETWORK_ERROR`, `TIMEOUT`, or HTTP 5xx | `major_outage` | Promotes overall `systemStatus` to `major_outage` |
| Most recent check failed with `SCHEMA_VIOLATION` or HTTP 4xx | `degraded` | Promotes overall `systemStatus` to `degraded` |
| Most recent check healthy (`status: "healthy"`) with no open incidents | `operational` | `operational` |

#### Uptime Percentage Calculation
- **Time Window**: Exactly the last 24 hours (`checkedAt >= now - 24 hours`).
- **Formula**: `(healthyChecks / totalEligibleChecks) * 100`, rounded to two decimal places.
- **Missing Data Handling**: If no checks occurred within the 24-hour window, `uptimePercentage24h` is set to `null` (never assumed or fabricated).

---

### Strict Data Sanitization Guarantees

The public status serializer strictly enforces field-level sanitization. The following internal and private data points are **guaranteed never to appear in public responses**:
1. **User Identity**: No `userId`, user account names, or email addresses.
2. **Endpoints & Network Details**: No private endpoint URLs, hostnames, IP addresses, ports, or paths.
3. **Credentials & Headers**: No authentication headers, API keys, cookies, or authorization tokens.
4. **Contract Specifications**: No JSON schemas, Ajv rules, or expected payload definitions.
5. **Database Identifiers**: No internal MongoDB `_id` values for endpoints, contracts, check runs, or incidents.
6. **Error Messages & Diagnostics**: No raw error strings, stack traces, schema violation descriptions, or incident titles.
7. **Unpublished Services**: Only services explicitly selected in `selectedEndpoints` and confirmed `isActive: true` are displayed. Endpoints belonging to other users can never be queried or published.

---

## Mock Product API Routes

- `GET /mock-api/products`: Returns list of mock catalog products.
- `GET /mock-api/products/:id`: Returns product details. Supports simulation query parameters:
  - `?scenario=missing-price`: Returns product object omitting required `price`.
  - `?scenario=wrong-price-type`: Returns product object with `price` as string instead of number.
  - `?scenario=server-error`: Returns HTTP 500 JSON error.
  - `?scenario=slow&delay=1000`: Responds with valid product after bounded delay.

---

## Security Controls & SSRF Protection

All endpoints registered via `POST /api/endpoints` are subject to strict Server-Side Request Forgery (SSRF) controls implemented in `src/services/ssrfProtection.service.js`:

1. **Protocol Restriction**: Only `http:` and `https:` schemes are permitted. Schemes such as `file:`, `ftp:`, `gopher:`, and `javascript:` are blocked.
2. **Credential Sanitization**: URLs containing embedded userinfo (`user:pass@host`) are rejected.
3. **Loopback & Private Address Blocking**:
   - Loopback: `127.0.0.0/8`, `::1`, `0.0.0.0/8`, and alternative octal/hex representations.
   - Private Networks (RFC 1918): `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
   - IPv6 Unique Local: `fc00::/7`.
   - Link-Local & Cloud Metadata IMDS: `169.254.0.0/16`, `fe80::/10`.
   - Carrier-Grade NAT: `100.64.0.0/10`.
   - Multicast & Reserved: `224.0.0.0/4`, `240.0.0.0/4`, `ff00::/8`.
4. **Prohibited Hostnames & Domains**:
   - `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`.
   - Cloud instance metadata services: `metadata.google.internal`, `metadata.goog`, `instance-data`.
5. **DNS Resolution Verification**:
   - Every submitted domain name is resolved via DNS before persistence.
   - Every resolved IPv4 and IPv6 address is evaluated. If any resolved address belongs to a prohibited or private range, the request is rejected with HTTP 400.
6. **No Secret Leaking**:
   - Error messages convey validation failures without disclosing internal server topology, private IP configurations, or credentials.

### Outbound Connection-Time Security Hardening (Milestone 7B)

All automated check runs and contract inspections executed by the detection engine (`src/services/detectionEngine.service.js`) use hardened socket-level request controls (`safeHttpRequest`):

1. **DNS Rebinding Defense (Connection-Time IP Validation)**:
   - Replaces unvalidated client fetch with connection-time socket lookup (`createSafeLookup`).
   - Intercepts DNS resolution immediately before the TCP connection is formed.
   - Evaluates all resolved A and AAAA records against prohibited subnets (loopback, private RFC 1918, link-local, cloud metadata IMDS).
   - If an attacker domain changes its DNS response (rebinding) after registration to point to an internal/private address, the connection is aborted with `NETWORK_ERROR` before any socket is established.
   - Preserves full TLS SNI, certificate validation, and `Host` headers.
2. **Safe Redirect Interception**:
   - Disables automatic blind redirect following.
   - Resolves relative `Location` headers against the active request URL.
   - Inspects every redirect destination against SSRF policies before connecting.
   - Blocks redirects to loopback (`127.0.0.1`), private networks, and cloud metadata (`169.254.169.254`).
   - Prevents redirect loops using a visited URL tracking set.
   - Limits maximum redirect hops (default: 5).
   - Strips sensitive authentication headers (`Authorization`, `Cookie`) on cross-origin redirects.

---

## Scheduled Monitoring Architecture (Stage 2 Multi-User Safe)

The background scheduler (`src/services/scheduler.service.js`) executes automated API monitoring runs according to a cron schedule (default: `*/5 * * * *`, every 5 minutes).

### Multi-User Isolation Guarantees
1. **Trusted Internal Context**: The scheduler runs as an internal trusted background process. It does not synthesize or forge JWTs; instead, it enforces resource boundaries through document relationships.
2. **Owned-Only Querying**: The scheduler queries active endpoints where ownership is verified:
   ```javascript
   { isActive: true, userId: { $ne: null, $exists: true } }
   ```
   Endpoints without a valid owner (`userId: null` or missing) are skipped automatically.
3. **Owner Identity Propagation**: When the scheduler runs a check on an endpoint, it propagates `endpoint.userId` into the created `CheckRun` document:
   ```javascript
   await CheckRun.create({
     userId: endpoint.userId,
     endpoint: endpoint._id,
     contract: contract._id,
     ...
   });
   ```
4. **Isolated Incident Lifecycle**:
   - When a check fails, `recordIncidentFailure` finds or creates open incidents scoped strictly to `{ endpoint: endpoint._id, userId: endpoint.userId, failureType, status: 'open' }`.
   - When a check passes, `resolveEndpointIncidents` auto-resolves incidents scoped strictly to `{ endpoint: endpoint._id, userId: endpoint.userId, status: 'open' }`.
   - Resolving incidents for User Alice will never modify, resolve, or affect User Bob's open incidents.

---

## Legacy Data Migration Procedure

Before Stage 2, records created in earlier milestones lacked an owner reference (`userId: null`). APIChange Radar provides a safe, idempotent, non-destructive migration script in `src/scripts/migrateLegacyOwnership.js`.

### Safety Guarantees
- **No Automatic Assignment**: Legacy records are never silently assigned to an arbitrary user or platform admin.
- **No Data Deletion**: Unowned records are never deleted.
- **Isolation During Transition**: Until an operator reviews and assigns ownership, unowned records remain hidden from normal user APIs and excluded from the background scheduler.
- **Idempotent**: Safe to run repeatedly without modifying already-owned documents.

### Step 1: Run an Audit
Inspect the database for unowned legacy records without making any modifications:
```bash
npm run migrate:ownership
# or
node src/scripts/migrateLegacyOwnership.js
```
The script will output an audit summary:
```text
[Migration] AUDIT REPORT — Unresolved Legacy Records Without Owner:
  Endpoints without owner:   2
  Contracts without owner:   2
  CheckRuns without owner:   5
  Incidents without owner:   1
Total unresolved legacy records: 10
```

### Step 2: Assign Ownership
Once the operator verifies which user account legitimately owns the resources, run the assignment with the target user's email or MongoDB ObjectId:
```bash
node src/scripts/migrateLegacyOwnership.js --assignToUser=alice@example.com
# or
node src/scripts/migrateLegacyOwnership.js --assignToUser=6ada0ec41584...
```
The script will safely assign ownership to all unowned records and report back:
```text
[Migration] Backfill completed successfully for user "alice@example.com" (ID: 6ada0ec4...):
  Endpoints updated: 2
  Contracts updated: 2
  CheckRuns updated: 5
  Incidents updated: 1
```

### Backup & Recovery Precautions
Before executing ownership assignment on a production database:
1. Create a point-in-time MongoDB backup: `mongodump --uri="<MONGODB_URI>" --out="./backup-$(date +%F)"`
2. Run the audit mode first to inspect the counts.
3. Test the assignment against a staging clone before applying to production.

---

## Security & Operational Limitations

1. **Individual User Focus**: Currently, the platform supports only individual accounts. There are no organization hierarchies, multi-user teams, or role-based access control within an account.
2. **Contracts Management**: Contracts are managed in conjunction with their associated monitored endpoints. A user cannot view, associate, or modify contracts for endpoints belonging to another user.
3. **Mock Sandbox Endpoints**: Routes under `/mock-api/products/*` are intentionally public sandbox endpoints used for testing and simulation. They do not store or expose any private user data.
4. **Platform Administrator Access**: Platform administrators have administrative capabilities for system maintenance, but regular monitoring routes enforce per-user scoping based on `req.userId`. Cross-user data access is not exposed on public monitoring routes.
