---
title: 'Fix Catalog Status API Prefetch Race and Scalability'
type: fix
status: active
date: 2026-05-05
origin: docs/plans/2026-05-05-fix-catalog-status-api-remaining-fixes-plan.md
---

# Fix Catalog Status API Prefetch Race and Scalability

## Overview

Architectural review identified 4 remaining issues in the catalog entity status API that were NOT covered by previous plans. The most critical is a **correctness bug**: instance-level `prefetchedStatuses` state in `DefaultStitcher` can be overwritten by concurrent batches in the `TaskPipeline`, causing status data to be missing or wrong during stitching under load. The remaining issues address data integrity, performance, and scalability.

**What's already implemented (from 4 previous plans):**

- `entity_status` table with migrations and index
- `DefaultCatalogStatusStore` with set/get/delete/list operations
- REST endpoints: GET (list sources), POST (update), DELETE (remove by source)
- `StitchingStatusMerger` extension point with `preFetch`/`merge` lifecycle
- `BuiltinStatusMerger` with class-owned cache
- `EntityStatusQuery` interface for custom mergers
- Source validation, payload validation, reserved key guards, XSS sanitization
- `catalogStitcherServiceRef` wired through DI
- Orphan cleanup in `performStitching` (orphan-detection path only)
- Entity existence checks on POST and DELETE
- Permission model with `catalogEntityStatusWritePermission`
- Integration tests, unit tests, OpenAPI spec, changesets

**What this plan fixes (4 issues across 3 severity tiers):**

| #   | Issue                                           | Severity | Root Cause                                                                                  |
| --- | ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| 1   | Prefetch race in `DefaultStitcher`              | HIGH     | Instance-level `prefetchedStatuses` Map overwritten between concurrent TaskPipeline batches |
| 2   | Same race in `BuiltinStatusMerger.#cache`       | HIGH     | Instance-level `#cache` replaced on each `preFetch` call                                    |
| 3   | Status rows leak on non-orphan entity deletion  | MEDIUM   | Cleanup only hooks into orphan-detection path; REST/manager deletions leave orphaned rows   |
| 4   | Stitching amplification on rapid status updates | MEDIUM   | Each POST triggers full synchronous stitch in immediate mode; no debounce                   |

## Problem Statement

### The Prefetch Race Condition

The `TaskPipeline` (lowWatermark: 2, highWatermark: 5) loads tasks in batches and processes them concurrently:

```
pipelineLoop iteration 1:
  loadTasks(5) → loads items [A, B, C, D, E]
    → preFetchStatus([A,B,C,D,E]) → this.prefetchedStatuses = map1
    → fires processTask(A), processTask(B), ... concurrently

pipelineLoop iteration 2 (triggered when inFlightCount drops to 2):
  loadTasks(3) → loads items [F, G, H]
    → preFetchStatus([F,G,H]) → this.prefetchedStatuses = map2  ← OVERWRITES map1
    → fires processTask(F), processTask(G), processTask(H)

Meanwhile: processTask(C) from batch 1 reads this.prefetchedStatuses
  → gets map2 (data for F,G,H) instead of map1 (data for A,B,C,D,E)
  → status data for C is MISSING or WRONG
```

This affects both `DefaultStitcher.prefetchedStatuses` and `BuiltinStatusMerger.#cache` because both store data at the instance level and replace the entire store on each `preFetch` call.

**Impact:** Under deferred stitching with concurrent batches (the default mode), entities can lose their status data or get data from other entities. In immediate mode (used by the integration test), the race doesn't manifest because stitching is synchronous per-request.

### Entity Deletion Leak

Entities are deleted through multiple paths:

1. **Orphan detection** in `performStitching` — cleanup works (implemented in previous plan)
2. **REST DELETE `/entities`** — no cleanup
3. **Location removal** (deletes all entities from that location) — no cleanup
4. **Provider full mutation** (provider stops emitting entity) — eventually triggers orphan detection

Paths 2 and 3 leave orphaned `entity_status` rows permanently.

### Stitching Amplification

