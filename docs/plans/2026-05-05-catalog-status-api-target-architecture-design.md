---
title: 'Catalog Status API — Target Architecture & Design'
type: design
status: active
date: 2026-05-05
---

# Catalog Status API — Target Architecture & Design

## 1. Purpose

This document defines the target architecture for the Catalog Status API: an
out-of-band entity status system that supports high-frequency, event-driven
status updates from external sources (GitHub Actions, PagerDuty, custom CI/CD)
through REST and the existing `CatalogService` service ref.

## 2. Design Principles

1. **Out-of-band writes.** External systems write to a dedicated `entity_status`
   table, not to entity YAML. The catalog entity remains the source of truth
   for identity; status is an overlay.

2. **Stitch-based materialization.** Status becomes visible in `entity.status`
   only after the stitch pipeline merges it. The stitch pipeline is the sole
   writer of `final_entities`.

3. **Dual consistency model.** The system provides two read paths:

   - `GET /status` — strongly consistent, reads directly from `entity_status`
   - `entity.status` (via `GET /entity`) — eventually consistent, materialized
     through the stitch pipeline

4. **Deferred-mode coalescing.** The `stitch_queue` table uses `entity_ref` as
   primary key with `onConflict().merge()`. Rapid writes to the same entity
   produce one stitch, not N stitches. This is the primary throughput mechanism.

5. **No lightweight rebuild path.** Status-only changes go through the full
   stitch pipeline. Introducing a second code path that writes `final_entities`
   would create concurrency hazards and divergent behavior. The full stitch is
   fast enough (~6 queries per entity) when writes are batched.

6. **Extend existing surfaces over creating new ones.** Status methods belong on
   `CatalogService`, not on a separate service ref. Every other catalog
   operation (get entities, refresh, locations) is on `CatalogService`. Status
   is another catalog operation. A separate service ref would force consumers to
   depend on two refs for related functionality.

## 3. Architecture

### 3.1 Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        STATUS WRITE PATHS                        │
│                                                                  │
│  External caller          In-process plugin                      │
│  (CI/CD, PagerDuty)      (event bridge module)                   │
│       │                         │                                │
│       ▼                         ▼                                │
│  POST /status            catalogServiceRef                       │
│  (HTTP + perms)          .setEntityStatus()                      │
│       │                   (HTTP, same as all CatalogService)     │
│       │                         │                                │
│       └─────────┬───────────────┘                                │
│                 ▼                                                │
│         REST handler in createRouter.ts                          │
│         ├── statusStore.setStatus()                              │
│         └── stitcher.stitch()                                    │
│             ├─ deferred → markForStitching() → stitch_queue      │
│             │              (coalesces per entity_ref)             │
│             └─ immediate → #stitchOne() → performStitching()     │
│                 │                                                │
│                 ▼                                                │
│         performStitching()                                       │
│         ├── read processed entity from refresh_state             │
│         ├── read relations                                       │
│         ├── run StitchingStatusMerger.merge() chain              │
│         ├── sanitizeStatus()                                     │
│         ├── hash comparison (skip if unchanged)                  │
│         └── UPDATE final_entities                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        STATUS READ PATHS                         │
│                                                                  │
│  GET /status (strongly consistent)                               │
│       └── reads directly from entity_status table                │
│           → always reflects latest write                         │
│           → no stitch dependency                                 │
│           → suitable for real-time UI polling                    │
│                                                                  │
│  GET /entity → entity.status (eventually consistent)             │
│       └── reads from final_entities table                        │
│           → reflects status after stitch completes               │
│           → includes merger transformations                      │
│           → suitable for batch/offline consumption               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Event-Driven Integration Pattern

