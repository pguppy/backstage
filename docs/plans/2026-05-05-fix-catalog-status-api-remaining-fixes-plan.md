---
title: 'Fix Catalog Status API Remaining Architectural Fixes'
type: fix
status: active
date: 2026-05-05
origin: docs/plans/2026-05-04-fix-catalog-status-api-architectural-issues-plan.md
---

# Fix Catalog Status API Remaining Architectural Fixes

## Overview

This plan addresses the remaining architectural issues in the catalog entity status API that were NOT covered by the three previous plans or have emerged since. Previous plans addressed: ALS removal, merger cache pattern, DELETE endpoint, source validation, vbscript sanitization, index migration, 404 semantics, GET sources endpoint, and shared validation extraction.

**What's already implemented:**

- BuiltinStatusMerger with class-owned cache (replaced ALS)
- EntityStatusQuery interface (replaced raw Knex exposure)
- Source validation (`validateSource` in `util/status.ts`)
- Status payload validation (`validateStatusPayload` in `util/status.ts`)
- vbscript sanitization in `sanitizeStatus`
- `scriptProtocolPattern` deduplicated (moved to `util/status.ts`)
- DELETE endpoint with entity existence check and 404 semantics
- GET sources endpoint (`listSources`)
- Database index on `entity_ref` (migration `20260506000000`)
- `catalogStitchingExtensionPoint` with merger lifecycle
- Integration test for full lifecycle (write/verify/delete/404)
- Unit tests for validation and sanitization
- OpenAPI spec for all three status endpoints

**What this plan fixes (6 issues across 3 severity tiers):**

| #   | Issue                                                           | Severity | Source                                                          |
| --- | --------------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| 1   | `catalogStitcherServiceRef` not wired as providable service     | High     | Plan 1, Plan 2; dist declares factory but source missing        |
| 2   | Source name not validated against reserved `entity.status` keys | High     | New finding; source="items" silently overwrites existing status |
| 3   | No orphan cleanup when entities are deleted                     | High     | New finding; `entity_status` rows persist after entity deletion |
| 4   | Double DB hit in performStitching merger path                   | Medium   | New finding; preFetch caches but merge's query hits DB again    |
| 5   | Breaking change to `createRouter` RouterOptions undocumented    | Medium   | New finding; `statusStore` and `stitcher` now required          |
| 6   | Missing changesets for published packages                       | Medium   | Process requirement per CLAUDE.md                               |

## Proposed Solution

Six targeted fixes across 3 phases. Each phase is independently deployable.

## Technical Approach

### Architecture

The `catalogStitcherServiceRef` wiring follows the existing Backstage pattern: register a service factory inside `CatalogPlugin.ts` after `builder.build()` returns the stitcher. The stitcher instance already has all mergers attached.

The source name collision fix adds a single guard to `validateSource()` checking against `RESERVED_STATUS_KEYS`. This catches the case where a source named `"items"` would overwrite the existing `entity.status.items` array.

Orphan cleanup hooks into the entity deletion path in `DefaultStitcher` via a database-level cascade or application-level hook.

The double DB hit is resolved by wrapping the `EntityStatusQuery` passed to `merge()` with a read-through cache that serves prefetched data first.

### Design Decisions

| Decision                     | Choice                                                 | Rationale                                                                                             |
| ---------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Service factory registration | Inline in `CatalogPlugin.ts` init                      | Same pattern as other plugin-provided services; stitcher exists after `build()`                       |
| Source name collision guard  | Check in `validateSource()`                            | Source name becomes a top-level key in `entity.status`; must not collide with `items`                 |
| Orphan cleanup strategy      | Application-level in `performStitching` + store method | DB-level cascade would require FK to `refresh_state` which doesn't exist; application hook is simpler |
| Query caching                | Wrap with Map-based cache                              | Avoids changing the `EntityStatusQuery` interface; custom mergers benefit transparently               |
| RouterOptions break          | Document in changeset                                  | `createRouter` is public API; callers must be informed of new required fields                         |

### Implementation Phases

#### Phase 1: High Severity Fixes

##### Task 1.1: Wire catalogStitcherServiceRef as providable service

