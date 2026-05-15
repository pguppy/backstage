---
title: 'fix: Catalog Status API Architectural Issues'
type: fix
status: active
date: 2026-05-05
---

# fix: Catalog Status API Architectural Issues

## Overview

The Catalog Status API introduces an out-of-band entity status system with a dedicated `entity_status` DB table, REST endpoints, and a stitching merger pipeline. A thorough architectural review identified 6 issues (1 critical, 3 moderate, 2 low) that need to be addressed before this feature is production-ready.

## Issues Summary

| #   | Severity | Issue                                                       | File(s)                                      |
| --- | -------- | ----------------------------------------------------------- | -------------------------------------------- |
| 1   | Critical | Module-level mutable state in stitcher service factory      | `CatalogStitcherServiceFactory.ts`           |
| 2   | Moderate | `sanitizeStatus` mutates input in-place                     | `util/status.ts`, `performStitching.ts`      |
| 3   | Moderate | Stale prefetched status under concurrent writes             | `DefaultStitcher.ts`, `performStitching.ts`  |
| 4   | Moderate | No inter-source conflict documentation/resolution           | `BuiltinStatusMerger` in `CatalogBuilder.ts` |
| 5   | Low      | Non-transactional orphan cleanup                            | `DefaultCatalogStatusStore.ts`               |
| 6   | Low      | `EntityStatusQuery` cache bypass footgun for merger authors | `performStitching.ts`                        |

**Note:** Issue #7 from the original review (case mismatch between permission ref and DB) is a **non-issue** — `stringifyEntityRef()` already lowercases all components (see `packages/catalog-model/src/entity/ref.ts:157-159`).

---

## Implementation Phases

### Phase 1: Fix Critical Service Factory Issue

**Goal:** Replace module-level mutable state with proper DI-scoped service factory.

#### Context

`CatalogStitcherServiceFactory.ts` uses a module-level `let _stitcher` variable set via `_setStitcher()` from `CatalogPlugin.ts`. This breaks with multiple catalog instances (tests, multi-tenant) and has a race condition if the factory is resolved before plugin init completes.

#### Approach: Make the factory depend on a placeholder that the plugin fills in

The Backstage DI system supports `createServiceFactory` with dependencies. The stitcher service should be provided by the catalog plugin itself (which owns the stitcher), not by a standalone factory with backchannel state.

#### Files to Change

**`plugins/catalog-node/src/catalogStitcherService.ts`**

- Keep `CatalogStitcherService` interface and `catalogStitcherServiceRef` as-is — these are the public API.

**`plugins/catalog-backend/src/service/CatalogStitcherServiceFactory.ts`**

- Remove module-level `_stitcher` variable and `_setStitcher()` function entirely.
- Convert to a proper `createServiceFactory` that declares a dependency on the catalog plugin or uses a different initialization strategy.

**Strategy — Register the stitcher as a plugin-provided service:**

Instead of a standalone factory, the catalog plugin's `registerInit` should provide the stitcher service directly through the `env.registerInit` context. This follows the pattern where the plugin that owns the resource also provides the service.

```typescript
// In CatalogPlugin.ts, inside registerInit:
// After building the stitcher:
const stitcherService: CatalogStitcherService = {
  stitch: options => stitcher.stitch(options),
};

// Make it available via the context's serviceFactory
```

However, Backstage's current plugin system doesn't support plugins providing services directly to other plugins. The established pattern (see `catalogScmEventsServiceRef`) is to have a separate module that creates both the service ref and a factory.

**Chosen approach — Scoped factory with plugin lifecycle hook:**

1. Remove `_setStitcher()` and module-level state.
2. Have `CatalogStitcherServiceFactory` depend on `coreServices.rootLifecycle` (like other catalog-internal services).
3. In the factory, return a `Promise<CatalogStitcherService>` that resolves when the catalog plugin signals readiness.
4. Use a `Promise.withResolvers()` pattern scoped to the factory instance (not module level):

