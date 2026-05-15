---
title: 'feat: Catalog Status API Redesign Implementation'
type: feat
status: active
date: 2026-05-05
origin: docs/plans/2026-05-05-catalog-status-api-target-architecture-design.md
---

# feat: Catalog Status API Redesign Implementation

## Overview

Extend the existing `CatalogService` with status write/read methods, rename the
`?stitch=deferred` query parameter, and add a batch status write endpoint. This
plan implements the target architecture defined in the [design
spec](docs/plans/2026-05-05-catalog-status-api-target-architecture-design.md).

## Source

- **Design spec:** [2026-05-05-catalog-status-api-target-architecture-design.md](2026-05-05-catalog-status-api-target-architecture-design.md)
- **Existing status store:** `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`
- **Existing REST endpoints:** `plugins/catalog-backend/src/service/createRouter.ts`
- **Generated client methods:** `packages/catalog-client/src/schema/openapi/generated/apis/Api.client.ts`

## Implementation Phases

---

### Phase 1: Expose Status Methods in CatalogApi + CatalogClient

The generated `DefaultApiClient` already has `updateEntityStatusByName`,
`deleteEntityStatusByName`, and `getEntityStatusSourcesByName`. These need to be
surfaced in the `CatalogApi` interface and `CatalogClient` wrapper.

**Files to modify:**

- [ ] `packages/catalog-client/src/types/api.ts` — Add 3 method signatures to `CatalogApi` interface
- [ ] `packages/catalog-client/src/CatalogClient.ts` — Add 3 wrapper methods that delegate to `this.apiClient`

**`CatalogApi` additions (api.ts):**

```typescript
// Add to CatalogApi interface

/** Set the status of an entity from an external source */
updateEntityStatusByName(
  request: {
    path: { kind: string; namespace: string; name: string };
    body: { source: string; status: Record<string, any> };
    query?: { stitch?: string };
  },
  options?: CatalogRequestOptions,
): Promise<void>;

/** Delete the status of an entity from a specific source */
deleteEntityStatusByName(
  request: {
    path: { kind: string; namespace: string; name: string };
    query: { source: string; stitch?: string };
  },
  options?: CatalogRequestOptions,
): Promise<void>;

/** List the status sources for an entity */
getEntityStatusSourcesByName(
  request: {
    path: { kind: string; namespace: string; name: string };
  },
  options?: CatalogRequestOptions,
): Promise<{ sources: string[] }>;
```

**`CatalogClient` additions (CatalogClient.ts):**

Follow the existing delegation pattern (e.g., how `getEntityAncestors` wraps
`apiClient.getEntityAncestors`). Each method:

1. Calls `this.apiClient.methodName(request, options)`
2. Handles `TypedResponse` conversion
3. Returns the appropriate type

**Verification:**

- [ ] `CI=1 yarn test packages/catalog-client` — existing tests pass
- [ ] `yarn tsc` — no type errors

---

### Phase 2: Add Status Methods to CatalogService

Add three methods to the `CatalogService` interface and `DefaultCatalogService`
implementation in `catalog-node`. These delegate to `CatalogClient` (exposed in
Phase 1), following the exact same pattern as every other method.

**Files to modify:**

- [ ] `plugins/catalog-node/src/catalogService.ts` — Add 3 methods to interface + implementation

**`CatalogService` interface additions:**

```typescript
setEntityStatus(
  entityRef: string | CompoundEntityRef,
  source: string,
  status: JsonObject,
  options: CatalogServiceRequestOptions,
): Promise<void>;

deleteEntityStatus(
  entityRef: string | CompoundEntityRef,
  source: string,
  options: CatalogServiceRequestOptions,
): Promise<void>;

getEntityStatusSources(
  entityRef: string | CompoundEntityRef,
  options: CatalogServiceRequestOptions,
): Promise<string[]>;
```

**`DefaultCatalogService` implementation pattern:**

```typescript
// Same pattern as existing methods:
// 1. parseEntityRef to get kind/namespace/name
// 2. call this.#catalogApi.methodName({path: {kind, namespace, name}, ...body/query}, await this.#getOptions(options))
// 3. return result

async setEntityStatus(
  entityRef: string | CompoundEntityRef,
  source: string,
  status: JsonObject,
  options: CatalogServiceRequestOptions,
): Promise<void> {
  const { kind, namespace, name } = parseEntityRef(entityRef);
  await this.#catalogApi.updateEntityStatusByName(
    { path: { kind, namespace, name }, body: { source, status } },
    await this.#getOptions(options),
  );
}
```

**Verification:**

- [ ] `CI=1 yarn test plugins/catalog-node` — existing tests pass
- [ ] `yarn tsc` — no type errors

---

### Phase 3: Unit Tests for New Methods