```
GitHub Actions Events ──┐
                        ▼
                 Events Service
                 (existing)
                        │
                        ▼
          ┌─────────────────────────┐
          │  event-bridge module     │  (new BackendModule)
          │  (e.g. github-actions)   │
          │                          │
          │  deps:                   │
          │  - eventsServiceRef      │
          │  - catalogServiceRef     │
          │                          │
          │  subscribe to topic      │
          │  translate event→status  │
          │  call .setEntityStatus() │
          │  (stitch triggered       │
          │   automatically by       │
          │   the REST handler)      │
          └─────────────────────────┘
```

The event bridge module is a standard `createBackendModule`. It does not need a
special extension point. It depends on `catalogServiceRef` for status writes and
`eventsServiceRef` for event subscriptions — both are existing, stable service
refs.

### 3.3 Deferred Stitch Coalescing

The key throughput mechanism. In production (deferred stitch mode), rapid writes
to the same entity coalesce naturally:

```
T0: setEntityStatus('component:default/my-api', 'github-actions', {state: 'running'})
    → HTTP POST to /status
    → statusStore writes to entity_status
    → stitcher.stitch() → markForStitching()
    → INSERT INTO stitch_queue (entity_ref, ticket, ...)
      ON CONFLICT (entity_ref) MERGE   ← coalesces

T0+50ms: setEntityStatus('component:default/my-api', 'github-actions', {state: 'success'})
    → HTTP POST to /status
    → statusStore upserts (same entity_ref + source)
    → stitcher.stitch() → markForStitching()
    → INSERT INTO stitch_queue ON CONFLICT MERGE   ← overwrites ticket

T0+1000ms: deferred pipeline polls, loads batch from stitch_queue
    → ONE row for 'component:default/my-api'
    → ONE stitch runs, reads latest status from entity_status
    → entity.status updated to reflect 'success' (latest write wins)
```

This means 10 rapid status updates to the same entity produce exactly 1 stitch.

## 4. Component Design

### 4.1 Status Methods on CatalogService (extend existing)

Add three methods to the existing `CatalogService` interface in
`plugins/catalog-node/src/catalogService.ts`. These follow the exact same
delegation pattern as every other method in `DefaultCatalogService` — they call
through to `CatalogClient`, which already has the status methods from the
generated OpenAPI code (`updateEntityStatusByName`, `deleteEntityStatusByName`,
`getEntityStatusSourcesByName`).

```typescript
// Additions to CatalogService interface

/**
 * Set the status of an entity from an external source.
 *
 * The source identifies the origin of the status data (e.g.
 * 'github-actions', 'pagerduty'). Source names are validated
 * against reserved keys.
 *
 * Writing triggers stitching according to the catalog's stitch strategy.
 */
setEntityStatus(
  entityRef: string | CompoundEntityRef,
  source: string,
  status: JsonObject,
  options: CatalogServiceRequestOptions,
): Promise<void>;

/**
 * Remove status for an entity from a specific source.
 *
 * Writing triggers stitching according to the catalog's stitch strategy.
 */
deleteEntityStatus(
  entityRef: string | CompoundEntityRef,
  source: string,
  options: CatalogServiceRequestOptions,
): Promise<void>;

/**
 * Get the current status sources for an entity.
 *
 * Reads directly from the entity_status table (strongly consistent).
 * Returns an array of source names that have status data for the entity.
 */
getEntityStatusSources(
  entityRef: string | CompoundEntityRef,
  options: CatalogServiceRequestOptions,
): Promise<string[]>;
```

**Implementation in `DefaultCatalogService`:**

Follows the identical pattern as existing methods — delegate to `CatalogClient`,
resolve auth token via `#getOptions()`:

```typescript
async setEntityStatus(
  entityRef: string | CompoundEntityRef,
  source: string,
  status: JsonObject,
  options: CatalogServiceRequestOptions,
): Promise<void> {
  const { kind, namespace, name } = parseEntityRef(entityRef);
  const response = await this.#catalogApi.updateEntityStatusByName(
    {
      path: { kind, namespace, name },
      body: { source, status },
    },
    await this.#getOptions(options),
  );
  // Response is 204 No Content
}

async deleteEntityStatus(
  entityRef: string | CompoundEntityRef,
  source: string,
  options: CatalogServiceRequestOptions,
): Promise<void> {
  const { kind, namespace, name } = parseEntityRef(entityRef);
  await this.#catalogApi.deleteEntityStatusByName(
    {
      path: { kind, namespace, name },
      query: { source },
    },
    await this.#getOptions(options),
  );
}

async getEntityStatusSources(
  entityRef: string | CompoundEntityRef,
  options: CatalogServiceRequestOptions,
): Promise<string[]> {
  const { kind, namespace, name } = parseEntityRef(entityRef);
  const response = await this.#catalogApi.getEntityStatusSourcesByName(
    { path: { kind, namespace, name } },
    await this.#getOptions(options),
  );
  return (await response.json()).sources;
}
```

**Why this approach instead of a separate service ref:**

- `CatalogService` already wraps all catalog operations — entities, locations,
  refresh, facets. Status is another catalog operation.
- `CatalogClient` already has the generated methods from the OpenAPI spec
  (`updateEntityStatusByName`, `deleteEntityStatusByName`,
  `getEntityStatusSourcesByName`). No new HTTP plumbing needed.
- Consumers already depend on `catalogServiceRef`. They get status access
  without adding a new dependency.
- The auth pattern is identical: `#getOptions()` resolves a plugin request
  token, the REST handler checks `catalogEntityStatusWritePermission`. No
  special-casing.

### 4.2 StitchingStatusMerger (existing, unchanged)

The merger extension point remains as-is. It is the correct abstraction for
plugins that want to **transform** status data during stitch (e.g., enrich
status with cross-referenced catalog data, filter sources, derive computed
status).

Mergers run during `performStitching()`, after relations are assembled and
before the hash is computed. The `BuiltinStatusMerger` always runs last and
spreads raw status data into `entity.status`.

### 4.3 catalogStitcherServiceRef (existing, unchanged)

Remains available for plugins that need to trigger stitching independently of
status writes (e.g., after modifying entity annotations).

## 5. REST API Changes

### 5.1 Fix `?stitch=deferred` Semantics

**Current behavior:**

| Stitch mode                   | Default POST                                           | `?stitch=deferred` POST |
| ----------------------------- | ------------------------------------------------------ | ----------------------- |
| Deferred (production default) | `stitcher.stitch()` → `markForStitching()` → coalesces | Skips stitch entirely   |
| Immediate                     | `stitcher.stitch()` → `#stitchOne()` → synchronous     | Skips stitch entirely   |

The `?stitch=deferred` parameter skips the stitch call entirely, meaning the
status change may never be reflected in `entity.status` unless some other event
triggers a stitch for that entity.

**Proposed change:** Rename to `?stitch=skip` to accurately describe the
behavior. Add documentation:

> When `?stitch=skip` is specified, the status is written to the database but
> no stitch is triggered. The caller is responsible for triggering a stitch
> separately (e.g., via `catalogStitcherServiceRef`). Use this only when
> performing batch operations where you control the stitch lifecycle.

### 5.2 Batch Status Write Endpoint (new)

```
POST /entities/status-batch
Content-Type: application/json

[
  {
    "entityRef": "component:default/my-api",
    "source": "github-actions",
    "status": { "state": "running" }
  },
  {
    "entityRef": "component:default/other-api",
    "source": "github-actions",
    "status": { "state": "success" }
  }
]
```

**Behavior:**

1. Validate all entries (source, status payload)
2. Write all statuses to `entity_status` in a transaction
3. Collect unique entity refs
4. Call `stitcher.stitch({ entityRefs: uniqueRefs })` once (or skip if
   `?stitch=skip`)
5. Return `204` on success, or `207 Multi-Status` with per-entry errors