In immediate stitching mode, each `POST /status` triggers `stitcher.stitch({ entityRefs: [ref] })`, which is a synchronous full stitch cycle. A monitoring system pushing status every 10 seconds for 1000 entities generates 100 full stitch cycles per second.

## Proposed Solution

Four targeted fixes across 3 phases. Phase 1 fixes the correctness bug. Phase 2 addresses data integrity. Phase 3 addresses performance and scalability.

## Technical Approach

### Architecture

The prefetch race fix replaces instance-level state with per-entity closure data. Instead of storing `prefetchedStatuses` on `this`, each stitch operation receives its own snapshot of the relevant data. The `BuiltinStatusMerger` similarly switches from a class-level cache to receiving data through the `EntityStatusQuery` that's already passed to `merge()`.

Entity deletion cleanup uses a scheduled background task rather than hooks, matching the existing Backstage pattern (no deletion hooks exist in the entity lifecycle). The cleanup queries for `entity_status` rows whose `entity_ref` doesn't exist in `refresh_state` and deletes them.

Stitching debounce is achieved by checking the stitching strategy. In immediate mode, the POST/DELETE endpoints call `stitcher.stitch()` directly. A new `?stitch=deferred` query parameter allows callers to opt into deferred stitching, which batches via the stitch queue. The default behavior (immediate) is unchanged for backwards compatibility.

### Design Decisions

| Decision                          | Choice                                     | Rationale                                                                                                                                                            |
| --------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prefetch data passing             | Per-entity closure, not instance state     | Eliminates race by design; each stitch operation gets its own data snapshot                                                                                          |
| BuiltinStatusMerger cache removal | Use `EntityStatusQuery` from merge options | The query is already backed by prefetched data; no need for separate cache                                                                                           |
| Orphaned status cleanup           | Scheduled background task                  | No deletion hooks exist in Backstage entity lifecycle; scheduled cleanup is the established pattern                                                                  |
| Cleanup schedule                  | Run every processing interval cycle        | Piggybacks on existing `processingInterval` config; no new config required                                                                                           |
| Stitching debounce                | `?stitch=deferred` query parameter         | Opt-in; preserves immediate stitching as default for backwards compatibility                                                                                         |
| Batch API                         | Deferred to follow-up                      | Batch endpoint requires careful design around partial failures, permissions, and OpenAPI schema. The 4 fixes above are higher priority and independently deployable. |

### Implementation Phases

#### Phase 1: Fix Prefetch Race Condition (HIGH)

##### Task 1.1: Replace instance-level prefetchedStatuses with per-entity data

The core fix: instead of storing prefetched status data on `this.prefetchedStatuses`, pass it as a per-operation parameter.

**Files to change:**

- `plugins/catalog-backend/src/stitching/DefaultStitcher.ts`

**Current code (broken):**

```typescript
// DefaultStitcher.ts
private prefetchedStatuses = new Map<string, Record<string, JsonObject>>();

private async preFetchStatus(entityRefs: string[]) {
  // ...
  this.prefetchedStatuses = await this.statusStore.getStatuses(entityRefs);
  // ...
}

// In stitch():
const refs = Array.isArray(entityRefs) ? entityRefs : [...entityRefs];
await this.preFetchStatus(refs);
for (const entityRef of refs) {
  await this.#stitchOne({ entityRef });  // reads this.prefetchedStatuses later
}
```

**Fixed code:**