Add tests for the three new `CatalogService` methods following the existing
pattern in `catalogService.test.ts` (MSW + `ServiceFactoryTester`).

**Files to modify:**

- [ ] `plugins/catalog-node/src/catalogService.test.ts` — Add 3 test cases

**Test cases:**

1. **`setEntityStatus`** — Verify:

   - Calls correct HTTP endpoint (POST `/entities/by-name/kind/namespace/name/status`)
   - Sends source and status in body
   - Injects auth token via `mockCredentials.service.header()`
   - Returns void on 204

2. **`deleteEntityStatus`** — Verify:

   - Calls correct HTTP endpoint (DELETE with `?source=` query param)
   - Injects auth token
   - Returns void on 204

3. **`getEntityStatusSources`** — Verify:

   - Calls correct HTTP endpoint (GET status)
   - Injects auth token
   - Returns `string[]` from response `{sources: [...]}`

4. **Compound entity ref** — Verify `string | CompoundEntityRef` both work

**Verification:**

- [ ] `CI=1 yarn test plugins/catalog-node/src/catalogService.test.ts` — new tests pass

---

### Phase 4: Rename `?stitch=deferred` to `?stitch=skip`

Rename the query parameter in `createRouter.ts` with backward-compatible
deprecation: accept both values for one release, log deprecation warning for
the old value.

**Files to modify:**

- [ ] `plugins/catalog-backend/src/service/createRouter.ts` — Update stitch param checks
- [ ] `plugins/catalog-backend/src/service/createRouter.test.ts` — Update/add tests

**Changes in createRouter.ts:**

Replace all occurrences of `req.query.stitch !== 'deferred'` with:

```typescript
const stitchSkip =
  (req as any).query.stitch === 'skip' ||
  (req as any).query.stitch === 'deferred'; // deprecated
if ((req as any).query.stitch === 'deferred') {
  logger.warn(
    `The ?stitch=deferred query parameter is deprecated. Use ?stitch=skip instead.`,
  );
}
// Then: if (!stitchSkip) { await stitcher.stitch(...); }
```

**Test cases:**

1. `?stitch=skip` — status written, no stitch triggered
2. `?stitch=deferred` — status written, no stitch triggered, deprecation warning logged
3. No stitch param — status written, stitch triggered
4. `?stitch=anything-else` — status written, stitch triggered

**Verification:**

- [ ] `CI=1 yarn test plugins/catalog-backend/src/service/createRouter.test.ts` — tests pass

---

### Phase 5: Batch Status Write Endpoint

Add `POST /entities/status-batch` to `createRouter.ts` with the following
contract:

- **Error handling:** Best-effort — process all items, return `207 Multi-Status`
  with per-item results
- **Authorization:** Check `catalogEntityStatusWritePermission` per entity.
  Items the user can't access return 403 in the per-item results
- **Batch limits:** Maximum 100 items per request
- **Stitching:** All unique entity refs stitched together after writes (or skip
  with `?stitch=skip`)

**Files to modify:**

- [ ] `plugins/catalog-backend/src/service/createRouter.ts` — Add batch endpoint
- [ ] `plugins/catalog-backend/src/service/createRouter.test.ts` — Add batch tests
- [ ] `plugins/catalog-backend/src/schema/openapi.yaml` — Add batch endpoint spec

**Request schema:**

```json
{
  "items": [
    {
      "entityRef": "component:default/my-api",
      "source": "github-actions",
      "status": { "state": "running" }
    }
  ]
}
```

**Response schema (207 Multi-Status):**

```json
{
  "results": [
    { "entityRef": "component:default/my-api", "status": 204 },
    {
      "entityRef": "component:default/missing",
      "status": 404,
      "error": "Entity not found"
    }
  ]
}
```

**Validation rules:**

- Maximum 100 items
- Each item validated (source format, status size ≤ 64KB, reserved keys)
- Deduplicate entity refs for stitch call

**Test cases:**

1. Batch of valid items — all succeed, entities stitched
2. Batch with one invalid source — that item fails, others succeed
3. Batch with missing entity — 404 for that item
4. Batch exceeding 100 items — 400 Bad Request
5. Empty batch — 400 Bad Request
6. `?stitch=skip` — no stitch triggered
7. Permission check per entity — user has access to some but not all

**Verification:**

- [ ] `CI=1 yarn test plugins/catalog-backend/src/service/createRouter.test.ts` — batch tests pass
- [ ] `CI=1 yarn test plugins/catalog-backend/src/tests/status-integration.test.ts` — integration tests pass

---

### Phase 6: Integration Tests

Extend the existing `status-integration.test.ts` to cover new functionality.

**Files to modify:**

- [ ] `plugins/catalog-backend/src/tests/status-integration.test.ts` — Add test cases

**New integration test cases:**

