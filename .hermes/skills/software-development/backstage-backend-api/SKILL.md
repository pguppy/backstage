---
name: backstage-backend-api
description: "Use when building ANY backend API route or endpoint in a Backstage backend plugin. Covers the complete request pipeline: what middleware Backstage applies automatically (credentials validation, rate limiting, error handling, logging, CORS, compression, lifecycle gating), what you MUST implement yourself, and what is optional. Based on deep source-code analysis of the rootHttpRouter and httpRouter service factories, MiddlewareFactory, credentials barrier, and the catalog plugin reference implementation."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, backend, api, express, middleware, router, http, routes]
    related_skills: [backstage-plugin-blueprint, backstage-core-services, backstage-auth-permissions, backstage-testing, backstage-catalog-system, backstage-cli]
---

# Backstage Backend API Development

## ⛔ FORBIDDEN PATTERNS — Check These FIRST

Before writing any backend code, verify these two violations do not exist:

```bash
# 1. Never use process.env — must use config.getString()
grep -rn "process.env" plugins/<id>-backend/src/ && echo "VIOLATION: process.env found" || echo "OK"

# 2. Never use express.Router() — must use createOpenApiRouter()
grep -rn "= Router()" plugins/<id>-backend/src/ | grep -v generated && echo "VIOLATION: express.Router found" || echo "OK"

# 3. Never wrap routes in try/catch — the framework handles errors
# The httpRouter error handler auto-maps @backstage/errors types to HTTP codes:
#   InputError→400, AuthenticationError→401, NotAllowedError→403,
#   NotFoundError→404, ConflictError→409, ServiceUnavailableError→503
# Throw these types instead of catching and manually setting res.status()
grep -rn "catch.*res\.status" plugins/<id>-backend/src/router.ts && echo "VIOLATION: manual error handling found" || echo "OK"
```

**These are zero-tolerance violations.** If either grep returns a match, fix immediately. The code-review skill (D2) independently verifies both.

---

## The Core Rule

Backstage's middleware chain handles **12 layers** of HTTP infrastructure automatically. You write only Express route handlers, auth policy exceptions, and permission checks. Everything else is built-in.

## The Most Important Rule: OpenAPI Router, Not Express Router 🔴

**Never create a router with `express.Router()`.** Always use the generated `createOpenApiRouter()` from your OpenAPI spec. The generated router provides:
- **Automatic request validation** — missing required params, wrong types, invalid enums → automatic `InputError` (400)
- **Typed request objects** — `req.query.enterprise` is typed as `string`, not `string | undefined`
- **OpenAPI spec serving** at `/openapi.json` for API documentation
- **Consistent error responses** in Backstage's standard format

```ts
// ❌ WRONG — bypasses all validation, forces manual type casting
import { Router } from 'express';
const router = Router();

// ✅ CORRECT — validation is automatic, types are correct
import { createOpenApiRouter } from './schema/openapi/generated';
const router = await createOpenApiRouter();
```

**Config access: `config.getString()`, never `process.env`:**
```ts
// ❌ WRONG — bypasses config schema, secret masking, validation
const token = process.env.GITHUB_TOKEN;

// ✅ CORRECT — goes through Backstage config service
// Configure in app-config.yaml: integrations.github[0].token: ${GITHUB_TOKEN}
const token = config.getString('integrations.github.0.token');
```

## The Two-Layer Middleware Pipeline

### Root-Level (applied once per backend process)

Source: `packages/backend-defaults/src/entrypoints/rootHttpRouter/rootHttpRouterServiceFactory.ts`

```text
ORDER  MIDDLEWARE                     CONFIG KEY                YOUR WORK
───    ───────────────────────────    ──────────────────────    ─────────
 1     Helmet (security headers)      backend.csp               Config only
 2     CORS                           backend.cors              Config only
 3     Compression (gzip)             —                         Nothing
 4     Request logging                —                         Nothing
 5     Global rate limiting           backend.rateLimit         Config only
 6     Health routes                  backend.health            Nothing
 7     Plugin routing dispatch        —                         Nothing
 8     404 handler                    —                         Nothing
 9     Error serializer               —                         Nothing
```

The error serializer auto-maps `@backstage/errors` types to HTTP status codes:
`InputError`→400, `AuthenticationError`→401, `NotAllowedError`→403, `NotFoundError`→404, `ConflictError`→409, `NotModifiedError`→304, `ServiceUnavailableError`→503, catch-all→500.

### Per-Plugin Level (applied when your plugin uses `httpRouter`)

Source: `packages/backend-defaults/src/entrypoints/httpRouter/httpRouterServiceFactory.ts`

