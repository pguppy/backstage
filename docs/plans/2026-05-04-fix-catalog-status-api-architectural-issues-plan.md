---
title: 'Fix Catalog Status API Architectural Issues'
type: fix
status: active
date: 2026-05-04
---

# Fix Catalog Status API Architectural Issues

## Overview

The recently introduced catalog entity status API has several architectural flaws ranging from a correctness bug (zombie stitcher) to design gaps (no deletion, no entity validation, fragile state passing). This plan addresses all 10 issues identified during architectural review, ordered by severity.

## Problem Statement

10 issues were identified across 3 severity tiers:

**Critical (correctness bugs):**

1. `catalogStitcherServiceFactory` creates a second stitcher without status mergers
2. `AsyncLocalStorage` used as fragile inter-call side channel
3. Status endpoint doesn't verify entity existence

**Significant (design gaps):** 4. No status deletion or TTL mechanism 5. Shallow merge creates silent conflicts between sources 6. Broader sanitization scope change (behavioral regression) 7. Deferred strategy gives misleading 204 response

**Minor (quality):** 8. No payload size validation on status updates 9. `CatalogBuilder.build()` returns `DefaultStitcher` instead of `Stitcher` interface 10. No unit test coverage for the status endpoint

## Proposed Solution

Address all issues in dependency order across 4 phases. Each phase is independently testable.

## Technical Approach

### Architecture

The core change replaces the ALS-based side channel with a **merger-owned cache** pattern. Each `StitchingStatusMerger` manages its own state internally rather than relying on ambient context. The built-in status merger holds a `Map` property that `preFetch` populates and `merge` reads.

The `catalogStitcherServiceFactory` is removed as an independent factory. Instead, the stitcher created by `CatalogBuilder.build()` is exposed through the existing extension point late-binding pattern (already partially in place via `setStitcher()`).

```
Before (current, broken):
  catalogStitcherServiceFactory → new DefaultStitcher (no mergers)
  CatalogBuilder.build()        → new DefaultStitcher (with mergers)
  Result: two stitchers, service ref bypasses merging

After (fixed):
  CatalogBuilder.build()        → new DefaultStitcher (with mergers)
  CatalogPlugin                 → registers stitcher via extension point
  catalogStitcherServiceRef     → resolves to plugin-owned stitcher
  Result: single stitcher, all paths include merging
```

### Implementation Phases

#### Phase 1: Fix Critical Correctness Bugs

Tasks 1-3 fix the bugs that can cause status updates to silently not work.

##### Task 1.1: Replace ALS with merger-owned cache

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogBuilder.ts`

Replace the built-in merger's ALS pattern with a class that holds its own cache:

```typescript
// CatalogBuilder.ts — replace the anonymous merger object

class BuiltinStatusMerger implements StitchingStatusMerger {
  #cache = new Map<string, Record<string, JsonObject>>();

  constructor(private readonly statusStore: DefaultCatalogStatusStore) {}

  async preFetch({ entityRefs }: { entityRefs: string[] }): Promise<void> {
    this.#cache = await this.statusStore.getStatuses(entityRefs);
  }