The `catalogStitcherServiceRef` is exported from `catalog-node/alpha` and declared in the compiled dist, but no `createServiceFactory` call exists in the source tree. The stitcher created by `CatalogBuilder.build()` is passed to `stitchingExtensions.setStitcher()` but not registered as a DI service.

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogPlugin.ts`

After the `builder.build()` call, register the stitcher as a service factory:

```typescript
// CatalogPlugin.ts — after const { processingEngine, router, stitcher } = await builder.build();

import { catalogStitcherServiceRef } from '@backstage/plugin-catalog-node/alpha';

// Inside the init function, after builder.build():
stitchingExtensions.setStitcher(stitcher);

// Register the stitcher as a resolvable service
env.registerServiceFactory(
  createServiceFactory({
    service: catalogStitcherServiceRef,
    deps: {},
    factory: () => stitcher,
  }),
);
```

Import `createServiceFactory` from `@backstage/backend-plugin-api` (already imported in this file).

**Important:** The `createServiceFactory` call must happen inside the `init` function (not at module level) because the stitcher is created asynchronously. The factory closure captures the `stitcher` variable from the enclosing scope.

**Validation:** Create a test module that depends on `catalogStitcherServiceRef` and verify it receives the stitcher instance. The stitcher should be the same instance that the catalog uses internally (with all mergers attached).

##### Task 1.2: Validate source name against reserved entity.status keys

The status data is merged into `entity.status` with source name as a top-level key. If source name is `"items"`, it overwrites the existing `entity.status.items` array that `performStitching` populates with processing errors.

```
getStatuses() returns: { "items": { ok: true } }
BuiltinStatusMerger.merge() spreads: entity.status = { ...entity.status, ...{ items: { ok: true } } }
Result: entity.status.items is now { ok: true } instead of [...error items]
```

**Files to change:**

- `plugins/catalog-backend/src/util/status.ts`

Add reserved key check to `validateSource()`:

```typescript
// util/status.ts — update validateSource()

export function validateSource(source: string): void {
  if (source.length === 0) {
    throw new InputError('source must not be empty');
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new InputError(
      `source must not exceed ${MAX_SOURCE_LENGTH} characters (got ${source.length})`,
    );
  }
  if (!SOURCE_PATTERN.test(source)) {
    throw new InputError(
      `source contains invalid characters; only alphanumeric, dots, dashes, and underscores are allowed`,
    );
  }
  if (RESERVED_STATUS_KEYS.includes(source as any)) {
    throw new InputError(
      `source name conflicts with reserved status fields: ${RESERVED_STATUS_KEYS.join(
        ', ',
      )}`,
    );
  }
}
```

This uses the existing `RESERVED_STATUS_KEYS` constant that already includes `'items'`. If new reserved keys are added in the future, the guard automatically covers them.

**Files to change:**

- `plugins/catalog-backend/src/util/status.test.ts`

Add test:

```typescript
it('rejects source that conflicts with reserved status keys', () => {
  expect(() => validateSource('items')).toThrow(InputError);
});
```

**Validation:** POST with source "items" returns 400. POST with source "github" succeeds. Existing `validateSource` tests still pass.

##### Task 1.3: Add orphan cleanup for deleted entities

When an entity is deleted from the catalog, its rows in `entity_status` remain forever. Over time this table accumulates orphaned data.

**Strategy:** Add a `deleteAllForEntity(entityRef: string)` method to the store and hook into the stitcher's entity deletion path.

**Files to change:**

- `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`

```typescript
// DefaultCatalogStatusStore.ts — add new method

async deleteAllForEntity(entityRef: string): Promise<number> {
  return this.db('entity_status')
    .where('entity_ref', entityRef.toLowerCase())
    .delete();
}
```

**Files to change:**

- `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`

Hook into the orphan detection path. When `performStitching` detects an orphan (already flagged with `backstage.io/orphan` annotation), clean up status rows:

```typescript
// performStitching.ts — after the orphan detection block, around line 173-178