```text
ORDER  MIDDLEWARE                     WHAT IT DOES                            YOUR CODE?
───    ───────────────────────────    ────────────────────────────────────    ─────────
 1     Per-plugin rate limiting       Throttles if config key exists          Config only
 2     Auth integration router        /.backstage/auth/v1/jwks.json          NOTHING
 3     Lifecycle middleware           Pauses requests until plugin started    NOTHING
 4     CREDENTIALS BARRIER            Validates auth on EVERY request         NOTHING*
 5     Cookie auth refresh            /.backstage/auth/v1/cookie GET/DELETE  NOTHING
       ───── YOUR ROUTES HERE ─────   ← THIS IS WHERE YOU WRITE CODE         YES
 6     Error handler                  Backstage error → HTTP status code     NOTHING
```

**\*Exception:** Only add routes that skip auth. Call `httpRouter.addAuthPolicy()` for those.

## What You NEVER Implement

This list is exhaustive. Backstage handles ALL of these — if you find yourself writing code for any of them, stop: you're duplicating framework behavior.

- Token validation/verification
- JWKS key endpoint
- Cookie auth flow (issue, refresh, clear)
- Request logging (Apache-combine format)
- gzip compression
- CORS headers
- Security headers (Helmet/CSP)
- Rate limiting
- Startup/shutdown readiness gating (requests pause during init, reject during shutdown)
- Error-to-HTTP-status-code mapping
- Error response body formatting (`ErrorResponseBody` shape)
- Plugin URL path prefixing (`/api/<pluginId>` is automatic)
- **`process.env`** — use `config.getString()`. Config goes through app-config.yaml with `${ENV}` substitution, config schema, and secret masking. Direct env access bypasses all of this.
- **`express.Router()`** — use `createOpenApiRouter()` from your generated OpenAPI spec. The generated router auto-validates requests and provides typed request/response objects.
- **`try/catch` with `res.status()`** — throw `@backstage/errors` types instead. The framework error handler maps `InputError`→400, `NotAllowedError`→403, `NotFoundError`→404, `ServiceUnavailableError`→503, etc.

## What You DO Implement

Only these things:

1. **OpenAPI route handlers** — your actual business logic, added to the router returned by `createOpenApiRouter()`. Throw `@backstage/errors` types for failures — the framework maps them to HTTP codes.
2. **Auth policy exceptions** — for public/unauthenticated routes (BEFORE `httpRouter.use()`)
3. **Permission checks** — using the `permissions` service
4. **Service-to-service calling** — using `discovery` + `auth` services
5. **Config access** — using `config.getString()` / `config.getOptionalString()` only
5. **Database migrations** — using `database.getClient()` + `migrate.latest()`

## The Canonical Pattern (copy this)

### Step 1: Create the Router File

```ts
// plugins/<my-plugin>-backend/src/router.ts
import { Router } from 'express';
import {
  AuthService,
  HttpAuthService,
  DiscoveryService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { NotAllowedError } from '@backstage/errors';

interface RouterOptions {
  auth: AuthService;
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  discovery: DiscoveryService;
  logger: LoggerService;
}

export function createRouter(options: RouterOptions): Router {
  const { auth, httpAuth, permissions, discovery, logger } = options;
  const router = Router();

  // PUBLIC route (no auth)
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // AUTHENTICATED route (auth handled by credentials barrier)
  router.get('/items', async (req, res) => {
    logger.info('Fetching items');
    const items = await fetchItems();
    res.json(items);
  });

  // PERMISSION-PROTECTED route
  router.get('/secret', async (req, res) => {
    const creds = await httpAuth.credentials(req);
    const [decision] = await permissions.authorize(
      [{ permission: myReadPermission }],
      { credentials: creds },
    );
    if (decision.result !== 'ALLOW') {
      throw new NotAllowedError('Access denied');
    }
    res.json({ data: 'secret' });
  });

  // SERVICE-TO-SERVICE call
  router.get('/catalog-data', async (req, res) => {
    const baseUrl = await discovery.getBaseUrl('catalog');
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: await auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });
    const resp = await fetch(`${baseUrl}/entities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(await resp.json());
  });

  return router;
}
```

### Step 2: Wire in the Plugin

```ts
// plugins/<my-plugin>-backend/src/plugin.ts
import { createBackendPlugin, coreServices } from '@backstage/backend-plugin-api';
import { resolvePackagePath } from '@backstage/backend-plugin-api';
import { createRouter } from './router';

