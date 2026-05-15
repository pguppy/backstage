---
title: 'Fix Catalog Status API Consolidated Review Fixes'
type: fix
status: active
date: 2026-05-05
origin: docs/plans/2026-05-05-fix-catalog-status-api-prefetch-race-and-scalability-plan.md
---

# Fix Catalog Status API Consolidated Review Fixes

## Overview

Comprehensive architectural review of the catalog entity status API identified 10 remaining issues after 5 prior plans were partially or fully implemented. This plan consolidates all outstanding fixes into a single execution plan with clear phase ordering.

**What's already implemented (from 5 prior plans):**

- `entity_status` table with migrations and `entity_ref` index
- `DefaultCatalogStatusStore` with full CRUD + orphan cleanup methods
- REST endpoints: GET (list sources), POST (update), DELETE (remove by source)
- `StitchingStatusMerger` extension point with `init`/`preFetch`/`merge` lifecycle
- `EntityStatusQuery` typed interface (not raw Knex)
- `BuiltinStatusMerger` with no-op `preFetch`, uses `query.getStatuses()` in `merge`
- Source validation, payload validation, reserved key guards, XSS sanitization
- `catalogStitcherServiceRef` + `catalogStitcherServiceFactory` defined
- Per-entity `prefetchedStatuses` in stitcher pipeline (no instance-level race)
- Cached `EntityStatusQuery` in `performStitching` (serves from prefetch, falls through to DB)
- Entity existence checks on POST and DELETE
- DELETE returns 404 when no rows affected
- Permission model with `catalogEntityStatusWritePermission`
- `?stitch=deferred` query parameter on POST and DELETE
- Orphan entity cleanup in `performStitching` (orphan-detection path)
- Orphan status cleanup in deferred stitch pipeline's `loadTasks`
- Integration test, unit tests, OpenAPI spec, generated code, changeset

**What this plan fixes (10 issues across 4 priority tiers):**

| #   | Issue                                           | Priority | Root Cause                                                   |
| --- | ----------------------------------------------- | -------- | ------------------------------------------------------------ |
| 1   | `catalogStitcherServiceRef` factory never wired | P0       | Factory throws; no override registered in DI                 |
| 2   | GET/DELETE routes bypass typed router           | P0       | Unsafe `(router as unknown as express.Router)` casts         |
| 3   | GET endpoint doesn't verify entity existence    | P1       | Inconsistent with POST/DELETE; information leak              |
| 4   | Merger `init()` is fire-and-forget              | P1       | Mergers can be called in `merge()` before `init()` completes |
| 5   | Orphan cleanup in stitching hot path            | P2       | LEFT JOIN on every deferred stitch `loadTasks` call          |
| 6   | No batch status write API                       | P2       | Per-entity writes amplify stitching load                     |
| 7   | XSS sanitization only at stitch time            | P3       | Malicious data persists raw in DB                            |
| 8   | No DB-level payload size constraint             | P3       | Application check bypassable by direct DB writes             |
| 9   | `updated_at` column never consumed              | P3       | Dead code; no TTL or audit use                               |
| 10  | `listSources` returns unbounded results         | P3       | No limit on number of sources per entity                     |

## Proposed Solution

Four phases ordered by priority. Each phase is independently deployable. Phases 1-2 are correctness fixes. Phases 3-4 are quality and scalability improvements.

## Technical Approach

### Architecture

The service factory wiring follows the existing Backstage pattern: register a factory inside `CatalogPlugin.ts` after `builder.build()` returns the stitcher. The route typing fix requires regenerating the OpenAPI router or restructuring how the status endpoints mount.

The merger init fix introduces a coordination barrier: mergers are not called in `merge()` until their `init()` resolves. The orphan cleanup moves from the stitch hot path to a periodic lifecycle hook.

### Design Decisions