```typescript
// DefaultStitcher.ts

// REMOVE: private prefetchedStatuses = new Map<string, Record<string, JsonObject>>();

private async preFetchStatus(entityRefs: string[]): Promise<Map<string, Record<string, JsonObject>>> {
  if (!this.stitchingStatusMergers?.length || entityRefs.length === 0) {
    return new Map();
  }

  const statuses = await this.statusStore.getStatuses(entityRefs);

  const query: EntityStatusQuery = {
    getStatuses: async (refs: string[]) => {
      return this.statusStore.getStatuses(refs);
    },
  };

  for (const merger of this.stitchingStatusMergers) {
    if (merger.preFetch) {
      try {
        await merger.preFetch({ entityRefs, query });
      } catch (error) {
        this.logger.warn('StitchingStatusMerger preFetch failed', error);
      }
    }
  }

  return statuses;
}

// In stitch() — entityRefs path:
if (entityRefs) {
  const refs = Array.isArray(entityRefs) ? entityRefs : [...entityRefs];
  const prefetchedStatuses = await this.preFetchStatus(refs);
  for (const entityRef of refs) {
    await this.#stitchOne({ entityRef, prefetchedStatuses });
  }
}

// In stitch() — entityIds path:
if (entityIds) {
  for (const chunk of chunk(Array.from(entityIds), UPDATE_CHUNK_SIZE)) {
    const rows = await this.knex<DbRefreshStateRow>('refresh_state')
      .select('entity_ref')
      .whereIn('entity_id', chunk);
    const refs = rows.map(r => r.entity_ref);
    const prefetchedStatuses = await this.preFetchStatus(refs);
    for (const row of rows) {
      await this.#stitchOne({ entityRef: row.entity_ref, prefetchedStatuses });
    }
  }
}

// In stitch() — deferred pipeline:
loadTasks: async count => {
  const items = await this.#getStitchableEntities(count, stitchTimeout);
  // NOTE: preFetch is called per-batch here. Each batch's items
  // are processed sequentially within processTask, but the next
  // loadTasks call may overlap. We store prefetched data per-item
  // to avoid the race.
  const batchStatuses = await this.preFetchStatus(items.map(i => i.entityRef));
  return items.map(item => ({
    ...item,
    prefetchedStatuses: batchStatuses,
  }));
},
processTask: async (item) => {
  return await this.#stitchOne({
    entityRef: item.entityRef,
    stitchTicket: item.stitchTicket,
    stitchRequestedAt: item.stitchRequestedAt,
    prefetchedStatuses: item.prefetchedStatuses,
  });
},
```

**Update `#stitchOne` signature:**

```typescript
async #stitchOne(options: {
  entityRef: string;
  stitchTicket?: string;
  stitchRequestedAt?: DateTime;
  prefetchedStatuses?: Map<string, Record<string, JsonObject>>;
}) {
  // ...
  performStitching({
    // ... existing params ...
    prefetchedStatuses: options.prefetchedStatuses ?? new Map(),
  });
}
```

**Key insight for the deferred pipeline:** The `DeferredStitchItem` type needs to be extended to carry `prefetchedStatuses`. Since `loadTasks` returns an array of items, we can augment each item with its batch's prefetched data. Even if batches overlap in the pipeline, each item carries its own snapshot.

##### Task 1.2: Remove BuiltinStatusMerger's class-level cache

The `BuiltinStatusMerger` currently has its own `#cache` that gets replaced on each `preFetch` call — same race as `DefaultStitcher`. Since the merger now receives prefetched data through the `EntityStatusQuery` passed to `merge()`, the separate cache is redundant.

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogBuilder.ts`

**Current code (broken):**

```typescript
class BuiltinStatusMerger implements StitchingStatusMerger {
  #cache = new Map<string, Record<string, JsonObject>>();

  constructor(private readonly statusStore: DefaultCatalogStatusStore) {}

  async preFetch(options: {
    entityRefs: string[];
    query: EntityStatusQuery;
  }): Promise<void> {
    this.#cache = await this.statusStore.getStatuses(options.entityRefs);
  }

  async merge(options: {
    entity: AlphaEntity;
    entityRef: string;
    query: EntityStatusQuery;
  }): Promise<void> {
    const statusData = this.#cache.get(options.entityRef.toLowerCase());
    if (statusData) {
      options.entity.status = {
        ...options.entity.status,
        ...statusData,
      };
    }
  }
}
```

**Fixed code:**

```typescript
class BuiltinStatusMerger implements StitchingStatusMerger {
  constructor(private readonly statusStore: DefaultCatalogStatusStore) {}

  async preFetch(options: {
    entityRefs: string[];
    query: EntityStatusQuery;
  }): Promise<void> {
    // No-op: data is pre-fetched by DefaultStitcher and served
    // through the EntityStatusQuery cache in merge().
  }