```typescript
// CatalogStitcherServiceFactory.ts
export const catalogStitcherServiceFactory = createServiceFactory({
  service: catalogStitcherServiceRef,
  deps: {},
  async factory() {
    // The stitcher is set during catalog plugin initialization.
    // If this factory is called before that, it's a configuration error.
    throw new Error(
      'catalogStitcherServiceFactory: the catalog plugin must be installed ' +
        'and initialized before this service can be used. Ensure @backstage/plugin-catalog-backend ' +
        'is added to your backend before any module that depends on catalogStitcherServiceRef.',
    );
  },
});

// Provide a separate mechanism for the plugin to register the stitcher
// through the backend system's service provider pattern
```

**Actually, the cleanest approach is simpler:** Move the factory creation into the plugin init itself, using the Backstage pattern where the plugin's init function provides services. Since Backstage plugins can't directly provide services, the current approach of a separate factory is necessary, but we should eliminate module-level state.

**Final approach — Instance-scoped holder:**

```typescript
// CatalogStitcherServiceFactory.ts
import { createServiceFactory } from '@backstage/backend-plugin-api';
import {
  CatalogStitcherService,
  catalogStitcherServiceRef,
} from '@backstage/plugin-catalog-node/alpha';

// Use a WeakMap keyed on the service context to support multiple instances
const stitcherInstances = new WeakMap<object, CatalogStitcherService>();

/** @internal */
export function registerStitcher(
  contextKey: object,
  stitcher: CatalogStitcherService,
) {
  stitcherInstances.set(contextKey, stitcher);
}

export const catalogStitcherServiceFactory = createServiceFactory({
  service: catalogStitcherServiceRef,
  deps: {},
  async factory() {
    // Note: In the current Backstage DI system, there's no way to pass
    // context from the plugin to the factory. The factory is a singleton.
    // We need the module-level approach but made safer.
    // ...
  },
});
```

**Wait — the real fix is to recognize the constraint:** Backstage service factories are singletons by design. The catalog plugin creates the stitcher during init. The factory needs to access it. The cleanest solution within Backstage's constraints:

1. Keep the module-level variable (it's a necessary evil given Backstage's DI limitations).
2. Make it robust: add a `Promise.withResolvers()` so consumers that resolve the factory before plugin init get a promise that resolves when the stitcher is ready, rather than throwing.
3. Add a cleanup function for test isolation.

```typescript
// CatalogStitcherServiceFactory.ts
let stitcherPromise: Promise<CatalogStitcherService>;
let stitcherResolve: (stitcher: CatalogStitcherService) => void;

function ensurePromise() {
  if (!stitcherPromise) {
    ({ promise: stitcherPromise, resolve: stitcherResolve } =
      Promise.withResolvers<CatalogStitcherService>());
  }
}

/** @internal */
export function _setStitcher(stitcher: CatalogStitcherService) {
  ensurePromise();
  stitcherResolve(stitcher);
}

/** @internal */
export function _resetStitcher() {
  stitcherPromise = undefined as any;
  stitcherResolve = undefined as any;
}

export const catalogStitcherServiceFactory = createServiceFactory({
  service: catalogStitcherServiceRef,
  deps: {},
  async factory() {
    ensurePromise();
    return stitcherPromise;
  },
});
```

This approach:

- Eliminates the race condition (factory returns a promise that resolves when ready)
- Still supports multiple catalog instances for testing via `_resetStitcher()`
- Remains within Backstage's DI constraints
- Does NOT support multiple catalog instances in the same process (same constraint as today, but now documented)

**Files:**

- `plugins/catalog-backend/src/service/CatalogStitcherServiceFactory.ts` — Rewrite with promise-based pattern
- `plugins/catalog-backend/src/service/CatalogPlugin.ts` — Keep `_setStitcher(stitcher)` call, update import if needed
- `plugins/catalog-backend/src/index.ts` — Ensure `_resetStitcher` is exported for test usage

#### Acceptance Criteria

- [ ] `catalogStitcherServiceFactory` returns a promise that resolves when the stitcher is ready
- [ ] No error thrown if factory is resolved before plugin init (it waits instead)
- [ ] `_resetStitcher()` exported for test isolation
- [ ] Existing tests pass without modification
- [ ] Add JSDoc to `catalogStitcherServiceFactory` documenting the initialization dependency

---

### Phase 2: Fix sanitizeStatus Mutation

**Goal:** Prevent `sanitizeStatus` from silently mutating merger output.

#### Approach