if (isOrphan) {
  logger.debug(`${entityRef} is an orphan`);
  entity.metadata.annotations = {
    ...entity.metadata.annotations,
    ['backstage.io/orphan']: 'true',
  };
  // Clean up orphaned status data
  try {
    await options.statusStore.deleteAllForEntity(entityRef);
  } catch (error) {
    logger.warn(
      `Failed to clean up status for orphaned entity ${entityRef}`,
      error,
    );
  }
}
```

Note: This only triggers for orphaned entities (entities with no incoming references). Entities deleted through the location/location-service deletion path should also trigger cleanup. This requires a hook in the deletion flow.

**Alternative: Scheduled cleanup.** Add a periodic cleanup that removes status rows for entity refs not present in `refresh_state`. This is more robust but more complex. For the initial implementation, the orphan-detection hook is sufficient.

**Files to change:**

- `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.test.ts`

```typescript
it.each(databases.eachSupportedId())(
  'should delete all status for an entity on %p',
  async id => {
    const knex = await databases.init(id);
    await applyDatabaseMigrations(knex);
    const store = new DefaultCatalogStatusStore(
      knex,
      mockServices.logger.mock(),
    );

    await store.setStatus('component:default/test', 'source1', { a: 1 });
    await store.setStatus('component:default/test', 'source2', { b: 2 });
    await store.setStatus('component:default/other', 'source1', { c: 3 });

    const deleted = await store.deleteAllForEntity('component:default/test');
    expect(deleted).toBe(2);

    const remaining = await store.getStatuses(['component:default/other']);
    expect(remaining.get('component:default/other')).toEqual({
      source1: { c: 3 },
    });
  },
);
```

**Validation:** Orphaned entities have their status rows cleaned up on next stitch cycle. Non-orphaned entities retain their status.

---

#### Phase 2: Medium Severity Fixes

##### Task 2.1: Cache EntityStatusQuery results to avoid double DB hits

`DefaultStitcher.preFetchStatus()` batch-loads status data for all refs. The `BuiltinStatusMerger` stores this in its `#cache`. But `performStitching` creates a fresh `EntityStatusQuery` that calls `statusStore.getStatuses()` directly. If a custom merger calls `query.getStatuses()` with the same refs, it hits the DB again.

**Fix:** Wrap the `EntityStatusQuery` passed to `merge()` with a caching layer.

**Files to change:**

- `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`

```typescript
// performStitching.ts — replace the EntityStatusQuery construction in the merger block

if (stitchingStatusMergers?.length) {
  // Pre-populate cache from the store
  const prefetched = await options.statusStore.getStatuses([entityRef]);

  const query: EntityStatusQuery = {
    getStatuses: async (refs: string[]) => {
      // Serve from cache first, fall through to store for uncached refs
      const cached = new Map<string, Record<string, JsonObject>>();
      const uncached: string[] = [];

      for (const ref of refs) {
        const hit = prefetched.get(ref);
        if (hit) {
          cached.set(ref, hit);
        } else {
          uncached.push(ref);
        }
      }

      if (uncached.length > 0) {
        const fetched = await options.statusStore.getStatuses(uncached);
        for (const [ref, data] of fetched) {
          cached.set(ref, data);
        }
      }

      return cached;
    },
  };

  for (const merger of stitchingStatusMergers) {
    try {
      await merger.merge({ entity, entityRef, query });
    } catch (error) {
      logger.warn(`StitchingStatusMerger failed for ${entityRef}`, error);
    }
  }
}
```

Wait — this would fetch for each entity individually, which is worse than the current batch. The better approach is to pre-batch at the stitcher level and pass the cache down.

**Better fix:** Have `DefaultStitcher` pass its pre-fetched data through to `performStitching`.

**Files to change:**

- `plugins/catalog-backend/src/stitching/DefaultStitcher.ts`

