---
name: backstage-core-services
description: "Use when building Backstage backend plugins and need to understand the core services framework. Covers ALL 22 services: auth, cache, database, discovery, httpAuth, httpRouter, lifecycle, logger, permissions, scheduler, urlReader, userInfo, auditor, rootConfig, rootHealth, rootHttpRouter, rootLifecycle, rootLogger, metrics, tracing, permissionsRegistry, pluginMetadata, rootInstanceMetadata. Includes scopes, anti-patterns, and real recipes."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, backend, services, core-services, dependency-injection, plugins]
    related_skills: [backstage-plugin-blueprint, writing-plans, test-driven-development, backstage-app-config, backstage-auth-permissions, backstage-testing, backstage-catalog-system, backstage-scaffolder-system, backstage-search-system, backstage-messaging, backstage-backend-api]
---

# Backstage Core Backend Services

## Overview

Every Backstage backend plugin runs inside a dependency-injection container powered by 22 core services. Import them from `@backstage/backend-plugin-api`:

```ts
import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
```

Services come in two scopes:
- **`plugin` scope (default):** Automatically namespaced to your plugin. Logger prefixes messages, HTTP router prefixes routes at `/api/<pluginId>`, database uses prefixed tables, cache uses namespaced keys. Use these in every plugin.
- **`root` scope:** Singleton for the whole backend. Only one instance. Accessible by feature loaders and modules, but plugins should prefer plugin-scoped alternatives where they exist.

Services are injected via `deps` in `registerInit`. Alpha services (metrics, tracing, actionsRegistry) import from `@backstage/backend-plugin-api/alpha`.

## Service Quick Reference

| Service | Scope | Import | Primary Use |
|---|---|---|---|
| `auth` | plugin | `coreServices.auth` | Token creation, credential inspection |
| `userInfo` | plugin | `coreServices.userInfo` | Fetch user ownership entity refs |
| `cache` | plugin | `coreServices.cache` | Key-value caching with TTL |
| `rootConfig` | root | `coreServices.rootConfig` | Read `app-config.yaml` values |
| `database` | plugin | `coreServices.database` | Knex DB client + migrations |
| `discovery` | plugin | `coreServices.discovery` | Resolve other plugins' base URLs |
| `httpAuth` | plugin | `coreServices.httpAuth` | Extract credentials from HTTP requests |
| `httpRouter` | plugin | `coreServices.httpRouter` | Register Express routes + auth policies |
| `lifecycle` | plugin | `coreServices.lifecycle` | Plugin startup/shutdown hooks |
| `logger` | plugin | `coreServices.logger` | Scoped logging (info/warn/error/debug) |
| `permissions` | plugin | `coreServices.permissions` | Authorize user actions |
| `permissionsRegistry` | plugin | `coreServices.permissionsRegistry` | Register resource types, permissions, rules |
| `pluginMetadata` | plugin | `coreServices.pluginMetadata` | Get current plugin ID |
| `scheduler` | plugin | `coreServices.scheduler` | Distributed cron-like tasks |
| `urlReader` | plugin | `coreServices.urlReader` | Read files/trees from GitHub, GitLab, etc. |
| `auditor` | plugin | `coreServices.auditor` | Security audit event logging |
| `rootHealth` | root | `coreServices.rootHealth` | Liveness/readiness checks |
| `rootHttpRouter` | root | `coreServices.rootHttpRouter` | Root-level HTTP routing + CSP |
| `rootLifecycle` | root | `coreServices.rootLifecycle` | Backend-level startup/shutdown |
| `rootLogger` | root | `coreServices.rootLogger` | Root-level logging |
| `metrics` | plugin | `metricsServiceRef` (alpha) | OpenTelemetry counters, histograms, gauges |
| `tracing` | plugin | `tracingServiceRef` (alpha) | OpenTelemetry trace spans |
| `rootInstanceMetadata` | root | `coreServices.rootInstanceMetadata` | List installed plugins on this instance |

## Auth & Identity (auth, httpAuth, userInfo)

The three-tier auth stack. Use together in request handlers.

### `auth` — Token creation and credential inspection