  async merge({
    entity,
    entityRef,
  }: {
    entity: AlphaEntity;
    entityRef: string;
  }): Promise<void> {
    const statusData = this.#cache.get(entityRef.toLowerCase());
    if (statusData) {
      entity.status = {
        ...entity.status,
        ...statusData,
      };
    }
  }
}
```

Remove the `AsyncLocalStorage` import and the `stitchingContext` variable. Instantiate `new BuiltinStatusMerger(statusStore)` instead of the anonymous object.

**Validation:** Existing integration test (`status-integration.test.ts`) should still pass. The merger no longer depends on async context propagation.

##### Task 1.2: Remove standalone catalogStitcherServiceFactory

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogStitcherServiceFactory.ts` (delete or rewrite)
- `plugins/catalog-backend/src/index.ts` (update export)
- `plugins/catalog-node/src/catalogStitcherService.ts` (keep the ref, it's still needed)

The current factory creates a second stitcher. Replace it with a factory that resolves to the plugin-owned stitcher through the extension point. The cleanest approach: remove the standalone factory entirely and instead have `CatalogPlugin` register a service factory that resolves to the stitcher created during `build()`.

```typescript
// CatalogPlugin.ts — inside the plugin init function, after build():

const stitcherServiceFactory = createServiceFactory({
  service: catalogStitcherServiceRef,
  deps: {},
  factory: () => stitcher,
});
env.registerServiceFactory(stitcherServiceFactory);
```

This ensures `catalogStitcherServiceRef` resolves to the real stitcher with all mergers.

Remove the export of `catalogStitcherServiceFactory` from `index.ts`. The service ref stays in `catalog-node` for consumers to depend on.

**Validation:** Any plugin using `catalogStitcherServiceRef` gets the same stitcher that the catalog uses internally.

##### Task 1.3: Add entity existence check to status endpoint

**Files to change:**

- `plugins/catalog-backend/src/service/createRouter.ts`

Add an existence check before writing status. Use the `entitiesCatalog` (already available in `RouterOptions`) to look up the entity:

```typescript
// createRouter.ts — inside the POST /status handler, after auth check

const { items } = await entitiesCatalog.entitiesBatch({
  entityRefs: [entityRef],
  credentials,
});

if (!items[0]) {
  throw new NotFoundError(`Entity not found: ${entityRef}`);
}
```

This requires adding `entitiesCatalog` to the destructured options (it's already available via `RouterOptions`).

**Validation:** POST to a non-existent entity returns 404. Integration test should add a test case for this.

##### Task 1.4: Restore targeted annotation sanitization

**Files to change:**

- `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`
- `plugins/catalog-backend/src/util/status.ts`

The original code only checked `ANNOTATION_VIEW_URL` and `ANNOTATION_EDIT_URL` for `javascript:` protocol. The refactor broadened this to all annotations. Restore the targeted check for annotations while keeping the recursive sanitize for status:

```typescript
// performStitching.ts — in the annotation check section

for (const annotation of [ANNOTATION_VIEW_URL, ANNOTATION_EDIT_URL]) {
  const value = entity.metadata.annotations?.[annotation];
  if (typeof value === 'string' && scriptProtocolPattern.test(value)) {
    entity.metadata.annotations![annotation] =
      'https://backstage.io/annotation-rejected-for-security-reasons';
  }
}
```

Keep `sanitizeStatus(entity.status)` for the status field since that's new user-provided data that warrants recursive sanitization.

Move `scriptProtocolPattern` back to `performStitching.ts` since it's only used there now, or keep it in `util/status.ts` and import it.

**Validation:** Annotations are only sanitized for the two URL annotations, status is fully sanitized.

---

#### Phase 2: Add Status Deletion and Enforce Namespacing

##### Task 2.1: Add DELETE status endpoint

**Files to change:**

- `plugins/catalog-backend/src/service/createRouter.ts`
- `plugins/catalog-backend/src/schema/openapi.yaml`
- `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`

Add a `DELETE /entities/by-name/:kind/:namespace/:name/status` endpoint that removes status for a specific source:

```typescript
// createRouter.ts
router.delete(
  '/entities/by-name/:kind/:namespace/:name/status',
  async (req, res) => {
    const { kind, namespace, name } = req.params;
    const entityRef = stringifyEntityRef({ kind, namespace, name });
    const source = req.query.source as string;

    if (!source) {
      throw new InputError('source query parameter is required');
    }

    // Auth + entity existence check (same as POST)
    disallowReadonlyMode(readonlyEnabled);
    const credentials = await httpAuth.credentials(req);
    const decision = await permissionsService.authorize(/* same as POST */);
    if (decision[0].result !== AuthorizeResult.ALLOW) {
      throw new NotAllowedError('Unauthorized');
    }

    await statusStore.deleteStatus(entityRef, source);
    await stitcher.stitch({ entityRefs: [entityRef] });
    res.status(204).end();
  },
);
```

Add `deleteStatus` method to `DefaultCatalogStatusStore`:

```typescript
async deleteStatus(entityRef: string, source: string): Promise<void> {
  await this.db('entity_status')
    .where('entity_ref', entityRef.toLowerCase())
    .where('source', source)
    .delete();
}
```

Add OpenAPI spec for `DeleteEntityStatusByName`.

**Validation:** Delete removes status, entity reflects the change after stitching.

##### Task 2.2: Enforce source namespacing in status merge

**Files to change:**

- `plugins/catalog-backend/src/service/createRouter.ts` (validation)
- `plugins/catalog-backend/src/service/CatalogBuilder.ts` (built-in merger)

Change the built-in merger to namespace status under the source key instead of shallow merging:

```typescript
// Built-in merger merge() method
async merge({ entity, entityRef, query }) {
  // statusData is already keyed by source: { github: { prs: 5 } }
  // The current shallow spread is actually correct IF statusData
  // comes from getStatuses() which returns Map<source, data>
  // The issue is that the endpoint doesn't enforce source matches key
}
```

Actually, looking at this more carefully, the current design already namespaces by source. `getStatuses()` returns `Map<entityRef, { [source]: statusData }>`. The merger spreads this into `entity.status`, producing `entity.status.github = { prs: 5 }`. This IS namespaced.

The real risk is a source writing to keys like `items` or `user` that collide with existing status fields. Add a validation check:

```typescript
// createRouter.ts — in status validation
const RESERVED_STATUS_KEYS = ['items'];
if (Object.keys(status).some(k => RESERVED_STATUS_KEYS.includes(k))) {
  throw new InputError('Status keys conflict with reserved status fields');
}
```

**Validation:** Attempting to write to reserved keys returns 400.

##### Task 2.3: Add status payload size limit

**Files to change:**

- `plugins/catalog-backend/src/service/createRouter.ts`

Add a size check on the status payload. Since this repo uses manual validation rather than zod `.max()`:

```typescript
// In the POST /status handler, after parsing body
const MAX_STATUS_SIZE = 64 * 1024; // 64KB
const serializedSize = JSON.stringify(status).length;
if (serializedSize > MAX_STATUS_SIZE) {
  throw new InputError(
    `Status payload too large (${serializedSize} bytes, max ${MAX_STATUS_SIZE})`,
  );
}
```

**Validation:** Oversized payload returns 400.

---

#### Phase 3: Fix Builder Return Type and Deferred Strategy Documentation

##### Task 3.1: Return Stitcher interface from CatalogBuilder.build()

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogBuilder.ts`

Change the return type:

```typescript
async build(): Promise<{
  processingEngine: CatalogProcessingEngine;
  router: Router;
  stitcher: Stitcher;
}>
```

Import `Stitcher` from `'../stitching/types'`. The actual returned object is still a `DefaultStitcher` but typed as the interface. Update the inline type annotation at line 405 from `stitcher: DefaultStitcher` to `stitcher: Stitcher`.

**Validation:** Type checking passes.

##### Task 3.2: Document deferred strategy behavior in endpoint response

**Files to change:**

- `plugins/catalog-backend/src/schema/openapi.yaml`

Add a note to the OpenAPI response description:

```yaml
responses:
  '204':
    description: >
      Status updated successfully. Under immediate stitching strategy,
      the status is reflected immediately. Under deferred strategy,
      the status is persisted but stitching is deferred — the entity
      will reflect the update once the deferred stitch queue processes it.
```

**Validation:** OpenAPI spec is accurate.

---

#### Phase 4: Test Coverage

##### Task 4.1: Add unit tests for status endpoint in createRouter.test.ts

**Files to change:**

- `plugins/catalog-backend/src/service/createRouter.test.ts`

Add tests for:

1. POST status for non-existent entity returns 404
2. POST status with oversized payload returns 400
3. POST status with reserved key returns 400
4. DELETE status removes status data
5. DELETE status without source query param returns 400
6. POST status without permission returns 403

Mock `statusStore` and `stitcher` with actual implementations:

```typescript
// Replace {} as any with functional mocks
statusStore: {
  setStatus: jest.fn(),
  deleteStatus: jest.fn(),
  getStatuses: jest.fn().mockResolvedValue(new Map()),
},
stitcher: {
  stitch: jest.fn(),
},
```

##### Task 4.2: Add deleteStatus test to DefaultCatalogStatusStore.test.ts

**Files to change:**

- `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.test.ts`

Add test case for deleteStatus:

```typescript
it('should delete status by source', async () => {
  await store.setStatus('component:default/test', 'github', { prs: 5 });
  await store.setStatus('component:default/test', 'pagerduty', { alerts: 1 });
  await store.deleteStatus('component:default/test', 'github');
  const result = await store.getStatuses(['component:default/test']);
  expect(result.get('component:default/test')).toEqual({
    pagerduty: { alerts: 1 },
  });
});
```

---

## System-Wide Impact

### Interaction Graph

- `POST /status` → `statusStore.setStatus()` → `stitcher.stitch()` → `DefaultStitcher.stitch()` → `preFetchStatus()` → `performStitching()` → `merger.merge()` → entity written to `final_entities`
- `DELETE /status` → `statusStore.deleteStatus()` → `stitcher.stitch()` → same chain as above
- `catalogStitcherServiceRef` resolution → plugin-registered factory → same stitcher instance

### Error Propagation

- Status store errors (DB down) propagate as 500 to caller
- Stitch errors are caught and logged, status is already persisted (eventually consistent)
- Permission errors return 403 via `NotAllowedError`
- Missing entity returns 404 via `NotFoundError`

### State Lifecycle Risks

- Status write + stitch are not transactional — status persists even if stitch fails. This is intentional (eventually consistent).
- Delete + stitch same pattern — acceptable.
- No risk of orphaned state from partial failure.

### API Surface Parity

- `catalogStitcherServiceFactory` removed from public API (was `@alpha`)
- `DELETE /status` is a new endpoint
- `RouterOptions` gains `entitiesCatalog` dependency for existence check (may already be present)
- `DefaultCatalogStatusStore` gains `deleteStatus()` method

### Integration Test Scenarios

1. **Full lifecycle**: Write status → verify in entity → delete status → verify removal
2. **Permission denied**: Write status without permission → 403
3. **Non-existent entity**: Write status for missing entity → 404
4. **Oversized payload**: Write status > 64KB → 400
5. **Reserved key collision**: Write status with `items` key → 400

## Acceptance Criteria

### Functional Requirements

- [ ] `catalogStitcherServiceRef` resolves to the same stitcher the catalog uses (with all mergers)
- [ ] AsyncLocalStorage removed from status merger; replaced with class-owned cache
- [ ] POST /status returns 404 for non-existent entities
- [ ] DELETE /status removes status for a given source
- [ ] Status payload limited to 64KB
- [ ] Reserved status keys (`items`) rejected at write time
- [ ] Annotation sanitization restored to targeted check (view/edit URLs only)
- [ `CatalogBuilder.build()` returns `Stitcher` interface type

### Non-Functional Requirements

- [ ] All existing tests pass
- [ ] New unit tests for status endpoint (404, 400 cases)
- [ ] Integration test for full lifecycle (write → verify → delete → verify)
- [ ] OpenAPI spec updated with accurate descriptions

### Quality Gates

- [ ] `CI=1 yarn test plugins/catalog-backend/src/service/createRouter.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/database/DefaultCatalogStatusStore.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/tests/status-integration.test.ts` passes
- [ ] `yarn tsc` passes at project root

## Dependencies & Risks

**Dependencies:**

- Phase 1 tasks are ordered: 1.1 (cache refactor) → 1.2 (factory fix) → 1.3 (existence check) → 1.4 (sanitization restore)
- Phase 2 depends on Phase 1 completion
- Phase 3 and 4 can run in parallel with Phase 2

**Risks:**

- Removing `catalogStitcherServiceFactory` as a standalone export is a breaking change for `@alpha` consumers. Since it's alpha, this is acceptable per Backstage conventions.
- Adding `entitiesCatalog` to the status handler's closure may require passing it through `RouterOptions` if not already available. Need to verify it's accessible.
- The `stitcher` exposed via service ref is the concrete `DefaultStitcher` typed as `Stitcher` — external consumers only see the `stitch()` method, which is correct.

## Sources & References

### Internal References

- Architecture review (this conversation, previous turn)
- Stitcher interface: `plugins/catalog-backend/src/stitching/types.ts:25-30`
- Current ALS pattern: `plugins/catalog-backend/src/service/CatalogBuilder.ts:438-458`
- Zombie factory: `plugins/catalog-backend/src/service/CatalogStitcherServiceFactory.ts:30-45`
- Status endpoint: `plugins/catalog-backend/src/service/createRouter.ts:988-1037`
- Status store: `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`
- Sanitization: `plugins/catalog-backend/src/util/status.ts`
- Extension point: `plugins/catalog-node/src/extensions.ts:169-207`