```typescript
// DefaultStitcher.ts — add prefetched status to stitchOne options

private prefetchedStatuses = new Map<string, Record<string, JsonObject>>();

private async preFetchStatus(entityRefs: string[]) {
  if (!this.stitchingStatusMergers?.length || entityRefs.length === 0) return;

  // Pre-fetch for the built-in merger AND for the query cache
  this.prefetchedStatuses = await this.statusStore.getStatuses(entityRefs);

  // ... existing merger preFetch calls ...
}

async #stitchOne(options: { entityRef: string; stitchTicket?: string }) {
  // ... existing code ...
  track.run(
    {
      // ... existing params ...
    },
    () =>
      performStitching({
        // ... existing params ...
        prefetchedStatuses: this.prefetchedStatuses,  // ADD
      }),
  );
}
```

**Files to change:**

- `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`

```typescript
// performStitching.ts — add prefetchedStatuses to options

export async function performStitching(options: {
  // ... existing params ...
  prefetchedStatuses?: Map<string, Record<string, JsonObject>>;
}) {

// In the merger block:
if (stitchingStatusMergers?.length) {
  const prefetched = options.prefetchedStatuses ?? new Map();

  const query: EntityStatusQuery = {
    getStatuses: async (refs: string[]) => {
      // Serve from prefetched cache, fall through to store for misses
      const result = new Map<string, Record<string, JsonObject>>();
      const uncached: string[] = [];

      for (const ref of refs) {
        const cached = prefetched.get(ref);
        if (cached) {
          result.set(ref, cached);
        } else {
          uncached.push(ref);
        }
      }

      if (uncached.length > 0) {
        const fetched = await options.statusStore.getStatuses(uncached);
        for (const [ref, data] of fetched) {
          result.set(ref, data);
        }
      }

      return result;
    },
  };

  for (const merger of stitchingStatusMergers) {
    try {
      await merger.merge({ entity, entityRef, query });
    } catch (error) {
      logger.warn(`StitchingStatusMerger failed for ${entityRef}`, error);
    }
  }
}
```

This way, custom mergers that call `query.getStatuses()` get cache hits for the entity refs that were batch-prefetched, and only hit the DB for refs outside the batch.

**Validation:** Custom merger calling `query.getStatuses([entityRef])` gets data from cache without DB hit. Calling with an uncached ref falls through to the store.

##### Task 2.2: Document RouterOptions breaking change

The `createRouter` function's `RouterOptions` now requires `statusStore` and `stitcher`. Callers who use `createRouter` directly (bypassing `CatalogBuilder`) must provide these.

**Files to change:**

- `.changeset/` (new changeset file)

Create a changeset documenting the breaking change:

```yaml
# .changeset/catalog-status-api-remaining-fixes.md
---
'@backstage/plugin-catalog-backend': minor
'@backstage/plugin-catalog-node': minor
'@backstage/plugin-catalog-common': patch
---
Status API improvements: catalog entity status API now properly wires the stitcher service ref for external plugin use, validates source names against reserved keys, and cleans up orphaned status data. The `createRouter` function now requires `statusStore` and `stitcher` in its options — callers using `CatalogBuilder` are unaffected.
```

Follow the project convention: `minor` for packages below 1.0.0 (as per CLAUDE.md: "non-breaking changes that introduce new APIs or features, use minor for packages at version 1.0.0 or higher, and patch for packages below version 1.0.0"). Since `@backstage/plugin-catalog-backend` is below 1.0.0, use `patch` unless this includes breaking changes, in which case use `minor`.

Actually, re-reading the project rules: "Breaking changes must be accompanied by a minor version bump for packages below version 1.0.0". Since adding required fields to RouterOptions is breaking for direct callers, this needs `minor` for `catalog-backend`.

**Validation:** Changeset file exists and follows project conventions.

---

#### Phase 3: Test Coverage

##### Task 3.1: Update createRouter.test.ts for new RouterOptions

**Files to change:**

- `plugins/catalog-backend/src/service/createRouter.test.ts`

The test mock for `RouterOptions` must include `statusStore` and `stitcher`. Check if the existing test already has these (it was listed as modified in git status).

```typescript
// Ensure these are in the mock RouterOptions:
statusStore: {
  setStatus: jest.fn().mockResolvedValue(undefined),
  deleteStatus: jest.fn().mockResolvedValue(1),
  getStatuses: jest.fn().mockResolvedValue(new Map()),
  listSources: jest.fn().mockResolvedValue([]),
  deleteAllForEntity: jest.fn().mockResolvedValue(0),
} as any,
stitcher: {
  stitch: jest.fn().mockResolvedValue(undefined),
} as any,
```