```ts
// Make a service-to-service call as your own plugin:
const { token } = await auth.getPluginRequestToken({
  onBehalfOf: await auth.getOwnServiceCredentials(),
  targetPluginId: 'catalog',
});

// Make a call on behalf of the requesting user (inside a route handler):
const { token } = await auth.getPluginRequestToken({
  onBehalfOf: await httpAuth.credentials(req),
  targetPluginId: 'catalog',
});

// Check principal type:
if (auth.isPrincipal(credentials, 'user')) {
  // credentials is narrowed to BackstageCredentials<BackstageUserPrincipal>
  console.log(credentials.principal.userEntityRef);
}
```

**Critical rule:** Never store and reuse tokens. Always call `getPluginRequestToken` immediately before each request — tokens expire.

### `httpAuth` — Extract credentials from Express requests

```ts
// Require user credentials only (throws if service/NONE):
const creds = await httpAuth.credentials(req, { allow: ['user'] });

// Accept both user and service:
const creds = await httpAuth.credentials(req);

// Accept cookie-based (limited) access (rare — TechDocs static assets):
const creds = await httpAuth.credentials(req, { allowLimitedAccess: true });
```

**Note:** You do NOT need to call `httpAuth.credentials` just to validate tokens — the framework already validates all incoming tokens before your code runs. Only call it when you actually need the credentials object.

### `userInfo` — Get user ownership entity refs

```ts
const credentials = await httpAuth.credentials(req, { allow: ['user'] });
const info = await userInfo.getUserInfo(credentials);
// info contains userEntityRef, ownershipEntityRefs
```

Works only with user principals. For endpoints accepting both user+service, wrap in a principal check:

```ts
const credentials = await httpAuth.credentials(req);
if (auth.isPrincipal(credentials, 'user')) {
  const info = await userInfo.getUserInfo(credentials);
}
```

## HTTP & Routing (httpRouter, rootHttpRouter) — The Complete Middleware Pipeline

Backstage applies **two ordered layers** of Express middleware automatically — one at the root level, one per plugin. You write only your route handlers; everything else is built-in.

### The Full Middleware Chain (in execution order)

**Layer 1 — Root-level** (`rootHttpRouter`, fires ONCE for the entire backend):

| # | Middleware | What It Does | Config |
|---|---|---|---|
| 1 | Helmet | Security headers (CSP, HSTS, XSS, etc.) | `backend.csp` |
| 2 | CORS | Cross-origin request policies | `backend.cors` |
| 3 | Compression | gzip/deflate response bodies | — |
| 4 | Logging | Apache-combined request log → structured logger | — |
| 5 | Rate limit (global) | Backend-wide request throttling | `backend.rateLimit` |
| 6 | Health routes | Liveness/readiness at `/.backstage/health/v1/*` | `backend.health` |
| 7 | Plugin dispatch | Routes to `/api/<pluginId>` sub-routers | — |
| 8 | 404 handler | Catches unmatched routes | — |
| 9 | Error handler | Maps `@backstage/errors` → HTTP status codes + JSON body | — |

The error handler auto-converts: `InputError`→400, `AuthenticationError`→401, `NotAllowedError`→403, `NotFoundError`→404, `ConflictError`→409, `NotModifiedError`→304, `ServiceUnavailableError`→503, everything else→500 with `ErrorResponseBody` format (`{ error, request, response }`).

**Layer 2 — Per-plugin** (`httpRouter`, fires for every plugin under `/api/<pluginId>`):

| # | Middleware | What It Does | You Need? |
|---|---|---|---|
| 1 | Per-plugin rate limit | Plugin-specific throttling (if configured) | Config only |
| 2 | Plugin mount | Plugin sub-router attached at `/api/<pluginId>` | No |
| 3 | Auth integration router | Auto-mounts `/.backstage/auth/v1/jwks.json` | No |
| 4 | Lifecycle middleware | Pauses requests until `registerInit` completes, rejects during shutdown | No |
| 5 | Credentials barrier | **Validates tokens on EVERY route by default** | No (unless adding public routes) |
| 6 | Cookie auth refresh | `/.backstage/auth/v1/cookie` GET (set) / DELETE (clear) | No |
| 7 | Plugin routes | ← YOUR CODE goes here | **Yes** |
| 8 | Error handler | Backstage error → HTTP status serialization (duplicated at this level) | No |

### What You NEVER Need to Code

Backstage handles all of this automatically — you write none of it:

- ✅ **Token validation** — credentials barrier calls `httpAuth.credentials(req)` before any route runs
- ✅ **JWKS key endpoint** — auto-mounted per-plugin at `/.backstage/auth/v1/jwks.json`
- ✅ **Cookie auth flow** — auto-mounted at `/.backstage/auth/v1/cookie`
- ✅ **Request logging** — Apache-combine format with structured JSON metadata
- ✅ **Compression** — gzip response bodies automatically
- ✅ **CORS** — configured in `app-config.yaml`, not in code
- ✅ **Security headers** — Helmet/CSP from config
- ✅ **Rate limiting** — config-driven, per-plugin or global
- ✅ **Error serialization** — casts `@backstage/errors` to proper HTTP status + JSON body
- ✅ **Lifecycle/readiness gating** — requests pause during init, reject during shutdown
- ✅ **Plugin-scoped URL prefixing** — `/api/<pluginId>` applied automatically

### What You DO Need to Write

Only the route handler logic and auth policy exceptions:

```ts
env.registerInit({
  deps: {
    httpRouter: coreServices.httpRouter,
    httpAuth: coreServices.httpAuth,     // Only if you need credentials inside handlers
    permissions: coreServices.permissions, // Only if you need permission checks
    auth: coreServices.auth,              // Only if you make service-to-service calls
    discovery: coreServices.discovery,     // Only if you call other plugins
  },
  async init({ httpRouter, ... }) {
    const router = Router();

    // Your route handlers — auth already validated by the barrier above
    router.get('/items', async (req, res) => {
      res.json(await fetchItems());
    });

    router.post('/items', async (req, res) => {
      res.status(201).json(await createItem(req.body));
    });

    httpRouter.use(router);
  },
});
```

### Auth Policies (making routes public)

By default, EVERY route requires valid user/service credentials. Override specific paths:

```ts
// Allow unauthenticated access:
httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });
httpRouter.addAuthPolicy({ path: '/public/:id', allow: 'unauthenticated' });

// Allow cookie-based access (only for static assets like TechDocs):
httpRouter.addAuthPolicy({ path: '/static/:id', allow: 'user-cookie' });
```

Policy paths use `path-to-regexp` syntax. `'/'` and `'*'` match everything. The barrier checks unauthenticated predicates first, then cookie, then falls back to strict user/service auth.

### Rate Limiting

Configured entirely in `app-config.yaml` — no code needed:

```yaml
backend:
  rateLimit:
    global: true               # Enable backend-wide limiting
    window: 6s
    incomingRequestLimit: 100
    plugin:                    # Per-plugin overrides
      catalog:
        window: 3s
        incomingRequestLimit: 50
    store:
      type: redis              # 'memory' (default, no coordination) or 'redis' (multi-instance)
      connection: redis://127.0.0.1:16379
```

Set `global: false` to disable global limiting for specific plugins only. Set `backend.rateLimit: true` for defaults.

### rootHttpRouter Customization

For root paths NOT under `/api/<pluginId>`. To add custom middleware or override defaults:

```ts
import { rootHttpRouterServiceFactory } from '@backstage/backend-defaults/rootHttpRouter';

backend.add(rootHttpRouterServiceFactory({
  configure: ({ app, middleware, routes, healthRouter, applyDefaults }) => {
    applyDefaults(); // Applies all 9 layers from the root chain above
    // Add custom middleware here — fires between rate-limiting and health routes
  },
}));
```

### OpenAPI Validation Router (Optional)

The catalog plugin uses a generated OpenAPI router for automatic request validation:

1. Define `schema/openapi.yaml` with your API spec
2. Generate: `yarn backstage-cli package schema openapi generate --server`
3. This wraps Express with `express-openapi-validator` middleware
4. Every request is validated against the spec (query params, body, path params)
5. Invalid requests → automatic `InputError` (400)

The generated router already includes `json()` body parsing and error transformation middleware. Use `createValidatedOpenApiRouter` or `createValidatedOpenApiRouterFromGeneratedEndpointMap` from `@backstage/backend-openapi-utils`.

## Database & Caching (database, cache)

### `database` — Knex client with auto-migrations

```ts
const client = await database.getClient();
const migrationsDir = resolvePackagePath('@internal/my-plugin', 'migrations');

if (!database.migrations?.skip) {
  await client.migrate.latest({ directory: migrationsDir });
}
```