  async merge(options: {
    entity: AlphaEntity;
    entityRef: string;
    query: EntityStatusQuery;
  }): Promise<void> {
    const statuses = await options.query.getStatuses([options.entityRef]);
    const statusData = statuses.get(options.entityRef.toLowerCase());
    if (statusData) {
      options.entity.status = {
        ...options.entity.status,
        ...statusData,
      };
    }
  }
}
```

**Why this works:** The `EntityStatusQuery` passed to `merge()` in `performStitching` is already backed by the prefetched data (from `options.prefetchedStatuses`). So `query.getStatuses([entityRef])` returns from cache without hitting the DB. No instance-level state needed.

**Validation:**

- Unit test: call `merge()` with a mock `EntityStatusQuery` that returns cached data → verify entity.status is updated
- Integration test: status-integration.test.ts passes (already tests full lifecycle)
- Manual: run deferred stitching with >5 entities and verify all get correct status data

---

#### Phase 2: Complete Entity Deletion Cleanup (MEDIUM)

##### Task 2.1: Add scheduled cleanup for orphaned status rows

Since Backstage has no entity deletion hooks, add a periodic cleanup that removes `entity_status` rows whose `entity_ref` doesn't exist in `refresh_state`.

**Files to change:**

- `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`

Add a method for cleanup:

```typescript
async cleanOrphanedStatuses(batchSize: number = 500): Promise<number> {
  // Delete entity_status rows where entity_ref is not in refresh_state
  // Use LEFT JOIN to find orphans, batched to avoid large transactions
  const orphans = await this.db('entity_status')
    .select('entity_ref')
    .leftJoin('refresh_state', 'entity_status.entity_ref', 'refresh_state.entity_ref')
    .whereNull('refresh_state.entity_ref')
    .limit(batchSize);

  if (orphans.length === 0) return 0;

  const orphanRefs = orphans.map(r => r.entity_ref);
  await this.db('entity_status')
    .whereIn('entity_ref', orphanRefs)
    .delete();

  return orphanRefs.length;
}
```

**Note on SQL compatibility:** The `entity_ref` column in `refresh_state` stores entity refs in lowercase (same as `entity_status`), so the JOIN works directly. Verify this by checking `refresh_state` schema.

**Files to change:**

- `plugins/catalog-backend/src/stitching/DefaultStitcher.ts`

Hook the cleanup into the deferred stitching loop's `loadTasks` callback. This is the natural place because:

1. It runs on every polling cycle
2. It's already rate-limited by `pollingInterval`
3. It's inside the stitcher's lifecycle, not the request path

```typescript
// In the deferred pipeline's loadTasks:
loadTasks: async count => {
  const items = await this.#getStitchableEntities(count, stitchTimeout);
  // ... existing preFetch code ...

  // Periodically clean up orphaned status rows (every cycle)
  try {
    const cleaned = await this.statusStore.cleanOrphanedStatuses();
    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} orphaned status rows`);
    }
  } catch (error) {
    this.logger.warn('Failed to clean up orphaned status rows', error);
  }

  return items.map(/* ... */);
},
```

**Performance consideration:** The LEFT JOIN query on every poll cycle could be expensive for large tables. Optimize:

- Run cleanup only every N cycles (e.g., every 10th cycle) using a counter
- The `entity_ref` index on both tables makes the JOIN efficient
- The `batchSize` limit prevents large transactions

**Alternative: Startup hook.** Run cleanup once on startup via `lifecycle.addStartupHook()`. This is simpler but doesn't catch rows orphaned during runtime. A combined approach (startup + periodic) is best.

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogPlugin.ts`

Add startup cleanup:

```typescript
// After builder.build() and stitcher setup:
lifecycle.addStartupHook(async () => {
  try {
    const cleaned = await statusStore.cleanOrphanedStatuses();
    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} orphaned status rows on startup`);
    }
  } catch (error) {
    logger.warn('Failed to clean up orphaned status rows on startup', error);
  }
});
```

**Validation:**

- Create entity, push status, delete entity via REST, wait for cleanup cycle → status rows removed
- Unit test for `cleanOrphanedStatuses()` with mock data
- Verify cleanup doesn't remove status for existing entities

---

#### Phase 3: Stitching Debounce (MEDIUM)

##### Task 3.1: Add `?stitch=deferred` query parameter to POST and DELETE

Allow callers to opt into deferred stitching, which batches updates via the stitch queue instead of triggering synchronous stitch.

**Files to change:**

- `plugins/catalog-backend/src/schema/openapi.yaml`

Add optional query parameter:

```yaml
# In the POST operation:
parameters:
  - $ref: '#/components/parameters/kind'
  - $ref: '#/components/parameters/namespace'
  - $ref: '#/components/parameters/name'
  - name: stitch
    in: query
    required: false
    schema:
      type: string
      enum: [immediate, deferred]
      default: immediate
    description: >
      Stitching strategy for this update. 'immediate' (default) triggers
      synchronous stitch — the entity reflects the update when the response
      returns. 'deferred' persists the status but defers stitching — the
      entity will reflect the update once the deferred stitch queue processes it.
      Use 'deferred' for high-frequency updates to reduce load.
```

Same parameter for DELETE.

**Files to change:**

- `plugins/catalog-backend/src/service/createRouter.ts`

Update POST and DELETE handlers:

```typescript
// POST handler:
const stitchMode = req.query.stitch === 'deferred' ? 'deferred' : 'immediate';
await statusStore.setStatus(entityRef, source, status);

if (stitchMode === 'immediate') {
  await stitcher.stitch({ entityRefs: [entityRef] });
} else {
  // Mark for deferred stitching — the stitch queue will pick it up
  await stitcher.markForStitching?.({ entityRefs: [entityRef] });
}
```

**Problem:** The `Stitcher` interface only exposes `stitch()`, not `markForStitching()`. Need to check if the stitcher has a way to enqueue without immediate processing.

**Alternative approach:** In deferred stitching mode, the `stitch()` call already enqueues via `markForStitching()`. The issue is only in immediate mode, where `stitch()` processes synchronously. We can:

1. Add a `markForStitching` method to the `Stitcher` interface, or
2. Skip the `stitch()` call entirely and rely on the deferred stitch queue's polling to pick up the change

Option 2 is simpler: when `stitch=deferred`, just don't call `stitcher.stitch()`. The entity's `next_stitch_at` will eventually trigger stitching. But this means the status data might not be reflected for up to `processingInterval` seconds.

**Better approach:** Use `stitcher.stitch()` for both modes. In immediate stitching strategy, `stitch()` processes synchronously. In deferred strategy, `stitch()` marks the entity for stitching via the queue. The `?stitch=deferred` parameter is only meaningful in immediate strategy mode — it tells the server to NOT call `stitch()` at all, letting the next scheduled stitch cycle handle it.

**Implementation:**

```typescript
// POST handler:
await statusStore.setStatus(entityRef, source, status);

const stitchDeferred = req.query.stitch === 'deferred';
if (!stitchDeferred) {
  await stitcher.stitch({ entityRefs: [entityRef] });
}
```

This is the simplest and most correct approach. The response is always 204. When `stitch=deferred`, the status is persisted but stitching is not triggered — it will happen on the next scheduled cycle. The OpenAPI response description already mentions this behavior.

**For DELETE handler:** Same pattern.

**Validation:**

- POST without `stitch` parameter → status reflected immediately (existing behavior)
- POST with `stitch=deferred` → status persisted, entity reflects on next cycle
- Integration test: POST with deferred, poll entity until status appears

##### Task 3.2: Update OpenAPI generated code

After updating `openapi.yaml`, regenerate the server router and client code.

**Files to change:**

- `plugins/catalog-backend/src/schema/openapi/generated/router.ts` (regenerated)
- `plugins/catalog-backend/src/schema/openapi/generated/apis/Api.server.ts` (regenerated)
- `plugins/catalog-backend/src/schema/openapi/generated/apis/Api.client.ts` (regenerated)

These files are auto-generated from the OpenAPI spec. Update the spec and regenerate.

**Validation:** Generated code compiles and tests pass.

---

## System-Wide Impact

### Interaction Graph

```
Prefetch race fix:
  DefaultStitcher.stitch(entityRefs)
    → preFetchStatus(refs) → returns Map (not stored on this)
    → for each ref: #stitchOne({ entityRef, prefetchedStatuses })
      → performStitching({ ..., prefetchedStatuses })
        → merger.merge({ entity, entityRef, query })
          → query.getStatuses([entityRef]) → serves from prefetchedStatuses cache
          → BuiltinStatusMerger: no instance cache, uses query directly

Orphaned status cleanup:
  [startup] CatalogPlugin init → statusStore.cleanOrphanedStatuses()
  [periodic] DefaultStitcher deferred pipeline loadTasks
    → statusStore.cleanOrphanedStatuses(batchSize=500)
    → LEFT JOIN entity_status / refresh_state → delete orphans

Stitching debounce:
  POST /status?stitch=deferred
    → statusStore.setStatus() → 204 (no stitcher.stitch() call)
    → next deferred stitch cycle picks up the change
  POST /status (default)
    → statusStore.setStatus() → stitcher.stitch() → 204 (existing behavior)
```

### Error Propagation

| Error                            | Source                            | Behavior                                                                                           |
| -------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| Prefetch DB failure              | `preFetchStatus()`                | Returns empty Map; mergers get no data; entity stitched without status (same as before status API) |
| Merger failure                   | `merger.merge()`                  | Caught and logged; stitch continues without status                                                 |
| Orphan cleanup failure           | `cleanOrphanedStatuses()`         | Caught and logged; next cycle retries                                                              |
| Stitch skipped (deferred)        | POST handler                      | Status persisted; eventual consistency                                                             |
| Entity ref not in prefetch cache | `EntityStatusQuery.getStatuses()` | Falls through to DB query                                                                          |

### State Lifecycle Risks

- **Per-entity prefetch snapshot:** Each stitch operation receives its own Map snapshot. Even if the underlying DB data changes between prefetch and merge, the snapshot is consistent. This is acceptable because status data is eventually consistent by design.
- **Orphan cleanup batching:** Cleanup runs in batches of 500. If a large number of entities are deleted at once, cleanup takes multiple cycles. Orphaned rows during this window don't affect correctness — they're just unused data.
- **Deferred stitch timing:** When `stitch=deferred` is used, the caller must poll the entity to confirm the status is reflected. The processing interval (default: configurable) determines the maximum delay.

### API Surface Parity

| Change                            | Impact                       | Breaking? |
| --------------------------------- | ---------------------------- | --------- |
| Per-entity prefetch data          | Internal behavior change     | No        |
| BuiltinStatusMerger cache removal | Internal behavior change     | No        |
| Orphan cleanup                    | Internal behavior change     | No        |
| `?stitch=deferred` parameter      | Additive (default unchanged) | No        |

All changes are backwards-compatible. No breaking changes to public or alpha APIs.

## Acceptance Criteria

### Functional Requirements

- [ ] Prefetched status data is passed per-entity, not stored on instance
- [ ] `BuiltinStatusMerger` has no class-level cache; uses `EntityStatusQuery` exclusively
- [ ] Concurrent batches in TaskPipeline get correct status data per entity
- [ ] Orphaned `entity_status` rows cleaned up on startup and periodically
- [ ] `POST /status?stitch=deferred` persists status without triggering stitch
- [ ] `POST /status` (default) triggers immediate stitch (unchanged behavior)

### Non-Functional Requirements

- [ ] `yarn tsc` passes at project root
- [ ] `CI=1 yarn test plugins/catalog-backend/src/stitching/DefaultStitcher.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/database/DefaultCatalogStatusStore.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/tests/status-integration.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/service/createRouter.test.ts` passes
- [ ] Orphan cleanup query uses index scan (explain analyze on PostgreSQL)

### Quality Gates

- [ ] No instance-level mutable state in stitcher prefetch path
- [ ] Status data correct under concurrent deferred stitching (test with >5 entities)
- [ ] No orphaned `entity_status` rows after entity deletion + cleanup cycle
- [ ] Deferred stitch parameter documented in OpenAPI spec

## Dependencies & Risks

**Dependencies:**

- Task 1.1 and 1.2 are tightly coupled (both change the prefetch data flow)
- Task 2.1 is independent of Phase 1
- Task 3.1 depends on Phase 1 being complete (correctness first, then performance)
- Task 3.2 is mechanical (OpenAPI regeneration)

**Risks:**

- **`DeferredStitchItem` type extension:** Adding `prefetchedStatuses` to the deferred pipeline items changes the internal type. The `TaskPipeline` is typed generically, so this should be transparent. Verify by running type checker.
- **Orphan cleanup query performance:** The LEFT JOIN between `entity_status` and `refresh_state` could be slow on large tables. Mitigated by: both tables have `entity_ref` indexes, batchSize limit, and running only every N cycles. If performance is still a concern, consider a `NOT EXISTS` subquery instead.
- **`cleanOrphanedStatuses` SQL compatibility:** The LEFT JOIN query needs to work across SQLite, PostgreSQL, and MySQL. Knex abstracts most differences, but verify the `leftJoin` + `whereNull` pattern works on all three.
- **BuiltinStatusMerger now calls `query.getStatuses()` on every merge:** Previously it used an in-memory cache. Now it calls the query, which internally checks a Map (cache hit) or falls through to DB. For the built-in merger, this is always a cache hit. No performance regression.

## Alternative Approaches Considered

**1. Lock the prefetch map during batch processing (mutex)**
Rejected: Adds complexity; Node.js is single-threaded so mutexes only protect against async interleaving. The per-entity closure approach eliminates the race by design without synchronization.

**2. Accumulate in the prefetch map instead of replacing**
Rejected: The map grows without bound as batches are processed. Entries from old batches are never cleaned up. Per-entity closure has natural GC when the stitch operation completes.

**3. DB-level cascade for entity deletion (FK from entity_status to refresh_state)**
Rejected: `entity_status.entity_ref` is a string, not an FK to any table's primary key. `refresh_state.entity_ref` is not a unique column (multiple rows per entity for different aspects). A proper FK would require schema changes that aren't worth the complexity.

**4. Entity deletion hook via event bus**
Rejected: Backstage has an events system, but entity deletion doesn't emit events. Adding event emission to entity deletion would be a larger change touching core catalog code. Scheduled cleanup is simpler and sufficient.

**5. Batch status API endpoint (POST /entities/status/batch)**
Deferred to follow-up plan: Requires careful design around partial failures (some entities exist, some don't), batch permissions (checking N entities), request size limits, and OpenAPI schema. The 4 fixes above are higher priority and independently deployable. A batch endpoint can be added on top without changing the existing single-entity API.

## Sources & References

### Origin

- **Previous plan:** [docs/plans/2026-05-05-fix-catalog-status-api-remaining-fixes-plan.md](2026-05-05-fix-catalog-status-api-remaining-fixes-plan.md) — Service factory wiring, source validation, orphan detection, query caching
- **Review plan:** [docs/plans/2026-05-05-fix-catalog-status-api-review-recommendations-plan.md](2026-05-05-fix-catalog-status-api-review-recommendations-plan.md) — Index, validation, DELETE semantics, sanitization

### Internal References

- TaskPipeline concurrency model: `plugins/catalog-backend/src/processing/TaskPipeline.ts:66-139`
- DefaultStitcher prefetch: `plugins/catalog-backend/src/stitching/DefaultStitcher.ts:100-120`
- performStitching merger integration: `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts:214-254`
- BuiltinStatusMerger cache: `plugins/catalog-backend/src/service/CatalogBuilder.ts:116-140`
- Orphan detection: `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts:172-184`
- Entity lifecycle doc: `docs/features/software-catalog/life-of-an-entity.md`
- Deadlock retry pattern: `plugins/catalog-backend/src/database/util.ts`
- Chunking pattern: `plugins/catalog-backend/src/database/operations/stitcher/markForStitching.ts`

### Related Work

- Entity deletion paths: `plugins/catalog-backend/src/service/createRouter.ts` (DELETE /entities)
- Location removal: `plugins/catalog-backend/src/providers/DefaultLocationStore.ts`
- Deferred stitch queue: `plugins/catalog-backend/src/database/tables.ts` (stitch_queue table)