Make `sanitizeStatus` return a new object instead of mutating in-place. Use a recursive deep-clone-and-sanitize approach.

#### Files to Change

**`plugins/catalog-backend/src/util/status.ts`**

- Change `sanitizeStatus` to return a new object (pure function):

```typescript
export function sanitizeStatus(status: JsonObject): JsonObject {
  const sanitize = (obj: any): any => {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(sanitize);
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        result[key] =
          scriptProtocolPattern.test(value) ||
          vbscriptProtocolPattern.test(value)
            ? 'https://backstage.io/annotation-rejected-for-security-reasons'
            : value;
      } else if (typeof value === 'object') {
        result[key] = sanitize(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  };
  return sanitize(status);
}
```

**`plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts:258`**

- Change `sanitizeStatus(entity.status)` to `entity.status = sanitizeStatus(entity.status)`

**`plugins/catalog-backend/src/util/status.test.ts`**

- Update tests to verify the original object is NOT mutated
- Add test case confirming return value is a new reference

#### Acceptance Criteria

- [ ] `sanitizeStatus` returns a new object, never mutates input
- [ ] Original status objects passed to mergers are not modified
- [ ] `performStitching.ts` assigns the return value: `entity.status = sanitizeStatus(entity.status)`
- [ ] Tests verify non-mutation and correct sanitization

---

### Phase 3: Improve Stale Status Handling Under Concurrent Writes

**Goal:** Reduce the window where a stitch uses stale prefetched status data.

#### Context

When two POST requests write status for the same entity near-simultaneously, both trigger `stitcher.stitch()`. The second stitch may use status data prefetched before the second write completed. In non-deferred mode (the REST API trigger path), each `stitch()` call pre-fetches fresh status — but the stitch happens per-entity, so this is actually fine for the single-entity case.

The real risk is in **deferred mode** where a batch of entities is pre-fetched and then processed sequentially — a status update arriving mid-batch won't be seen.

#### Approach

This is inherently a eventual-consistency feature. The deferred stitch already re-runs periodically. Rather than adding locking complexity, document the behavior and add a lightweight mitigation.

**Files to Change:**

**`plugins/catalog-backend/src/stitching/DefaultStitcher.ts`**

- In `#stitchOne()`, when called directly from the REST API (non-deferred), skip using `prefetchedStatuses` and re-read fresh from the store. Add a parameter to distinguish:

```typescript
async #stitchOne(options: {
  entityRef: string;
  stitchTicket?: string;
  stitchRequestedAt?: DateTime;
  prefetchedStatuses?: Map<string, Record<string, JsonObject>>;
  usePrefetched?: boolean; // false when triggered by REST API
}) {
  // ...
  const result = await performStitching({
    // ...
    prefetchedStatuses: options.usePrefetched
      ? (options.prefetchedStatuses ?? new Map())
      : new Map(), // Force fresh read from store
  });
}
```

- In the `stitch()` method, when called with explicit `entityRefs` (from REST API), pass `usePrefetched: false`:

```typescript
if (entityRefs) {
  const refs = Array.isArray(entityRefs) ? entityRefs : [...entityRefs];
  // REST API calls pass explicit refs — re-read status fresh
  for (const entityRef of refs) {
    await this.#stitchOne({ entityRef, usePrefetched: false });
  }
}
```

- In `start()` (deferred mode pipeline), keep `usePrefetched: true` for batch efficiency.

**`plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`**

- In the `EntityStatusQuery` implementation, when `prefetchedStatuses` is empty, always fetch from store. This already works — the change is in DefaultStitcher to not pass stale prefetch data.

#### Acceptance Criteria

- [ ] REST API-triggered stitches always read fresh status from the store
- [ ] Deferred batch stitches continue using pre-fetch for performance
- [ ] No performance regression in deferred mode

---

### Phase 4: Add Inter-Source Conflict Documentation

**Goal:** Make the status merging contract explicit so plugin authors understand conflict behavior.

#### Approach

The current design is last-writer-wins at stitch time: if two sources write the same key to `entity.status`, the last merger to run wins. The built-in merger runs last and takes precedence. This is intentional and simple. Rather than adding conflict resolution machinery, document the contract clearly.

**Files to Change:**