- Default: in-memory SQLite (lost on restart). Production: configure `backend.database` in `app-config.yaml`.
- Plugin-scoped: table names don't conflict across plugins.
- Modules MUST prefix tables to avoid conflicts with the plugin: use `<pluginName>__<tableName>`.

### `cache` — Key-value store with TTL

```ts
await cache.set('my-key', value, { ttl: 1000 }); // TTL in milliseconds
const value = await cache.get('my-key');
await cache.delete('my-key');
```

Stores: `memory` (default), `memcache`, `redis`, `valkey`, `infinispan`. Redis/Valkey support global namespace prefixes. Configure in `app-config.yaml`:

```yaml
backend:
  cache:
    store: redis
    connection: redis://localhost:6379
```

## Scheduling (scheduler)

Distributed cron-like tasks with `local` (per-instance) or `global` (one-at-a-time) scope:

```ts
await scheduler.scheduleTask({
  id: 'my-task',
  frequency: { minutes: 10 },
  timeout: { seconds: 30 },
  scope: 'global',  // or 'local'
  fn: async () => { /* task logic */ },
});
```

**Frequency formats:**
- `{ minutes: 10 }` — every 10 minutes
- `{ hours: 2 }` — every 2 hours
- `{ cron: '0 3 * * *' }` — cron expression
- `{ initialDelay: { seconds: 30 }, cron: '...' }` — with startup delay

**Scheduler REST API** (inspect/trigger/cancel tasks):
- `GET /api/<pluginId>/.backstage/scheduler/v1/tasks` — list tasks
- `POST .../tasks/<taskId>/trigger` — trigger now
- `POST .../tasks/<taskId>/cancel` — cancel running task

**Testing:** `mockServices.scheduler()` auto-runs non-manual tasks immediately.

## Permissions (permissions, permissionsRegistry)

### `permissions` — Authorize actions

```ts
const result = await permissions.authorize(
  [{ permission: myPermission }],
  { credentials: await httpAuth.credentials(req) },
);
if (result[0].result !== AuthorizeResult.ALLOW) {
  throw new NotAllowedError('Permission denied');
}
```

### `permissionsRegistry` — Register resources and rules

```ts
permissionsRegistry.addResourceType({
  resourceType: 'my-resource',
  permissions: [myReadPermission, myWritePermission],
  rules: [myCustomRule],
});
// Or just add permissions:
permissionsRegistry.addPermissions([myPermission]);
```

Replaces the deprecated `createPermissionIntegrationRouter` pattern.

## Configuration (rootConfig)

Read static `app-config.yaml` values. Root-scoped — accessible everywhere:

```ts
const baseUrl = config.getString('backend.baseUrl');
const optional = config.getOptionalBoolean('myPlugin.featureFlag');
const number = config.getNumber('myPlugin.limit');
const nested = config.getConfig('myPlugin.nested');
```

**Config schema** — declare in `config.d.ts`, reference in `package.json` (`"configSchema": "config.d.ts"`). Use `@visibility frontend`, `@visibility backend`, `@visibility secret` annotations.

## URL Reading (urlReader)

Read files/trees from VCS integrations (GitHub, GitLab, Bitbucket, etc.):

```ts
// Read a single file:
const buffer = await urlReader
  .read('https://github.com/backstage/backstage/blob/master/README.md')
  .then(r => r.buffer());

// Read a directory tree:
const tree = await urlReader
  .readTree('https://github.com/backstage/backstage/tree/master/packages/backend');
await tree.dir({ targetDir: '/tmp/output' });

// Search with glob:
const files = await urlReader
  .search('https://github.com/backstage/backstage/blob/master/**/catalog-info.yaml');
```

**ETag caching:** All methods support conditional fetching via ETags. Pass an ETag to avoid re-downloading unchanged content (returns `NotModifiedError`).

**Custom readers:** Register via `urlReaderFactoriesServiceRef` from `@backstage/backend-defaults/urlReader`:

```ts
class CustomUrlReader implements UrlReaderService {
  static factory: ReaderFactory = ({ config, treeResponseFactory }) => {
    const reader = new CustomUrlReader(config);
    const predicate = (url: URL) => url.host === 'myCustomDomain';
    return [{ reader, predicate }];
  };
}
```