export default createBackendPlugin({
  pluginId: 'my-plugin',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        permissions: coreServices.permissions,
        auth: coreServices.auth,
        discovery: coreServices.discovery,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        database: coreServices.database,
      },
      async init(deps) {
        // Run database migrations
        const client = await deps.database.getClient();
        if (!deps.database.migrations?.skip) {
          await client.migrate.latest({
            directory: resolvePackagePath('@internal/my-plugin-backend', 'migrations'),
          });
        }

        // Create and mount your router
        const router = createRouter(deps);

        // Carve out auth exceptions BEFORE mounting
        deps.httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });

        deps.httpRouter.use(router);
      },
    });
  },
});
```

### Step 3: Export in index.ts

```ts
// plugins/<my-plugin>-backend/src/index.ts
export { default } from './plugin';
```

## Auth Policy Reference

| Policy | Use Case | Example |
|---|---|---|
| `allow: 'unauthenticated'` | Public health check, open API | `{ path: '/health', allow: 'unauthenticated' }` |
| `allow: 'user-cookie'` | Static assets, TechDocs | `{ path: '/static/:id', allow: 'user-cookie' }` |

The **default** (no policy needed): ALL routes require user OR service credentials. Tokens are validated automatically by the credentials barrier middleware.

> **Never** call `httpAuth.credentials()` just to validate tokens — the credentials barrier already did that. Only call it when you need the credentials object for permissions or user info.

## The Full Database + API Pattern

```ts
env.registerInit({
  deps: {
    httpRouter: coreServices.httpRouter,
    httpAuth: coreServices.httpAuth,
    database: coreServices.database,
    lifecycle: coreServices.lifecycle,
    logger: coreServices.logger,
    config: coreServices.rootConfig,
  },
  async init({ httpRouter, httpAuth, database, lifecycle, logger, config }) {
    const client = await database.getClient();
    if (!database.migrations?.skip) {
      await client.migrate.latest({
        directory: resolvePackagePath('@internal/my-plugin-backend', 'migrations'),
      });
    }

    const router = Router();

    router.get('/items', async (req, res) => {
      const items = await client('items').select('*');
      res.json(items);
    });

    router.post('/items', async (req, res) => {
      const creds = await httpAuth.credentials(req);
      const [item] = await client('items').insert({
        ...req.body,
        created_by: creds.principal.userEntityRef,
      }).returning('*');
      res.status(201).json(item);
    });

    lifecycle.addShutdownHook(() => client.destroy());
    httpRouter.use(router);
  },
});
```

## Rate Limiting (Config-Only)

You never write rate-limiting code. Just configure it:

```yaml
backend:
  rateLimit:
    global: true
    window: 6s
    incomingRequestLimit: 100
    plugin:
      my-plugin:           # Per-plugin override
        window: 3s
        incomingRequestLimit: 50
```

Per-plugin rate limiting activates automatically when `backend.rateLimit.plugin.<pluginId>` exists in config — see `createRateLimitMiddleware` in the httpRouter service factory.

## OpenAPI Spec-Driven Validation (Optional, Advanced)

The catalog plugin uses this pattern. It generates a typed, auto-validating router from an OpenAPI spec.

### When to Use
- You have a large API surface with many endpoints
- You want automatic request body/query/param validation
- You need typed request/response objects
- You want auto-generated API documentation at `/openapi.json`

### When NOT to Use
- Simple 2-3 route plugins
- Prototypes or internal-only APIs
- When you're fine with manual validation

### Setup (Preferred: OpenAPI-first)

Place the spec in `<id>-common/src/schema/openapi.yaml`. Generate BOTH server and client:

```bash
# In <id>-backend/package.json, add:
"generate": "backstage-repo-tools package schema openapi generate --server --client-package plugins/<id>-common"
```

This produces typed routers in backend AND typed `DefaultApiClient` in the common package (not react — the generated client lives in common, matching the catalog-client pattern). See `backstage-feature-scaffolder` skill + `references/openapi-pattern.md` for the full catalog-derived reference.

### Manual Router (when OpenAPI isn't needed)

1. Create the spec at `schema/openapi.yaml`:

```yaml
openapi: 3.1.0
info:
  title: my-plugin
  version: '1'
paths:
  /items:
    get:
      operationId: getItems
      responses:
        '200':
          description: List of items
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Item'
    post:
      operationId: createItem
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateItemBody'
      responses:
        '201':
          description: Created
components:
  schemas:
    Item:
      type: object
      properties:
        id: { type: string }
        name: { type: string }
      required: [id, name]
    CreateItemBody:
      type: object
      properties:
        name: { type: string }
      required: [name]
```

2. Generate the typed router:

```bash
yarn backstage-cli package schema openapi generate --server
```

3. This produces `src/schema/openapi/generated/router.ts` with:
   - A `createOpenApiRouter()` function
   - Typed endpoint map with your operationIds as keys
   - Built-in `express-openapi-validator` middleware that validates every request against your spec
   - All invalid requests automatically become `InputError` (400)

4. Use it in your plugin:

```ts
import { createOpenApiRouter } from './schema/openapi/generated';