##### Task 3.2: Add test for service factory resolution

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogPlugin.test.ts` (if it exists)

Or add a test case to the integration test:

```typescript
// status-integration.test.ts — add at the end
// 6. Verify catalogStitcherServiceRef resolves (if possible in test backend)
```

This is best tested via the integration test backend, which can verify that a module depending on `catalogStitcherServiceRef` receives a functional stitcher.

**Validation:** All tests pass.

---

## System-Wide Impact

### Interaction Graph

```
Service ref resolution:
  Module depends on catalogStitcherServiceRef
  → DI container resolves to factory registered in CatalogPlugin.ts
  → Returns the same stitcher instance that CatalogBuilder created
  → stitcher.stitch() includes all registered mergers

Source name collision guard:
  POST /status { source: "items" }
  → validateSource("items")
  → RESERVED_STATUS_KEYS.includes("items") === true
  → throws InputError → 400

Orphan cleanup:
  Entity deletion → entity becomes orphan (no incoming refs)
  → performStitching detects isOrphan
  → statusStore.deleteAllForEntity(entityRef)
  → Status rows removed

Query caching:
  DefaultStitcher.preFetchStatus(refs)
  → statusStore.getStatuses(refs) → prefetchedStatuses Map
  → performStitching receives prefetchedStatuses
  → merger.merge() gets EntityStatusQuery backed by cache
  → query.getStatuses() serves from cache, falls through to store for misses