## Lifecycle (lifecycle, rootLifecycle)

### `lifecycle` — Plugin-scoped hooks

```ts
// Clean up on shutdown:
lifecycle.addShutdownHook(() => clearInterval(interval));

// Run on startup:
lifecycle.addStartupHook(async () => { await connectToService(); });
```

### `rootLifecycle` — Backend-wide hooks

Same API but root-scoped. Used by root services and infrastructure. Overridable for custom process signal handling.

## Logging & Auditing (logger, rootLogger, auditor)

### `logger` — Plugin-scoped logging

```ts
logger.info('Processing started');
logger.warn('Rate limit approaching');
logger.error('Failed to connect', error);
logger.debug('Detailed diagnostic info');
logger.child({ requestId: 'abc' }); // Create child logger with context
```

Plugin-scoped: log lines include plugin ID automatically.

### `auditor` — Security audit events

For security-relevant events (not general logging). Use kebab-case event IDs:

```ts
const event = await auditor.createEvent({
  eventId: 'entity-fetch',
  severityLevel: 'low',
  request: req,
  meta: { queryType: 'by-id', entityRef: 'component:default/my-svc' },
});

try {
  // ... process ...
  await event.success();
} catch (error) {
  await event.fail({ error });
}
```

**Severity levels:** `low`, `medium`, `high`, `critical`. Configurable log-level mappings:

```yaml
backend:
  auditor:
    severityLogLevelMappings:
      low: debug
      medium: info
      high: warn
      critical: error
```

**Meta conventions:** `queryType` (kebab-case), `actionType` (kebab-case), `entityRef`, `locationRef`, `uid`.

## Observability (metrics, tracing) — Alpha

Both require OpenTelemetry SDK setup before Backstage starts.

### `metrics` — Application-level metric instruments

```ts
import { metricsServiceRef } from '@backstage/backend-plugin-api/alpha';

// Synchronous instruments:
const counter = metrics.createCounter('todos.completed', { description: 'Total todos completed' });
counter.add(1, { 'todo.status': 'completed' });

const histogram = metrics.createHistogram('todo.duration', {
  description: 'Time to process a todo',
  unit: 'seconds',
  advice: { explicitBucketBoundaries: [0.01, 0.05, 0.1, 0.5, 1, 5] },
});
histogram.record(0.3, { 'todo.category': 'personal' });

// Observable (async callback-based):
const entityCount = metrics.createObservableGauge('catalog.entities', { description: 'Entity count' });
entityCount.addCallback(async gauge => {
  const counts = await getCountsByKind();
  for (const { kind, count } of counts) gauge.observe(count, { kind });
});
```

**Instrument types:** `createCounter` (monotonic), `createUpDownCounter`, `createHistogram` (distribution), `createGauge` (point-in-time), plus observable variants.

**Type-safe attributes:** Generic type parameter constrains label keys/values.

### `tracing` — Application-level trace spans

```ts
import { tracingServiceRef } from '@backstage/backend-plugin-api/alpha';

const result = await tracing.startActiveSpan('process-todo', async span => {
  span.setAttribute('todo.category', 'personal');
  return computeResult();
}, {
  attributes: { 'todo.id': todoId },
  kind: 'internal',
  credentials, // Auto-enriches span with backstage.principal.type + enduser.id (if enabled)
});
```

Span auto-finishes, auto-records exceptions, auto-sets ERROR status. Principal enrichment controlled by `backend.tracing.capture.endUser: true`.

## Metadata (pluginMetadata, rootInstanceMetadata)

### `pluginMetadata` — Current plugin ID

```ts
const pluginId = pluginMetadata.getId(); // e.g., 'catalog'
```

Used by plugin-scoped service factories to namespace their behavior.

### `rootInstanceMetadata` — Installed plugins list

```ts
const plugins = instanceMetadata.getInstalledPlugins();
// [{ pluginId: 'catalog', packageName: '@backstage/plugin-catalog-backend' }, ...]
```

Only reflects plugins on the current instance (not cluster-wide).

## Health (rootHealth)

Liveness/readiness endpoints at `/.backstage/health/v1/readiness` and `/.backstage/health/v1/liveness`. Overridable:

```ts
class MyHealthService implements RootHealthService {
  async getLiveness() { return { status: 200, payload: { status: 'ok' } }; }
  async getReadiness() { return { status: 200, payload: { status: 'ok' } }; }
}
```

Custom headers via config: `backend.health.headers.service-name: my-service`.

## Discovery (discovery)

Resolve other plugins' base URLs for inter-plugin HTTP calls:

```ts
const url = await discovery.getBaseUrl('catalog');
const response = await fetch(`${url}/entities`);
```

Also: `discovery.getExternalBaseUrl('catalog')` for externally-routable URLs.

## Common Service Combinations (Recipes)

### Recipe 1: Secure REST endpoint with permissions

```ts
env.registerInit({
  deps: {
    httpRouter: coreServices.httpRouter,
    httpAuth: coreServices.httpAuth,
    permissions: coreServices.permissions,
    auth: coreServices.auth,
    config: coreServices.rootConfig,
    logger: coreServices.logger,
  },
  async init({ httpRouter, httpAuth, permissions, auth, config, logger }) {
    const router = Router();
    router.get('/data', async (req, res) => {
      const creds = await httpAuth.credentials(req, { allow: ['user'] });
      const [decision] = await permissions.authorize(
        [{ permission: myReadPermission }],
        { credentials: creds },
      );
      if (decision.result !== AuthorizeResult.ALLOW) {
        throw new NotAllowedError('Access denied');
      }
      const data = await fetchData();
      res.json(data);
    });
    httpRouter.use(router);
  },
});
```

### Recipe 2: Scheduled task with database

```ts
env.registerInit({
  deps: {
    scheduler: coreServices.scheduler,
    database: coreServices.database,
    logger: coreServices.logger,
    lifecycle: coreServices.lifecycle,
  },
  async init({ scheduler, database, logger, lifecycle }) {
    const client = await database.getClient();
    await client.migrate.latest({ directory: migrationsDir });

    await scheduler.scheduleTask({
      id: 'cleanup',
      frequency: { hours: 1 },
      timeout: { minutes: 5 },
      scope: 'global',
      fn: async () => {
        await client('my_table').where('expires_at', '<', new Date()).del();
        logger.info('Cleanup complete');
      },
    });

    lifecycle.addShutdownHook(async () => {
      await client.destroy();
    });
  },
});
```

### Recipe 3: Service-to-service call with caching

```ts
env.registerInit({
  deps: {
    discovery: coreServices.discovery,
    auth: coreServices.auth,
    cache: coreServices.cache,
    logger: coreServices.logger,
  },
  async init({ discovery, auth, cache, logger }) {
    async function fetchFromCatalog(entityRef: string) {
      const cacheKey = `entity:${entityRef}`;
      const cached = await cache.get(cacheKey);
      if (cached) return cached;

      const baseUrl = await discovery.getBaseUrl('catalog');
      const { token } = await auth.getPluginRequestToken({
        onBehalfOf: await auth.getOwnServiceCredentials(),
        targetPluginId: 'catalog',
      });
      const resp = await fetch(`${baseUrl}/entities/by-ref/${entityRef}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const entity = await resp.json();
      await cache.set(cacheKey, entity, { ttl: 60000 }); // 1 min cache
      return entity;
    }
  },
});
```

### Recipe 4: Audit-logged write operation

```ts
router.post('/entity', async (req, res) => {
  const event = await auditor.createEvent({
    eventId: 'entity-mutate',
    severityLevel: 'medium',
    request: req,
    meta: { actionType: 'create', entityRef: req.body.entityRef },
  });
  try {
    const result = await createEntity(req.body);
    await event.success({ meta: { uid: result.id } });
    res.json(result);
  } catch (error) {
    await event.fail({ error });
    throw error;
  }
});
```

## OpenTelemetry Observability Setup (Alpha)

> **Status: Alpha** — Available in `@backstage/backend-app-api` via `opentelemetry` feature entry point.

### Initialization in Backend

```ts
// packages/backend/src/index.ts
import { opentelemetrySDK } from '@backstage/backend-app-api/opentelemetry';

// MUST be imported before any other Backstage imports
opentelemetrySDK.start();

