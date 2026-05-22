---
name: backstage-backend-testing
description: "Use when writing ANY backend test for Backstage plugins. Covers integration tests (startTestBackend), plugin tests, router tests, mock services, database testing (TestDatabases), and supertest HTTP assertions. Based on production test patterns from catalog-backend and auth-backend."
version: 1.0.0
author: Hermes Agent
metadata:
  hermes:
    tags: [backstage, backend, testing, jest, supertest, startTestBackend, mockServices, TestDatabases]
    related_skills: [backstage-backend-api, backstage-code-review, backstage-feature-scaffolder]
    supersedes: [backstage-testing]  # This skill is the authoritative backend testing reference
---

# Backstage Backend Testing

## ⛔ Forbidden Patterns

These patterns are ALWAYS wrong. The code-review skill independently checks for them.

```bash
# 1. Never use dynamic import() for plugin features
grep -rn "import(@" plugins/<id>-backend/src/__tests__/ && echo "VIOLATION" || echo "OK"

# 2. Never create a raw Express app for testing
grep -rn "express()" plugins/<id>-backend/src/__tests__/ && echo "VIOLATION" || echo "OK"
```

**Always use `startTestBackend` — it boots the full Backstage backend including middleware, auth, config, and plugin wiring.**

---

## Test File Types

Every backend plugin should have these test files:

| File | Purpose | Uses |
|---|---|---|
| `src/__tests__/plugin.test.ts` | Plugin-level integration test | `startTestBackend` + `supertest` |
| `src/__tests__/router.test.ts` | Router unit test | Direct `createRouter()` call with mock deps |
| `src/setupTests.ts` | Global test configuration | `TestDatabases.setDefaults()` (if using DB) |
| `src/__tests__/migrations.test.ts` | Database migration test | `TestDatabases.create()` (if using DB) |

---

## Pattern 1: Plugin Integration Test (MANDATORY)

This is the primary test. It boots the complete backend and makes HTTP requests.

```ts
import { mockServices, startTestBackend } from '@backstage/backend-test-utils';
import request from 'supertest';
import { githubCopilotPlugin } from '../plugin';

describe('githubCopilotPlugin', () => {
  it('should serve metrics freshness endpoint', async () => {
    const { server } = await startTestBackend({
      features: [
        githubCopilotPlugin,
        mockServices.rootConfig.factory({
          data: {
            app: { baseUrl: 'http://localhost:7007' },
            copilot: { enterprise: 'test-enterprise' },
            integrations: {
              github: [{ host: 'github.com', token: 'test-token' }],
            },
          },
        }),
      ],
    });

    const res = await request(server).get(
      '/api/github-copilot/metrics/freshness',
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      latestAvailableDate: expect.any(String),
      windowStart: expect.any(String),
    });
  });
});
```

**Key points:**
- Plugin is imported **statically** — `import { xxxPlugin } from '../plugin'` — never `import("@internal/...")`
- Config is provided via `mockServices.rootConfig.factory({ data: {...} })`
- Auth middleware is automatically configured — no need to manually bypass auth policies unless testing them
- Plugin name comes from `createBackendPlugin({ pluginId: '...' })` — matches the URL path `/api/<pluginId>/...`

---

## Pattern 2: Mock Services

`mockServices` provides factory functions that create mock implementations of every Backstage core service.

```ts
import { mockServices } from '@backstage/backend-test-utils';

// Mock config with real YAML-equivalent data
mockServices.rootConfig.factory({
  data: {
    myPlugin: {
      enabled: true,
      token: 'secret',
    },
  },
})

// Mock logger (silent by default)
const logger = mockServices.logger.mock();

// Mock discovery service
mockServices.discovery.factory();

// Mock auth (authenticated by default)
mockServices.auth.factory({ pluginId: 'my-plugin' });
```

---

## Pattern 3: Router Unit Test

Tests `createRouter()` directly without booting the full backend.

```ts
import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import request from 'supertest';
import express from 'express';
import { createRouter } from '../router';

describe('createRouter', () => {
  let app: express.Express;

  beforeAll(async () => {
    const router = await createRouter({
      config: ConfigReader.fromConfigs([
        { context: 'test', data: { copilot: { enterprise: 'test' } } },
      ]),
      logger: mockServices.logger.mock(),
    });

    app = express().use(router);
  });

  it('GET /metrics/freshness returns 200', async () => {
    const res = await request(app).get('/metrics/freshness');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('latestAvailableDate');
  });
});
```

**Key points:**
- Creates a raw `express()` app to mount the router on (after `startTestBackend` for integration, this is fine for unit tests)
- Uses `ConfigReader.fromConfigs(...)` for config (same config source as production)
- Uses `mockServices.logger.mock()` for logger
- Supertest against `app` (Express), not `server` (from startTestBackend)

---

## Pattern 4: Database Tests

If your plugin stores data, test against real databases via `TestDatabases`.

```ts
// src/setupTests.ts
import { TestDatabases } from '@backstage/backend-test-utils';

TestDatabases.setDefaults({
  ids: ['MYSQL_8', 'POSTGRES_17', 'POSTGRES_13', 'SQLITE_3'],
});

// src/__tests__/migrations.test.ts
import { TestDatabases } from '@backstage/backend-test-utils';

describe('migrations', () => {
  const databases = TestDatabases.create();

  it.each(databases.eachSupportedId())(
    'should run on %p',
    async (databaseId) => {
      const knex = await databases.init(databaseId);
      await knex.migrate.latest({ directory: '../migrations' });
      // Verify schema...
    },
    60000,
  );
});
```

---

## What Your Test Files MUST Have

Every backend plugin's `src/__tests__/` directory must contain:

- [ ] `plugin.test.ts` — imports the plugin statically, uses `startTestBackend`, makes HTTP assertions via `supertest`
- [ ] `router.test.ts` — imports `createRouter` directly, mounts on `express()`, tests route handlers with mock deps
- [ ] Tests use `mockServices.rootConfig.factory({ data: {...} })` for config — never `process.env`
- [ ] Tests use `expect(res.body).toMatchObject(...)` for object assertions — checks shape, not exact values
- [ ] Tests use `expect.any(String)`, `expect.any(Number)` for non-deterministic values (timestamps, IDs)
- [ ] No dynamic `import("@internal/...")` — always static ESM imports
- [ ] Proper `describe`/`it` nesting with descriptive names