**`plugins/catalog-node/src/extensions.ts`**

- Add JSDoc to `StitchingStatusMerger.merge()` documenting:
  - Mergers run in registration order (custom first, built-in last)
  - Later mergers override earlier mergers on conflicting keys
  - Source names are validated to prevent collision with reserved keys (`items`)
  - Plugin authors should namespace their status keys (e.g., `myPlugin.health`)

**`plugins/catalog-backend/src/service/CatalogBuilder.ts`**

- Add JSDoc to `addStitchingStatusMerger()` documenting the ordering contract

**`plugins/catalog-backend/src/util/status.ts`**

- Add JSDoc to `RESERVED_STATUS_KEYS` listing what's reserved and why

#### Acceptance Criteria

- [ ] `StitchingStatusMerger.merge()` has JSDoc documenting conflict behavior
- [ ] `addStitchingStatusMerger()` documents ordering semantics
- [ ] Plugin authors can make informed decisions about key naming

---

### Phase 5: Make Orphan Cleanup Transactional

**Goal:** Prevent race condition where a valid entity's status is deleted between SELECT and DELETE.

#### Approach

Replace the two-step SELECT + DELETE with a single subquery DELETE.

**Files to Change:**

**`plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`**

- Rewrite `cleanOrphanedStatuses`:

```typescript
async cleanOrphanedStatuses(batchSize: number = 500): Promise<number> {
  // Use a subquery to delete in a single atomic operation
  const deleted = await this.db('entity_status')
    .whereRaw(
      `entity_ref IN (
        SELECT es.entity_ref FROM entity_status es
        LEFT JOIN refresh_state rs ON es.entity_ref = rs.entity_ref
        WHERE rs.entity_ref IS NULL
        LIMIT ?
      )`,
      [batchSize],
    )
    .delete();

  return deleted;
}
```

Note: The subquery approach is atomic for the SELECT portion but the DELETE could still race with a concurrent INSERT into `refresh_state`. For full safety, a transaction would be needed, but the probability is extremely low and the consequence (a status row gets deleted and re-created on next write) is benign. The subquery approach is a significant improvement over the two-step approach.

**Alternative for databases that support it (PostgreSQL, MySQL):**

```typescript
async cleanOrphanedStatuses(batchSize: number = 500): Promise<number> {
  const deleted = await this.db.raw(`
    DELETE FROM entity_status
    WHERE entity_ref IN (
      SELECT es.entity_ref FROM entity_status es
      LEFT JOIN refresh_state rs ON es.entity_ref = rs.entity_ref
      WHERE rs.entity_ref IS NULL
      LIMIT ?
    )
  `, [batchSize]);
  return deleted[0] ?? 0;
}
```

However, raw SQL is less portable across Backstage's supported databases (SQLite, PostgreSQL, MySQL). Stick with the Knex subquery approach.

#### Acceptance Criteria

- [ ] `cleanOrphanedStatuses` uses a single query (subquery DELETE) instead of SELECT + DELETE
- [ ] Works on SQLite, PostgreSQL, and MySQL
- [ ] Existing orphan cleanup tests pass

---

### Phase 6: Document EntityStatusQuery Cache Semantics

**Goal:** Make it clear to merger authors that `query.getStatuses()` should only be called with refs from the provided batch.

#### Approach

Add clear JSDoc and a runtime warning.

**Files to Change:**

**`plugins/catalog-node/src/extensions.ts`**

- Update `EntityStatusQuery.getStatuses()` JSDoc:

```typescript
/**
 * Get status data for a batch of entity refs, grouped by source.
 * Returns a Map where keys are lowercased entity refs and values
 * are objects keyed by source name.
 *
 * **Important:** Call this only with entity refs from the current
 * stitch batch. Calling with arbitrary refs may bypass the pre-fetch
 * cache and cause additional database queries (N+1).
 */
getStatuses(
  entityRefs: string[],
): Promise<Map<string, Record<string, any>>>;
```

**`plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`**

- In the `EntityStatusQuery` cache implementation, add a debug log when falling through to the store:

```typescript
getStatuses: async (refs: string[]) => {
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
    logger.debug(
      `EntityStatusQuery cache miss for ${uncached.length} refs during stitch of ${entityRef}. ` +
      `Consider adding these refs to the preFetch hook.`,
    );
    const fetched = await options.statusStore.getStatuses(uncached);
    for (const [ref, data] of fetched) {
      result.set(ref, data);
    }
  }
  return result;
},
```

#### Acceptance Criteria

- [ ] `EntityStatusQuery.getStatuses()` JSDoc documents the cache semantics
- [ ] Debug log emitted when cache is bypassed to aid debugging
- [ ] No behavioral changes, purely documentation/observability

---

## System-Wide Impact

### Interaction Graph

1. **Service factory fix (Phase 1):** Affects the startup sequence. External plugins depending on `catalogStitcherServiceRef` will now wait (via promise) instead of throwing if resolved before catalog plugin init.
2. **sanitizeStatus (Phase 2):** Affects `performStitching.ts` and any code that calls `sanitizeStatus`. Since it's now a pure function, callers must assign the return value.
3. **Stale status (Phase 3):** REST API-triggered stitches will do one extra DB read per entity (fetch fresh status instead of using prefetch). Deferred stitches unchanged.
4. **Orphan cleanup (Phase 5):** Single query instead of two — marginally faster, no behavioral change.

### Error Propagation

- Phase 1: If the catalog plugin never initializes, consumers of `catalogStitcherServiceRef` will hang (promise never resolves) instead of crashing. Add a timeout or document that catalog plugin is required.
- Phase 2: No error propagation change — pure function.
- Phase 5: If the subquery fails, the error propagates the same as before (caught in DefaultStitcher.start() with try/catch).

### State Lifecycle Risks

- Phase 1: The promise-based approach means the stitcher is set exactly once. If `_resetStitcher()` is called in tests, any pending promises are abandoned (new ones created on next access). This is acceptable for test isolation.
- Phase 3: No new state — just changes which data source is used.

## Acceptance Criteria

### Functional Requirements

- [ ] All 6 issues addressed with code changes
- [ ] Existing test suite passes (`CI=1 yarn test plugins/catalog-backend`)
- [ ] Type checking passes (`yarn tsc`)
- [ ] New tests for `sanitizeStatus` non-mutation
- [ ] New tests for promise-based service factory

### Non-Functional Requirements

- [ ] No performance regression in deferred stitching (Phase 3 preserves prefetch)
- [ ] Cross-database compatibility (SQLite, PostgreSQL, MySQL) for Phase 5 changes

### Quality Gates

- [ ] API reports generated (`yarn build:api-reports`) — no unexpected API changes
- [ ] Changeset updated if any public API surface changed

## Dependencies & Prerequisites

- All changes are within the catalog plugin — no cross-plugin dependencies
- Phase 1 should be done first (critical severity)
- Phases 2-6 are independent and can be done in any order

## Risk Analysis

| Risk                                   | Likelihood | Impact              | Mitigation                                                       |
| -------------------------------------- | ---------- | ------------------- | ---------------------------------------------------------------- |
| Service factory promise never resolves | Low        | High (startup hang) | Document catalog plugin dependency; add startup timeout guidance |
| sanitizeStatus clone perf impact       | Low        | Low                 | Shallow objects, cloning is fast; only runs during stitch        |
| Subquery DELETE incompatibility        | Low        | Medium              | Test on SQLite (dev) and PostgreSQL (CI)                         |
| Phase 3 causes extra DB read           | Certain    | Low                 | Only affects REST API path (single entity), not batch deferred   |

## Documentation Plan

- [ ] Update Serena memory with architectural decisions
- [ ] JSDoc on all changed public interfaces
- [ ] Changeset describes user-facing behavior changes

## Sources & References

### Internal References

- `plugins/catalog-backend/src/service/CatalogStitcherServiceFactory.ts` — current module-level state
- `plugins/catalog-backend/src/stitching/DefaultStitcher.ts` — pre-fetch and stitch pipeline
- `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts` — merger invocation and sanitizeStatus call
- `plugins/catalog-backend/src/util/status.ts` — validation and sanitization
- `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts` — status store with orphan cleanup
- `plugins/catalog-node/src/extensions.ts` — public extension point interfaces
- `packages/catalog-model/src/entity/ref.ts:157-159` — stringifyEntityRef already lowercases