backend.add(import('@backstage/plugin-catalog-backend-module-opentelemetry'));
// ^^^ Automatically instruments catalog service spans
```

### Configure Exporters

```yaml
# app-config.yaml
backend:
  opentelemetry:
    # OTLP exporter (most common — sends to collector like Jaeger, Grafana Agent, etc.)
    exporter: otlp
    endpoint: http://${OTEL_COLLECTOR_HOST}:4318
    # Or: console, zipkin, none
    # none: disables export but keeps metrics/tracing objects available
```

### Service-to-Service Auto-Instrumentation

The backend app auto-instruments:
- **HTTP spans**: Every `rootHttpRouter` request gets a span with route + status code
- **Database spans**: Knex database queries auto-spanned via `@backstage/plugin-catalog-backend-module-opentelemetry`
- **Plugin-to-plugin calls**: When using `HttpRouterService`, spans propagate via W3C trace context headers

### Manual Tracing (Plugin Authors)

```ts
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('my-plugin');

export async function myHandler() {
  await tracer.startActiveSpan('my-operation', async span => {
    try {
      span.setAttribute('app.request_id', requestId);
      const result = await doWork();
      span.setAttribute('result.count', result.length);
      return result;
    } finally {
      span.end();
    }
  });
}
```

### Metrics

Alpha metrics are available via the OpenTelemetry metrics SDK:

```ts
import { metrics } from '@opentelemetry/api';
const meter = metrics.getMeter('my-plugin');
const counter = meter.createCounter('requests.total');
counter.add(1, { route: '/api/catalog/entities' });
```

### Common Pitfalls

1. **Import order matters**: `opentelemetrySDK.start()` MUST be imported/run before any other Backstage package is loaded. Put it at the very top of your backend entry point.
2. **Prod exporter overhead**: OTLP exporter can add latency. In high-throughput scenarios, use batch export or set sampling: `backend.opentelemetry.sampling: traceidratio: 0.1`
3. **Missing spans**: If plugins don't appear in traces, verify `@backstage/plugin-catalog-backend-module-opentelemetry` is installed.

## Common Pitfalls — Always call `auth.getPluginRequestToken` immediately before each request. Tokens expire.

2. **Using `logger` instead of `auditor` for security events** — `auditor` is for security-relevant, compliance-tracked events. `logger` is for operational logging.

3. **Not running database migrations** — Call `client.migrate.latest()` in your init. Check `database.migrations?.skip` to allow disabling.

4. **Module table name conflicts** — Modules sharing the target plugin's database MUST prefix tables: `<pluginName>__<tableName>`.

5. **Wrong service scope** — `rootConfig` is root-scoped and accessible in modules/loaders. `config` does not exist as a plugin-scoped service — always use `rootConfig`.

6. **Missing `configSchema` in `package.json`** — Config types won't be discovered without it.

7. **Missing `@visibility` on config fields** — Fields default to `backend`. Frontend needs `@visibility frontend`. Secrets need `@visibility secret`.

8. **Forgetting shutdown cleanup** — Use `lifecycle.addShutdownHook` for intervals, connections, and DB clients.

9. **Not handling `NotModifiedError` from urlReader** — When using ETags, handle the not-modified case.

10. **Calling `httpAuth.credentials` unnecessarily** — The framework already validates tokens. Only call it when you need the credentials object.

11. **Leaving `allowLimitedAccess: true` always on** — Cookie-based access is for static assets (TechDocs), not general API endpoints.

12. **Using alpha services (metrics, tracing) without OTel SDK setup** — These require OpenTelemetry SDK initialization before Backstage starts.

## Verification Checklist

- [ ] Plugin imports services from `coreServices.*` (or `@backstage/backend-plugin-api/alpha` for alpha)
- [ ] Plugin-scoped services used for plugin behavior; root-scoped only for root concerns
- [ ] `configSchema` points to `config.d.ts` in `package.json`
- [ ] Config fields have appropriate `@visibility` annotations
- [ ] Database migrations run in init, not skipped unless configured
- [ ] Tokens generated fresh per request, never stored
- [ ] Shutdown hooks registered for cleanup (intervals, connections)
- [ ] Audit events use kebab-case IDs with proper meta fields
- [ ] Permission checks via `permissions.authorize`, not manual token inspection
- [ ] Module table names prefixed to avoid plugin table conflicts
- [ ] Alpha services guarded with OTel SDK setup