| Decision                  | Choice                                                                    | Rationale                                                                       |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Service factory wiring    | Inline `createServiceFactory` in `CatalogPlugin.ts` init                  | Same pattern as other plugin-provided services; stitcher exists after `build()` |
| Route typing              | Regenerate OpenAPI router to include status routes, or add typed wrappers | Eliminates unsafe casts; ensures compile-time validation                        |
| GET entity existence      | Add `entitiesBatch()` check to GET handler                                | Consistent with POST/DELETE; prevents information leak                          |
| Merger init coordination  | Track init state; skip mergers in merge() until init resolves             | Prevents uninitialized mergers from corrupting entity status                    |
| Orphan cleanup scheduling | Move to `lifecycle.addStartupHook()` + periodic interval                  | Removes DB overhead from every deferred stitch cycle                            |
| Batch write API           | New POST `/entities/status/batch` endpoint                                | Reduces HTTP overhead for bulk status updates                                   |
| Write-time sanitization   | Sanitize in `validateStatusPayload()` before DB write                     | Defense in depth; DB always stores clean data                                   |
| DB payload constraint     | Add CHECK or application-enforced limit                                   | Prevents bypass via direct DB access                                            |
| `updated_at` column       | Keep; document as audit trail for future TTL feature                      | Not dead code — enables future staleness detection                              |
| `listSources` limit       | Add optional `limit` parameter (default: 100)                             | Prevents unbounded result sets                                                  |

### Implementation Phases

#### Phase 1: P0 Correctness Fixes

##### Task 1.1: Wire `catalogStitcherServiceRef` as resolvable DI service

The `catalogStitcherServiceFactory` throws by default and is never overridden. External modules depending on `catalogStitcherServiceRef` will crash at runtime.

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogPlugin.ts`

After `builder.build()`, register the stitcher as a resolvable service:

```typescript
// CatalogPlugin.ts — inside the init function, after builder.build()

const { processingEngine, router, stitcher } = await builder.build();

stitchingExtensions.setStitcher(stitcher);

// Register the stitcher as a resolvable DI service
env.registerServiceFactory(
  createServiceFactory({
    service: catalogStitcherServiceRef,
    deps: {},
    factory: () => stitcher,
  }),
);
```

Import `catalogStitcherServiceRef` from `@backstage/plugin-catalog-node/alpha` (may already be imported).

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogStitcherServiceFactory.ts`

Update the placeholder factory to document that it's overridden by the plugin:

```typescript
/**
 * Placeholder factory. The catalog plugin overrides this at runtime
 * with the real stitcher instance after build() completes.
 *
 * @alpha
 */
export const catalogStitcherServiceFactory = createServiceFactory({
  service: catalogStitcherServiceRef,
  deps: {},
  async factory() {
    throw new Error(
      'catalogStitcherServiceFactory must be overridden by the catalog plugin. ' +
        'Ensure @backstage/plugin-catalog-backend is installed and initialized.',
    );
  },
});
```

**Validation:** Create a test module that depends on `catalogStitcherServiceRef` and verify it receives the stitcher. The integration test backend can verify this.

---

##### Task 1.2: Fix GET/DELETE route typing

GET and DELETE status routes use unsafe casts:

```typescript
(router as unknown as express.Router).get(...)
(router as unknown as express.Router).delete(...)
```

While POST uses the typed router directly:

```typescript
router.post(...)
```

**Investigation needed:** Determine why GET and DELETE can't use the typed router. Two approaches:

**Approach A (preferred): Regenerate OpenAPI router to include status routes**

The OpenAPI spec already defines all three methods on `/entities/by-name/{kind}/{namespace}/{name}/status`. If the generated `router.ts` includes typed handlers for GET and DELETE, the unsafe casts are unnecessary. Check if the generated code has the route definitions and if the typed router supports GET/DELETE method handlers.

**Approach B: Use `express.Router()` directly with type-safe wrappers**

If the generated router doesn't support these methods, create typed wrapper functions:

```typescript
// createRouter.ts

function addStatusRoutes(
  expressRouter: express.Router,
  handlers: {
    getStatusSources: express.RequestHandler;
    updateStatus: express.RequestHandler;
    deleteStatus: express.RequestHandler;
  },
) {
  expressRouter.get(
    '/entities/by-name/:kind/:namespace/:name/status',
    handlers.getStatusSources,
  );
  expressRouter.post(
    '/entities/by-name/:kind/:namespace/:name/status',
    handlers.updateStatus,
  );
  expressRouter.delete(
    '/entities/by-name/:kind/:namespace/:name/status',
    handlers.deleteStatus,
  );
}

// Usage:
addStatusRoutes(router, {
  getStatusSources: async (req, res) => {
    /* ... */
  },
  updateStatus: async (req, res) => {
    /* ... */
  },
  deleteStatus: async (req, res) => {
    /* ... */
  },
});
```

This eliminates the unsafe casts by explicitly acknowledging that these routes go through Express directly.

**Files to change:**

- `plugins/catalog-backend/src/service/createRouter.ts`

**Validation:** `yarn tsc` passes. No `as unknown as` casts remain for status route registration. All three endpoints function identically.

---

#### Phase 2: P1 Consistency Fixes

##### Task 2.1: Add entity existence check to GET endpoint

The GET endpoint checks permissions but doesn't verify the entity exists. For a non-existent entity, it returns `{ sources: [] }` with 200, which is inconsistent with POST/DELETE and could leak information (probing whether an entityRef ever had status data).

**Files to change:**

- `plugins/catalog-backend/src/service/createRouter.ts`

Add entity existence check after the permission check:

```typescript
// GET /status handler — after permission check

const credentials = await httpAuth.credentials(req);

const decision = await permissionsService.authorize(
  [{ permission: catalogEntityReadPermission, resourceRef: entityRef }],
  { credentials },
);

if (decision[0].result !== AuthorizeResult.ALLOW) {
  throw new NotAllowedError('Unauthorized to read status');
}

// Entity existence check (consistent with POST/DELETE)
const { items } = await entitiesCatalog!.entitiesBatch({
  entityRefs: [entityRef],
  credentials,
});

if (!(items as unknown as any[])[0]) {
  throw new NotFoundError(`Entity not found: ${entityRef}`);
}

const sources = await statusStore.listSources(entityRef);
res.json({ sources });
```

**Validation:** GET for non-existent entity returns 404. GET for existing entity with no status returns `{ sources: [] }` with 200. Integration test updated.

---

##### Task 2.2: Make merger `init()` awaitable before `merge()` calls

Mergers can be called in `merge()` before their `init()` completes because init is fire-and-forget:

```typescript
merger.init({ stitcher }).catch(e => {
  console.error(`Failed to initialize StitchingStatusMerger: ${e}`);
});
```

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogPlugin.ts`

Track init state per-merger:

```typescript
class CatalogStitchingExtensionPointImpl
  implements CatalogStitchingExtensionPoint
{
  #mergers = new Array<StitchingStatusMerger>();
  #stitcher?: CatalogStitcherService;
  #initPromises = new Map<StitchingStatusMerger, Promise<void>>();

  addStitchingStatusMerger(merger: StitchingStatusMerger): void {
    this.#mergers.push(merger);
    if (this.#stitcher && merger.init) {
      const initPromise = merger.init({ stitcher: this.#stitcher }).catch(e => {
        console.error(`Failed to initialize StitchingStatusMerger: ${e}`);
      });
      this.#initPromises.set(merger, initPromise);
    }
  }

  get mergers() {
    return this.#mergers;
  }

  /** Returns a promise that resolves when all mergers have finished init */
  get initComplete(): Promise<void> {
    return Promise.all([...this.#initPromises.values()]).then(() => {});
  }

  setStitcher(stitcher: CatalogStitcherService) {
    this.#stitcher = stitcher;
    for (const merger of this.#mergers) {
      if (merger.init) {
        const initPromise = merger.init({ stitcher }).catch(e => {
          console.error(`Failed to initialize StitchingStatusMerger: ${e}`);
        });
        this.#initPromises.set(merger, initPromise);
      }
    }
  }
}
```

Then in the plugin init, wait for init before starting processing:

```typescript
// CatalogPlugin.ts — after builder.build()

const { processingEngine, router, stitcher } = await builder.build();

stitchingExtensions.setStitcher(stitcher);

// Wait for all merger init() calls to complete before starting processing
await stitchingExtensions.initComplete;

if (config.getOptional('catalog.processingInterval') ?? true) {
  lifecycle.addStartupHook(async () => {
    await processingEngine.start();
  });
}
```

**Alternative (simpler):** Add a `#ready` flag that `merge()` checks:

```typescript
class CatalogStitchingExtensionPointImpl {
  #ready = false;
  #initPromise: Promise<void> = Promise.resolve();

  setStitcher(stitcher: CatalogStitcherService) {
    this.#stitcher = stitcher;
    const inits = this.#mergers
      .filter(m => m.init)
      .map(m =>
        m.init!({ stitcher }).catch(e => {
          console.error(`Failed to initialize StitchingStatusMerger: ${e}`);
        }),
      );
    this.#initPromise = Promise.all(inits).then(() => {
      this.#ready = true;
    });
  }
}
```

The `await stitchingExtensions.initComplete` approach is preferred because it ensures mergers are ready before any stitching begins.

**Validation:** If a merger's `init()` throws, it's logged but doesn't block startup. If `init()` is slow, stitching waits. Existing integration test still passes.

---

#### Phase 3: P2 Performance and Scalability

##### Task 3.1: Move orphan cleanup out of stitching hot path

The current code runs `cleanOrphanedStatuses()` on every deferred stitch `loadTasks` call:

```typescript
// In DefaultStitcher.ts deferred pipeline loadTasks:
const cleaned = await this.statusStore.cleanOrphanedStatuses();
```

This LEFT JOIN runs on every polling cycle, adding DB overhead proportional to table size.

**Files to change:**

- `plugins/catalog-backend/src/stitching/DefaultStitcher.ts`

Remove the orphan cleanup from `loadTasks`:

```typescript
// REMOVE from loadTasks:
// const cleaned = await this.statusStore.cleanOrphanedStatuses();
```

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogPlugin.ts`

Add periodic cleanup via lifecycle hook:

```typescript
// CatalogPlugin.ts — after processing engine start

lifecycle.addStartupHook(async () => {
  await processingEngine.start();

  // Periodic orphan cleanup — runs every processingInterval
  const intervalMs = durationToMilliseconds(
    readStitchingStrategy(config).pollingInterval,
  );
  setInterval(async () => {
    try {
      const statusStore = new DefaultCatalogStatusStore(dbClient, logger);
      const cleaned = await statusStore.cleanOrphanedStatuses();
      if (cleaned > 0) {
        logger.debug(`Cleaned up ${cleaned} orphaned status rows`);
      }
    } catch (error) {
      logger.warn('Periodic status cleanup failed', error);
    }
  }, intervalMs * 10); // Run every 10th processing cycle
});
```

**Alternative:** Use a counter in `DefaultStitcher` to only run cleanup every Nth cycle:

```typescript
// DefaultStitcher.ts
#cleanupCounter = 0;

// In loadTasks:
if (++this.#cleanupCounter % 10 === 0) {
  try {
    const cleaned = await this.statusStore.cleanOrphanedStatuses();
    // ...
  } catch (error) {
    /* ... */
  }
}
```

The counter approach is simpler and keeps the cleanup inside the stitcher (where `statusStore` is already available). Preferred for minimal change.

**Validation:** Orphan cleanup still runs periodically but not on every cycle. Existing integration test passes (cleanup is tested separately).

---

##### Task 3.2: Add batch status write endpoint

Writing status for N entities requires N HTTP requests, each potentially triggering a stitch. This is inefficient for monitoring systems or bulk operations.

**Files to change:**

- `plugins/catalog-backend/src/schema/openapi.yaml`
- `plugins/catalog-backend/src/service/createRouter.ts`
- `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`

Add a new POST endpoint for batch operations:

```yaml
# openapi.yaml
/entities/status/batch:
  post:
    operationId: BatchUpdateEntityStatus
    tags:
      - Entity
    description: Update status for multiple entities in a single request.
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            required:
              - updates
            properties:
              updates:
                type: array
                items:
                  type: object
                  required:
                    - entityRef
                    - source
                    - status
                  properties:
                    entityRef:
                      type: string
                    source:
                      type: string
                    status:
                      type: object
                maxItems: 100
    responses:
      '204':
        description: All status updates applied. Stitching triggered for affected entities.
      '400':
        $ref: '#/components/responses/ErrorResponse'
      default:
        $ref: '#/components/responses/ErrorResponse'
```

```typescript
// createRouter.ts
router.post('/entities/status/batch', async (req, res) => {
  disallowReadonlyMode(readonlyEnabled);

  const credentials = await httpAuth.credentials(req);

  const { updates } = await validateRequestBody(
    req,
    z.object({
      updates: z
        .array(
          z.object({
            entityRef: z.string().min(1),
            source: z.string().min(1).max(128),
            status: z.record(z.any()),
          }),
        )
        .min(1)
        .max(100),
    }),
  );

  // Batch permission check
  const entityRefs = [...new Set(updates.map(u => u.entityRef))];
  const decisions = await permissionsService.authorize(
    entityRefs.map(ref => ({
      permission: catalogEntityStatusWritePermission,
      resourceRef: ref,
    })),
    { credentials },
  );

  const deniedRef = entityRefs.find(
    (_, i) => decisions[i].result !== AuthorizeResult.ALLOW,
  );
  if (deniedRef) {
    throw new NotAllowedError(`Unauthorized to update status for ${deniedRef}`);
  }

  // Batch entity existence check
  const { items } = await entitiesCatalog!.entitiesBatch({
    entityRefs,
    credentials,
  });
  const missingRef = entityRefs.find((_, i) => !(items as unknown as any[])[i]);
  if (missingRef) {
    throw new NotFoundError(`Entity not found: ${missingRef}`);
  }

  // Validate all sources and payloads
  for (const update of updates) {
    validateSource(update.source);
    validateStatusPayload(update.status);
  }

  // Batch write
  await Promise.all(
    updates.map(u => statusStore.setStatus(u.entityRef, u.source, u.status)),
  );

  // Single stitch for all affected entities
  const stitchDeferred = req.query.stitch === 'deferred';
  if (!stitchDeferred) {
    await stitcher.stitch({ entityRefs });
  }

  res.status(204).end();
});
```

Add batch `setStatus` to store for transactional writes:

```typescript
// DefaultCatalogStatusStore.ts
async batchSetStatus(
  updates: Array<{ entityRef: string; source: string; status: JsonObject }>,
): Promise<void> {
  await this.db.transaction(async (tx) => {
    for (const { entityRef, source, status } of updates) {
      await tx('entity_status')
        .insert({
          entity_ref: entityRef.toLowerCase(),
          source,
          status: JSON.stringify(status),
          updated_at: tx.fn.now(),
        })
        .onConflict(['entity_ref', 'source'])
        .merge(['status', 'updated_at']);
    }
  });
}
```

**Validation:** Batch write for 5 entities in one request. Each gets status reflected after stitch. Test with `?stitch=deferred`. Test with mix of valid/invalid entities (should fail entire batch).

---

#### Phase 4: P3 Quality Improvements

##### Task 4.1: Sanitize status at write time (defense in depth)

Currently, malicious `javascript:` values are stored raw and only sanitized during stitching. Add sanitization to the write path.

**Files to change:**

- `plugins/catalog-backend/src/util/status.ts`

Add `sanitizeStatus` call to the validation pipeline:

```typescript
// util/status.ts — update validateStatusPayload

export function validateStatusPayload(status: JsonObject): void {
  if (RESERVED_STATUS_KEYS.some(k => k in status)) {
    throw new InputError(
      `Status keys conflict with reserved fields: ${RESERVED_STATUS_KEYS.join(
        ', ',
      )}`,
    );
  }

  const serializedSize = JSON.stringify(status).length;
  if (serializedSize > MAX_STATUS_SIZE) {
    throw new InputError(
      `Status payload too large (${serializedSize} bytes, max ${MAX_STATUS_SIZE})`,
    );
  }

  // Sanitize at write time so DB always stores clean data
  sanitizeStatus(status);
}
```

Keep the stitch-time `sanitizeStatus()` in `performStitching.ts` as a second line of defense.

**Files to change:**

- `plugins/catalog-backend/src/util/status.test.ts`

Add test that sanitization happens during validation:

```typescript
it('sanitizes dangerous protocols during validation', () => {
  const status = { url: 'javascript:alert(1)' };
  validateStatusPayload(status);
  expect(status.url).toBe(
    'https://backstage.io/annotation-rejected-for-security-reasons',
  );
});
```

**Validation:** POST with `javascript:` value in status stores sanitized value in DB. Stitch-time sanitization is a no-op (already clean).

---

##### Task 4.2: Document `updated_at` column purpose

The `updated_at` column is written on every upsert but never consumed. It's not dead code — it enables future features:

- **TTL/staleness detection**: Compare `updated_at` to current time to detect stale status sources
- **Audit trail**: Track when each source last updated its status
- **Debugging**: Inspect freshness of status data directly in DB

**Files to change:**

- `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`

Add JSDoc to the class:

```typescript
/**
 * Stores out-of-band entity status data. Each status entry is keyed by
 * (entity_ref, source) and stores an arbitrary JSON payload.
 *
 * The `updated_at` column tracks the last write time for each source,
 * enabling future TTL/staleness detection and audit capabilities.
 */
```

**No code changes needed** — the column serves a documentation purpose.

---

##### Task 4.3: Add limit to `listSources`

`listSources` returns all sources for an entity with no bound on the result set.

**Files to change:**

- `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`

Add an optional limit parameter:

```typescript
async listSources(entityRef: string, limit: number = 100): Promise<string[]> {
  const rows = await this.db('entity_status')
    .where('entity_ref', entityRef.toLowerCase())
    .select('source')
    .limit(limit);
  return rows.map(r => r.source);
}
```

This is a backward-compatible change — the default limit of 100 is generous for any realistic use case.

**Files to change:**

- `plugins/catalog-backend/src/service/createRouter.ts`

Pass through optional query parameter:

```typescript
// GET /status handler
const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 1000);
const sources = await statusStore.listSources(entityRef, limit);
res.json({ sources });
```

**Validation:** GET with no `limit` returns up to 100 sources. GET with `?limit=10` returns up to 10. GET with `?limit=9999` caps at 1000.

---

## System-Wide Impact

### Interaction Graph

```
Service factory wiring:
  Module depends on catalogStitcherServiceRef
  → DI container resolves to factory registered in CatalogPlugin.ts
  → Returns the same stitcher instance that CatalogBuilder created
  → stitcher.stitch() includes all registered mergers

Route typing fix:
  createRouter() → typed router handles all three status methods
  → No unsafe casts needed
  → OpenAPI generated code validates request/response types at compile time

GET entity existence:
  GET /status → auth check → entity existence check → listSources → response
  → Consistent 404 behavior across all status endpoints

Merger init coordination:
  CatalogPlugin.init() → builder.build() → stitcher created
  → setStitcher(stitcher) → merger.init() calls fire
  → await initComplete → all mergers ready
  → processingEngine.start() → stitching begins

Orphan cleanup:
  Startup: lifecycle.addStartupHook() → cleanOrphanedStatuses()
  Periodic: DefaultStitcher counter-based → every 10th loadTasks cycle
  On-demand: performStitching orphan detection → deleteAllForEntity()

Batch write:
  POST /entities/status/batch → validate all → batch permission check
  → batch existence check → batchSetStatus() in transaction
  → stitcher.stitch({ entityRefs }) → single stitch for all entities
```

### Error Propagation

| Error                            | Source                    | Behavior                                  |
| -------------------------------- | ------------------------- | ----------------------------------------- |
| Service factory resolution fails | `CatalogPlugin.ts`        | Plugin fails to start — caught by backend |
| Entity not found on GET          | `entitiesBatch()` check   | `NotFoundError` → 404                     |
| Merger init fails                | `merger.init()`           | Logged; merger still called (defensive)   |
| Batch write partial failure      | Transaction rollback      | Entire batch fails; 400 response          |
| Orphan cleanup fails             | `cleanOrphanedStatuses()` | Logged; next cycle retries                |
| Sanitization at write time       | `validateStatusPayload()` | Silent replacement; clean data stored     |

### State Lifecycle Risks

- **Service factory timing:** Factory registered inside `init()`, which runs before dependent modules' `init()`. Matches Backstage lifecycle guarantee. No race.
- **Merger init barrier:** Processing engine start waits for all merger inits. If a merger init hangs, processing doesn't start. Timeout is the startup timeout.
- **Batch write atomicity:** Uses DB transaction. If any write fails, all roll back. Caller gets 400.
- **Orphan cleanup batching:** `cleanOrphanedStatuses` runs in batches of 500. Large deletions take multiple cycles. Acceptable — orphaned rows don't affect correctness.

### API Surface Parity

| Change                                 | Impact                           | Breaking?        |
| -------------------------------------- | -------------------------------- | ---------------- |
| `catalogStitcherServiceRef` resolvable | Additive                         | No               |
| Route typing fix                       | Internal refactor                | No               |
| GET entity existence check             | Returns 404 for missing entities | Yes (alpha)      |
| Merger init coordination               | Internal behavior change         | No               |
| Orphan cleanup scheduling              | Internal behavior change         | No               |
| Batch status endpoint                  | Additive                         | No               |
| Write-time sanitization                | Silently modifies stored data    | No               |
| `listSources` limit                    | Adds default limit of 100        | Possibly (alpha) |

All breaking changes are on `@alpha` APIs, acceptable per Backstage conventions.

## Acceptance Criteria

### Functional Requirements

- [ ] `catalogStitcherServiceRef` resolves to the catalog's stitcher instance through DI
- [ ] No `(router as unknown as express.Router)` casts for status route registration
- [ ] GET `/status` returns 404 for non-existent entities
- [ ] Merger `init()` completes before any `merge()` calls during processing
- [ ] Orphan cleanup runs periodically, not on every stitch cycle
- [ ] Batch status write endpoint accepts up to 100 updates in one request
- [ ] Status values are sanitized at write time and at stitch time
- [ ] `listSources` returns at most `limit` results (default 100, max 1000)

### Non-Functional Requirements

- [ ] `yarn tsc` passes at project root
- [ ] `CI=1 yarn test plugins/catalog-backend/src/service/createRouter.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/database/DefaultCatalogStatusStore.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/tests/status-integration.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/stitching/DefaultStitcher.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/util/status.test.ts` passes
- [ ] OpenAPI spec updated for batch endpoint and GET limit parameter
- [ ] Changeset file updated for all affected packages

### Quality Gates

- [ ] External module can resolve `catalogStitcherServiceRef` and call `stitch()`
- [ ] No unsafe type casts in status route registration
- [ ] All three status endpoints return 404 for non-existent entities
- [ ] Batch endpoint processes 100 updates in under 1 second
- [ ] No `javascript:` or `vbscript:` values stored in `entity_status` table
- [ ] Orphan cleanup overhead removed from stitch hot path

## Dependencies & Risks

**Dependencies:**

- Task 1.1 (service factory) is self-contained
- Task 1.2 (route typing) is self-contained but may require OpenAPI regeneration
- Task 2.1 (GET existence check) depends on Task 1.2 (route structure)
- Task 2.2 (merger init) is self-contained
- Task 3.1 (orphan cleanup) is self-contained
- Task 3.2 (batch endpoint) depends on Task 1.2 (route structure)
- Task 4.x (quality) are all independent

**Risks:**

- **OpenAPI regeneration:** Task 1.2 may require updating the OpenAPI spec and regenerating code. If the generator doesn't support all three methods, Approach B (typed wrappers) is the fallback.
- **Merger init timeout:** If a merger's `init()` hangs indefinitely, it blocks processing engine startup. Mitigate by adding a timeout (e.g., 30 seconds) to the init promise.
- **Batch endpoint size limit:** 100 updates per request is a reasonable default but may need tuning based on payload sizes. The `MAX_STATUS_SIZE` of 64KB per status means a max batch is ~6.4MB, which is within typical HTTP body limits.
- **GET existence check adds a DB query:** The GET endpoint now does one more `entitiesBatch()` call per request. For high-traffic GET endpoints, this could be a concern. Mitigate by caching entity existence in the permission check result (which already queries entities).

## Alternative Approaches Considered

**1. Lazy service factory (resolve on first use instead of eager registration)**
Rejected: Backstage's DI system requires factory registration during plugin init. There's no lazy resolution mechanism. The inline factory approach is the standard pattern.

**2. Keep unsafe casts, add runtime type checking**
Rejected: The unsafe casts indicate a type system gap. Runtime checking adds overhead and doesn't provide compile-time safety. Fixing the root cause (proper typing) is better.

**3. Don't add entity existence to GET (keep returning empty sources)**
Rejected: Inconsistent with POST/DELETE behavior. Information leak (can probe for entity refs that had status data). 404 is the correct RESTful response.

**4. Don't await merger init (keep fire-and-forget but add ready flag)**
Rejected: A ready flag requires checking in every merge() call, adding overhead and complexity. Awaiting init once during startup is simpler and guarantees readiness.

**5. Use a separate background worker for orphan cleanup**
Rejected: Overkill for this use case. A counter-based approach (every Nth stitch cycle) is simpler and uses existing infrastructure. A separate worker would require additional configuration and monitoring.

**6. Make batch endpoint non-transactional (best-effort writes)**
Rejected: Partial failures are harder for callers to handle. Transactional behavior (all-or-nothing) is simpler and more predictable. If partial success is needed, callers can split into smaller batches.

## Sources & References

### Origin

- **Architectural review:** Performed in this conversation session, identified 10 issues across 4 priority tiers
- **Previous plan (prefetch race):** [docs/plans/2026-05-05-fix-catalog-status-api-prefetch-race-and-scalability-plan.md](2026-05-05-fix-catalog-status-api-prefetch-race-and-scalability-plan.md)
- **Previous plan (design flaws):** [docs/plans/2026-05-05-fix-catalog-status-api-design-flaws-plan.md](2026-05-05-fix-catalog-status-api-design-flaws-plan.md)
- **Previous plan (remaining fixes):** [docs/plans/2026-05-05-fix-catalog-status-api-remaining-fixes-plan.md](2026-05-05-fix-catalog-status-api-remaining-fixes-plan.md)
- **Previous plan (review recommendations):** [docs/plans/2026-05-05-fix-catalog-status-api-review-recommendations-plan.md](2026-05-05-fix-catalog-status-api-review-recommendations-plan.md)
- **Previous plan (architectural issues):** [docs/plans/2026-05-04-fix-catalog-status-api-architectural-issues-plan.md](2026-05-04-fix-catalog-status-api-architectural-issues-plan.md)

### Internal References

- Service ref: `plugins/catalog-node/src/catalogStitcherService.ts`
- Plugin wiring: `plugins/catalog-backend/src/service/CatalogPlugin.ts:208-320`
- Unsafe casts: `plugins/catalog-backend/src/service/createRouter.ts:986,1070`
- GET handler: `plugins/catalog-backend/src/service/createRouter.ts:986-1009`
- Merger init: `plugins/catalog-backend/src/service/CatalogPlugin.ts:110-130`
- Orphan cleanup location: `plugins/catalog-backend/src/stitching/DefaultStitcher.ts:189-197`
- Status store: `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`
- RouterOptions: `plugins/catalog-backend/src/service/createRouter.ts:77-99`
- OpenAPI spec: `plugins/catalog-backend/src/schema/openapi.yaml`
- Generated router: `plugins/catalog-backend/src/schema/openapi/generated/router.ts`
- Lifecycle hooks: `plugins/catalog-backend/src/service/CatalogPlugin.ts:320-330`
- Changeset conventions: `CONTRIBUTING.md#creating-changesets`