env.registerInit({
  deps: { httpRouter: coreServices.httpRouter, ... },
  async init({ httpRouter, ... }) {
    const router = await createOpenApiRouter();
    router.get('/items', async (req, res) => {
      // req.query, req.params, req.body are all validated + typed
      const items = await fetchItems();
      res.json(items);
    });
    httpRouter.use(router);
  },
});
```

The generated router already includes `json()` body parsing and OpenAPI spec serving at `/openapi.json`.

## Step-by-Step: From Scratch to Running API

```bash
# 1. Scaffold
yarn new                        # Select: backend-plugin
# Plugin ID: my-plugin

# 2. Create the router
# Write plugins/my-plugin-backend/src/router.ts (see pattern above)

# 3. Wire in plugin.ts (see pattern above)

# 4. Add migrations if needed
mkdir plugins/my-plugin-backend/migrations

# 5. Install in backend
# In packages/backend/src/index.ts:
backend.add(import('@internal/plugin-my-plugin-backend'));

# 6. Test
CI=1 yarn test plugins/my-plugin-backend

# 7. Verify
yarn tsc && yarn start
# API is now at http://localhost:7007/api/my-plugin/items
```

## Verification Checklist

- [ ] Plugin created with `yarn new`, `backend-plugin` role
- [ ] `package.json` has correct `backstage.role: backend-plugin`
- [ ] Router created in `src/router.ts`, using Express `Router`
- [ ] Plugin wires router via `httpRouter.use(router)` in `registerInit`
- [ ] Auth policies added BEFORE `httpRouter.use()` for public routes
- [ ] Permission checks use `permissions.authorize()`, not manual inspection
- [ ] Tokens generated fresh via `auth.getPluginRequestToken()`, never stored
- [ ] Database migrations run in init, not skipped unless configured
- [ ] Shutdown hooks registered for interval/connection cleanup
- [ ] Config schema in `config.d.ts` with `@visibility` annotations
- [ ] `configSchema` key in `package.json` if using config
- [ ] Default export from `src/index.ts` (the plugin instance)
- [ ] Plugin added to `packages/backend/src/index.ts`
- [ ] No manual auth validation, no manual CORS, no manual logging, no manual compression, no manual error serialization — the framework handles all of these

## Common Pitfalls

1. **Duplicating middleware** — The most common mistake. Writing your own CORS, logging, error handler, auth middleware, or compression. The framework already does ALL of these. You only write route handlers.

2. **Calling `httpAuth.credentials()` for token validation** — The credentials barrier already validated the token before your handler runs. Only call it when you need the credentials object for permissions or user info.

3. **Storing tokens** — Always call `auth.getPluginRequestToken()` immediately before each service-to-service call. Tokens expire.

4. **Forgetting auth policies for public routes** — By default, ALL routes require auth. Public routes need explicit policies via `httpRouter.addAuthPolicy()` BEFORE `httpRouter.use()`.

5. **Not running database migrations** — Call `client.migrate.latest()` in your init. Check `database.migrations?.skip`.

6. **No shutdown cleanup** — Use `lifecycle.addShutdownHook()` for DB connections and intervals.

7. **No `configSchema` in `package.json`** — Your `config.d.ts` types won't be discovered without it.

8. **Throwing raw `Error`** — Throw `@backstage/errors` types (`InputError`, `NotFoundError`, `NotAllowedError`, etc.) for proper HTTP status code mapping. Generic `Error` → 500.

9. **Using Express error handling yourself** — The framework has error middleware at both root and plugin levels. Just throw Backstage error types; they'll be caught and serialized automatically.

## Source References

- `packages/backend-defaults/src/entrypoints/rootHttpRouter/rootHttpRouterServiceFactory.ts` — Root middleware chain + `applyDefaults()`
- `packages/backend-defaults/src/entrypoints/rootHttpRouter/http/MiddlewareFactory.ts` — Helmet, CORS, compression, logging, rate limiting, error handler
- `packages/backend-defaults/src/entrypoints/httpRouter/httpRouterServiceFactory.ts` — Per-plugin middleware chain
- `packages/backend-defaults/src/entrypoints/httpRouter/http/createCredentialsBarrier.ts` — Automatic token validation on every request
- `packages/backend-defaults/src/entrypoints/httpRouter/http/createLifecycleMiddleware.ts` — Startup/shutdown request gating
- `packages/backend-defaults/src/entrypoints/httpRouter/http/createAuthIntegrationRouter.ts` — Auto-mounted JWKS endpoint
- `packages/backend-defaults/src/entrypoints/httpRouter/http/createCookieAuthRefreshMiddleware.ts` — Auto-mounted cookie auth
- `packages/backend-defaults/src/entrypoints/httpRouter/http/createRateLimitMiddleware.ts` — Per-plugin rate limiting
- `plugins/catalog-backend/src/service/CatalogPlugin.ts` — Canonical plugin wiring reference
- `plugins/catalog-backend/src/service/createRouter.ts` — Canonical Express router with full CRUD + auth + permissions
- `packages/backend-openapi-utils/src/stub.ts` — OpenAPI validator + generated router infrastructure