```

### Error Propagation

| Error                              | Source              | Behavior                                          |
| ---------------------------------- | ------------------- | ------------------------------------------------- |
| Service factory registration fails | `CatalogPlugin.ts`  | Plugin fails to start — caught by backend startup |
| Source name is reserved key        | `validateSource()`  | `InputError` → 400                                |
| Orphan cleanup fails               | `performStitching`  | Caught and logged, stitch continues               |
| Cache miss in query                | `EntityStatusQuery` | Falls through to DB — transparent to callers      |

### State Lifecycle Risks

- **Service factory registration timing:** The factory is registered inside `init()`, which runs before any dependent module's `init()`. This matches the Backstage lifecycle guarantee. No race condition.
- **Orphan cleanup is best-effort:** If cleanup fails, orphaned rows persist but don't affect correctness. Next stitch cycle attempts cleanup again.
- **Cache consistency:** `prefetchedStatuses` is replaced on each `preFetchStatus()` call. If two batches overlap (shouldn't happen due to sequential processing), the second batch's cache replaces the first. Since each entity is processed within the same batch, this is safe.

### API Surface Parity

| Change                                            | Impact                         | Breaking?   |
| ------------------------------------------------- | ------------------------------ | ----------- |
| `catalogStitcherServiceRef` resolvable            | Additive                       | No          |
| Source name "items" rejected                      | Rejects previously valid input | Yes (alpha) |
| Orphan status cleanup                             | Internal behavior change       | No          |
| Query caching in mergers                          | Performance improvement        | No          |
| RouterOptions requires `statusStore` + `stitcher` | Direct callers must update     | Yes (alpha) |

All breaking changes are on `@alpha` APIs, acceptable per Backstage conventions.

## Acceptance Criteria

### Functional Requirements

- [ ] `catalogStitcherServiceRef` resolves to the catalog's stitcher instance through DI
- [ ] Source name "items" returns 400 when used in POST/DELETE
- [ ] Orphaned entities have status rows cleaned up during stitch
- [ ] Custom mergers calling `query.getStatuses()` get cache hits for prefetched refs
- [ ] All existing tests pass

### Non-Functional Requirements

- [ ] `yarn tsc` passes at project root
- [ ] `CI=1 yarn test plugins/catalog-backend/src/service/createRouter.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/database/DefaultCatalogStatusStore.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/tests/status-integration.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/util/status.test.ts` passes
- [ ] Changeset files created per CLAUDE.md conventions

### Quality Gates

- [ ] No orphaned `entity_status` rows after entity deletion + stitch cycle
- [ ] `catalogStitcherServiceRef` usable by external modules
- [ ] Reserved key guard prevents `entity.status.items` corruption
- [ ] No duplicate DB queries for prefetched entity refs

## Dependencies & Risks

**Dependencies:**

- Task 1.1 (service factory) is self-contained
- Task 1.2 (source validation) is self-contained
- Task 1.3 (orphan cleanup) depends on having `statusStore.deleteAllForEntity()` method
- Task 2.1 (query caching) depends on `prefetchedStatuses` being threaded through stitcher → performStitching
- Task 2.2 (changeset) depends on all prior tasks
- Task 3.x (tests) depends on all prior tasks

**Risks:**

- The `prefetchedStatuses` Map on `DefaultStitcher` is instance state that gets replaced on each `preFetchStatus()` call. In the deferred stitching mode with concurrent batches (pollingIntervalMs), the batches are sequential (highWatermark controls concurrency), so this is safe. If the stitcher is ever made concurrent, this would need a per-batch context.
- The orphan cleanup in `performStitching` only handles the orphan-detection path. Entities deleted through the REST API (DELETE /entities) go through a different path. A more complete solution would hook into `DefaultEntitiesCatalog.deleteEntity()` or equivalent. This can be addressed in a follow-up if needed.

## Alternative Approaches Considered

**1. DB-level cascade for orphan cleanup (FK from entity_status to refresh_state)**
Rejected: `entity_status` stores `entity_ref` as a string, not an FK to any table. Adding a FK would require schema changes to the existing `refresh_state` table and wouldn't work across all supported databases (SQLite FK support is limited). Application-level cleanup is simpler and more portable.

**2. Scheduled background cleanup job for orphaned status**
Rejected for initial implementation: More robust (catches entities deleted via REST API) but adds operational complexity. The orphan-detection hook in `performStitching` is a good first pass. If orphaned rows become a problem, a scheduled cleanup can be added later.

**3. Thread statusStore through mergers instead of adding prefetchedStatuses parameter**
Rejected: Would change the `StitchingStatusMerger` interface (alpha API, but unnecessary change). The cache-wrapping approach preserves the interface while improving performance.

**4. Use AsyncLocalStorage for the prefetched cache**
Rejected: Previous plan already moved away from ALS due to fragility. The explicit parameter passing is clearer and testable.

## Sources & References

### Origin

- **Plan 1:** [docs/plans/2026-05-04-fix-catalog-status-api-architectural-issues-plan.md](2026-05-04-fix-catalog-status-api-architectural-issues-plan.md) — ALS removal, merger cache, entity existence check
- **Plan 2:** [docs/plans/2026-05-05-fix-catalog-status-api-design-flaws-plan.md](2026-05-05-fix-catalog-status-api-design-flaws-plan.md) — EntityStatusQuery interface, service factory, shared validation, dedup
- **Plan 3:** [docs/plans/2026-05-05-fix-catalog-status-api-review-recommendations-plan.md](2026-05-05-fix-catalog-status-api-review-recommendations-plan.md) — Index, validation, 404 semantics, vbscript, merger ordering

### Internal References

- Service ref definition: `plugins/catalog-node/src/catalogStitcherService.ts:24-42`
- Plugin init (wiring point): `plugins/catalog-backend/src/service/CatalogPlugin.ts:315-318`
- Source validation: `plugins/catalog-backend/src/util/status.ts:31-45`
- Reserved keys constant: `plugins/catalog-backend/src/util/status.ts:28`
- BuiltinStatusMerger merge logic: `plugins/catalog-backend/src/service/CatalogBuilder.ts:126-140`
- Status spread in entity: `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts:208-222`
- Orphan detection: `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts:172-178`
- DefaultStitcher preFetch: `plugins/catalog-backend/src/stitching/DefaultStitcher.ts:98-120`
- RouterOptions interface: `plugins/catalog-backend/src/service/createRouter.ts:77-99`
- Changeset conventions: `CONTRIBUTING.md#creating-changesets`