**Why:** Reduces HTTP overhead for bulk operations. A single batch call replaces
N individual POSTs. The stitch call is already batched (deferred mode coalesces
all entity refs in one `markForStitching` call).

### 5.3 Existing Endpoints (unchanged)

| Method | Path                                                       | Behavior                                  |
| ------ | ---------------------------------------------------------- | ----------------------------------------- |
| GET    | `/entities/by-name/:kind/:namespace/:name/status`          | List status sources (strongly consistent) |
| POST   | `/entities/by-name/:kind/:namespace/:name/status`          | Set status from source                    |
| DELETE | `/entities/by-name/:kind/:namespace/:name/status?source=X` | Remove status from source                 |

## 6. Package Changes

### 6.1 `@backstage/plugin-catalog-node` (modified)

Add three methods to the existing `CatalogService` interface in
`catalogService.ts` and implement them in `DefaultCatalogService`. No new files
or exports needed — the interface is already exported.

### 6.2 No changes to

- `@backstage/plugin-catalog-backend` — REST endpoints already implemented. No
  new factory or service ref to wire.
- `@backstage/plugin-catalog-common` — permissions already defined
- `@backstage/catalog-client` — generated OpenAPI code already has status
  methods (`updateEntityStatusByName`, `deleteEntityStatusByName`,
  `getEntityStatusSourcesByName`)
- `@backstage/catalog-model` — `AlphaEntity.status` type unchanged

## 7. Changesets

### `@backstage/plugin-catalog-node` — patch

> Added `setEntityStatus`, `deleteEntityStatus`, and `getEntityStatusSources`
> methods to `CatalogService` for managing out-of-band entity status from
> in-process plugins.

### `@backstage/plugin-catalog-backend` — patch (batch endpoint + stitch rename)

> Added batch status write endpoint `POST /entities/status-batch`. The
> `?stitch=deferred` query parameter is renamed to `?stitch=skip` to clarify
> that no stitch is triggered.

## 8. What We Explicitly Decided NOT To Do

### 8.1 No Separate `CatalogStatusService` Service Ref

**Rejected:** Creating a new `catalogStatusServiceRef` with its own interface
and factory.

**Reason:** `CatalogService` already wraps all catalog operations. Status is
another catalog operation. `CatalogClient` already has the generated methods
from the OpenAPI spec. Adding a separate service ref forces consumers to depend
on two refs for related functionality and duplicates the auth/discovery plumbing
that `DefaultCatalogService` already provides.

### 8.2 No Stitch Coalescing in DefaultStitcher

**Rejected:** Adding a setTimeout-based debounce to `DefaultStitcher.stitch()`.

**Reason:** Deferred mode already coalesces via `stitch_queue` upserts. The
debounce would only help in immediate mode (non-default configuration). An
in-memory buffer is fragile (lost on crash) and adds mutable state to an
otherwise stateless stitcher.

**Correct approach:** For high-frequency writes, use deferred stitch mode
(production default). The coalescing is built into the stitch_queue.

### 8.3 No Lightweight `rebuildStatus` Path

**Rejected:** A second code path that reads `final_entities` directly and
re-runs only status mergers, skipping the full stitch.

**Reason:** Creates a race condition with concurrent full stitches. The full
stitch writes `final_entities` optimistically (hash comparison, stitch_ticket
guard). A lightweight rebuild bypasses these guards and can overwrite a
concurrent full stitch's changes. The full stitch (~6 queries per entity) is
fast enough when writes are batched through the stitch_queue.

### 8.4 No CatalogStatusSource Extension Point

**Rejected:** A new extension point for registering status event handlers.

**Reason:** Extension points are for the catalog to call INTO the module
(`addProcessor`, `addEntityProvider`). Status sources push data TO the catalog,
which is a service ref pattern. An event bridge module is just a
`createBackendModule` with `catalogServiceRef` and `eventsServiceRef`
dependencies — no special API needed.