1. **DELETE status** — Push status via POST, delete via DELETE, verify status removed
2. **GET status sources** — Push status from multiple sources, verify all listed
3. **Stitch coalescing** — Rapid writes to same entity, verify single stitch in deferred mode
4. **`?stitch=skip`** — Write status with skip, verify entity.status unchanged until next stitch
5. **Batch endpoint** — Write multiple entities, verify all reflected in catalog

**Verification:**

- [ ] `CI=1 yarn test plugins/catalog-backend/src/tests/status-integration.test.ts` — all pass

---

### Phase 7: API Reports + Changesets

Generate API reports and write changesets per Backstage conventions.

**Steps:**

- [ ] Run `yarn build:api-reports` in project root
- [ ] Review generated API report changes for correctness
- [ ] Write changeset for `@backstage/plugin-catalog-node` — `patch`
- [ ] Write changeset for `@backstage/plugin-catalog-backend` — `patch`
- [ ] Write changeset for `@backstage/catalog-client` — `patch` (if Phase 1 adds to CatalogApi)

**Changeset: `@backstage/plugin-catalog-node` (patch)**

> Added `setEntityStatus`, `deleteEntityStatus`, and `getEntityStatusSources`
> methods to `CatalogService` for managing out-of-band entity status from
> backend plugins.

**Changeset: `@backstage/plugin-catalog-backend` (patch)**

> Added batch status write endpoint `POST /entities/status-batch` for bulk
> status updates. The `?stitch=deferred` query parameter is deprecated in favor
> of `?stitch=skip`; both are accepted in this release.

**Changeset: `@backstage/catalog-client` (patch)**

> Added `updateEntityStatusByName`, `deleteEntityStatusByName`, and
> `getEntityStatusSourcesByName` methods to `CatalogApi` and `CatalogClient`
> for programmatic status management.

---

### Phase 8: Final Verification

End-to-end verification across all packages.

**Checklist:**

- [ ] `yarn tsc` — no type errors in entire monorepo
- [ ] `CI=1 yarn test packages/catalog-client` — client tests pass
- [ ] `CI=1 yarn test plugins/catalog-node` — service tests pass
- [ ] `CI=1 yarn test plugins/catalog-backend` — backend tests pass
- [ ] `yarn build:api-reports` — API reports up to date
- [ ] `yarn lint --fix` — no lint errors
- [ ] `yarn prettier --write <changed files>` — formatting correct
- [ ] Manual smoke test: `yarn start`, push status via POST, verify reflected in GET entity
- [ ] Manual smoke test: batch write via POST /status-batch, verify all entities updated

---

## File Map Summary

### Modified Files

| File                                                           | Phase | Change                                             |
| -------------------------------------------------------------- | ----- | -------------------------------------------------- |
| `packages/catalog-client/src/types/api.ts`                     | 1     | Add 3 status methods to CatalogApi interface       |
| `packages/catalog-client/src/CatalogClient.ts`                 | 1     | Add 3 wrapper methods delegating to apiClient      |
| `plugins/catalog-node/src/catalogService.ts`                   | 2     | Add 3 status methods to interface + implementation |
| `plugins/catalog-node/src/catalogService.test.ts`              | 3     | Add unit tests for new methods                     |
| `plugins/catalog-backend/src/service/createRouter.ts`          | 4,5   | Rename stitch param + add batch endpoint           |
| `plugins/catalog-backend/src/service/createRouter.test.ts`     | 4,5   | Update + add tests                                 |
| `plugins/catalog-backend/src/schema/openapi.yaml`              | 5     | Add batch endpoint spec                            |
| `plugins/catalog-backend/src/tests/status-integration.test.ts` | 6     | Add integration test cases                         |

### No New Files

No new files created. All changes extend existing surfaces.

### Changeset Files

| File                                          | Package         | Bump  |
| --------------------------------------------- | --------------- | ----- |
| `.changeset/catalog-status-catalog-client.md` | catalog-client  | patch |
| `.changeset/catalog-status-catalog-node.md`   | catalog-node    | patch |
| `.changeset/catalog-status-batch-endpoint.md` | catalog-backend | patch |

---

## Dependencies Between Phases

```
Phase 1 (CatalogApi/CatalogClient)
    │
    ▼
Phase 2 (CatalogService)
    │
    ├──────────────────┐
    ▼                  ▼
Phase 3 (tests)    Phase 4 (stitch rename)
                        │
                        ▼
                   Phase 5 (batch endpoint)
                        │
                        ▼
                   Phase 6 (integration tests)
                        │
                        ▼
                   Phase 7 (API reports + changesets)
                        │
                        ▼
                   Phase 8 (final verification)
```

Phases 3 and 4 can run in parallel after Phase 2. Phase 5 depends on Phase 4
(reuses the stitch param logic). Phase 6 depends on Phase 5. Phases 7 and 8
are sequential.