### 8.5 No SSE/WebSocket for Status Push (yet)

**Not now:** Server-Sent Events or WebSocket support for pushed status updates.

**Reason:** The `GET /status` endpoint already provides strongly consistent
reads. Frontend polling at 5-10 second intervals is sufficient for current use
cases. SSE/WebSocket can be added later without architectural changes by
layering it on top of the `entity_status` table with a change feed.

## 9. Migration Path

### Phase 1: Status Methods on CatalogService (this changeset)

- Add `setEntityStatus`, `deleteEntityStatus`, `getEntityStatusSources` to
  `CatalogService` interface
- Implement in `DefaultCatalogService` delegating to `CatalogClient`
- Changeset: patch for catalog-node

### Phase 2: Batch Endpoint (this changeset or next)

- Add `POST /entities/status-batch` to `createRouter.ts`
- Add OpenAPI spec
- Changeset: patch for catalog-backend

### Phase 3: Stitch Semantics Cleanup (this changeset)

- Rename `?stitch=deferred` to `?stitch=skip`
- Update OpenAPI spec
- Changeset: patch for catalog-backend

### Phase 4: Event Bridge Modules (future, per-source)

- `@backstage/plugin-catalog-backend-module-github-actions-status`
- `@backstage/plugin-catalog-backend-module-pagerduty-status`
- Each is a `createBackendModule` with `catalogServiceRef` + `eventsServiceRef`
- No catalog core changes needed

## 10. Test Strategy

### Unit Tests

- `catalogService.test.ts`: add tests for the three new methods, verify they
  delegate to `CatalogClient` with correct parameters
- `createRouter.test.ts`: add batch endpoint tests, `?stitch=skip` tests

### Integration Tests

- Extend `status-integration.test.ts` to verify:
  - Batch write endpoint updates multiple entities
  - `?stitch=skip` writes status but entity.status unchanged until next stitch
  - Rapid writes to same entity coalesce in deferred mode (verify single stitch)
  - `catalogServiceRef.setEntityStatus()` writes reflected in GET /entity

### Performance Test (manual)

- Benchmark: 100 status writes to 10 entities in 1 second
- Verify deferred mode produces ~10 stitches (one per entity), not 100
- Verify `GET /status` returns latest status immediately after write
- Verify entity.status converges within 2 stitch cycles

## 11. File Map

### Modified Files

| File                                 | Package      | Change                                             |
| ------------------------------------ | ------------ | -------------------------------------------------- |
| `catalog-node/src/catalogService.ts` | catalog-node | Add 3 status methods to interface + implementation |

### Files Changed Only for Batch/Rename (if included in this changeset)

| File                                          | Package         | Change                             |
| --------------------------------------------- | --------------- | ---------------------------------- |
| `catalog-backend/src/service/createRouter.ts` | catalog-backend | Batch endpoint, stitch=skip rename |
| `catalog-backend/src/schema/openapi.yaml`     | catalog-backend | New/updated endpoint specs         |

### No New Files

No new service refs, factories, or interfaces. The status API surface extends
`CatalogService`, which already exists and is already wired.

### Unchanged Files

| File                                     | Reason                                                            |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `DefaultStitcher.ts`                     | No changes needed. Deferred coalescing is built-in.               |
| `performStitching.ts`                    | No changes needed. Full stitch is the correct path.               |
| `DefaultCatalogStatusStore.ts`           | No changes needed. Already has correct API.                       |
| `util/status.ts`                         | No changes needed. Validation/sanitization complete.              |
| `catalogStitcherServiceFactory.ts`       | No changes needed. Existing pattern is correct.                   |
| `extensions.ts` (merger extension point) | No changes needed. Correct abstraction.                           |
| `CatalogPlugin.ts`                       | No changes needed. No new factory to wire.                        |
| `catalog-node/src/alpha.ts`              | No changes needed. Status goes through CatalogService, not alpha. |
