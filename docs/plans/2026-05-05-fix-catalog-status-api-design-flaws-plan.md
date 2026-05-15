---
title: 'Fix Catalog Status API Design Flaws'
type: fix
status: active
date: 2026-05-05
---

# Fix Catalog Status API Design Flaws

## Overview

The catalog entity status API is functionally working but has design flaws in its public extension point interfaces, dead code, duplicated utilities, and missing shared validation. This plan addresses the 6 issues identified during architectural review, ordered by impact.

## Problem Statement

The architectural review identified the following issues in the current implementation:

**High Impact (public API surface):**

1. `StitchingStatusQuery` exposes raw Knex query builder to plugin authors — couples external code to internal DB schema
2. `BuiltinStatusMerger.preFetch` bypasses its own `StitchingStatusQuery` interface — signals the abstraction is wrong
3. `catalogStitcherServiceRef` is dead code — defined but never registered as a service factory

**Medium Impact (quality & correctness):** 4. Status payload validation (size, reserved keys) lives only in the router — store callers bypass it 5. `scriptProtocolPattern` regex is duplicated in `performStitching.ts` and `util/status.ts`

**Low Impact (usability):** 6. No way to list status sources for an entity without reading the full entity

## Proposed Solution

Fix each issue with minimal changes, following existing Backstage patterns observed in the codebase. No architectural rewrites — targeted fixes.

## Technical Approach

### Architecture

The key change is replacing the raw `StitchingStatusQuery` with a typed `EntityStatusStore` interface that hides database details. The built-in merger already uses `DefaultCatalogStatusStore` directly — we formalize this pattern and give custom mergers a similarly typed interface.

The `catalogStitcherServiceRef` gets a proper service factory registration inside `CatalogPlugin.ts`, making it resolvable through the standard dependency injection system.

Shared validation functions move to `util/status.ts` (which already exists for sanitization), making them importable by both the router and any future callers.

### Implementation Phases

#### Phase 1: Replace StitchingStatusQuery with Typed Store Interface

This is the most impactful change — it fixes issues #1, #2, and the abstraction asymmetry.

##### Task 1.1: Define EntityStatusQuery interface

**Files to change:**

- `plugins/catalog-node/src/extensions.ts`

Replace the raw `StitchingStatusQuery` with a typed domain interface:

```typescript
// plugins/catalog-node/src/extensions.ts

/** @alpha */
export interface EntityStatusQuery {
  /**
   * Get status data for a batch of entity refs, grouped by source.
   * Returns a Map where keys are lowercased entity refs and values
   * are objects keyed by source name.
   */
  getStatuses(entityRefs: string[]): Promise<Map<string, Record<string, any>>>;
}
```

This is the interface custom mergers receive in their `preFetch` and `merge` callbacks. It hides the database table names, column names, and query builder API.

Update the merger interface to use it:

```typescript
/** @alpha */
export interface StitchingStatusMerger {
  init?(options: { stitcher: CatalogStitcherService }): Promise<void>;

  preFetch?(options: {
    entityRefs: string[];
    query: EntityStatusQuery;
  }): Promise<void>;

  merge(options: {
    entity: AlphaEntity;
    entityRef: string;
    query: EntityStatusQuery;
  }): Promise<void>;
}
```

##### Task 1.2: Update DefaultStitcher to provide EntityStatusQuery

**Files to change:**

- `plugins/catalog-backend/src/stitching/DefaultStitcher.ts`

Replace the raw Knex query wrapper in `preFetchStatus` with a typed implementation:

```typescript
// DefaultStitcher.ts — replace the preFetchStatus method

private async preFetchStatus(entityRefs: string[]) {
  if (!this.stitchingStatusMergers?.length || entityRefs.length === 0) return;

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
}
```

This requires `DefaultStitcher` to hold a reference to the `DefaultCatalogStatusStore`. Pass it through the constructor:

```typescript
constructor(options: {
  knex: Knex;
  logger: LoggerService;
  metrics: MetricsService;
  strategy: StitchingStrategy;
  stitchingStatusMergers?: StitchingStatusMerger[];
  statusStore: DefaultCatalogStatusStore;  // ADD
}) {
```

Update `fromConfig` to accept and pass it through.

##### Task 1.3: Update CatalogBuilder to pass statusStore to stitcher

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogBuilder.ts`

Pass the `statusStore` instance to `DefaultStitcher.fromConfig`:

```typescript
const stitcher = DefaultStitcher.fromConfig(config, {
  knex: dbClient,
  logger,
  metrics,
  stitchingStatusMergers: this.stitchingStatusMergers,
  statusStore, // ADD
});
```

##### Task 1.4: Update performStitching to use EntityStatusQuery

**Files to change:**

- `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`

Replace the inline Knex query construction with the typed `EntityStatusQuery`:

```typescript
// performStitching.ts — replace the merger execution block (lines ~211-225)

if (stitchingStatusMergers?.length) {
  const query: EntityStatusQuery = {
    getStatuses: async (refs: string[]) => {
      return statusStore.getStatuses(refs);
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

This requires passing `statusStore` into `performStitching` options. Add it to the function signature:

```typescript
export async function performStitching(options: {
  knex: Knex | Knex.Transaction;
  logger: LoggerService;
  strategy: StitchingStrategy;
  entityRef: string;
  stitchTicket?: string;
  stitchingStatusMergers?: StitchingStatusMerger[];
  statusStore: DefaultCatalogStatusStore; // ADD
});
```

Update the call site in `DefaultStitcher.#stitchOne` to pass it through.

##### Task 1.5: Update BuiltinStatusMerger preFetch to use query parameter

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogBuilder.ts`

The `BuiltinStatusMerger` already works correctly — its `preFetch` calls `this.statusStore.getStatuses()` directly, and its `merge` reads from its `#cache`. The asymmetry is resolved because the `EntityStatusQuery` interface now mirrors what the built-in merger already does. No change needed to `BuiltinStatusMerger` itself — the fix is that custom mergers now get the same typed interface.

##### Task 1.6: Update exports in catalog-node/alpha.ts

**Files to change:**

- `plugins/catalog-node/src/alpha.ts`

Update the re-exports to replace `StitchingStatusQuery` with `EntityStatusQuery`:

```typescript
export type {
  CatalogModelExtensionPoint,
  CatalogStitchingExtensionPoint,
  StitchingStatusMerger,
  EntityStatusQuery, // RENAMED from StitchingStatusQuery
} from './extensions';
```

**Validation:** `yarn tsc` passes. Existing integration test still passes.

---

#### Phase 2: Wire catalogStitcherServiceRef as a Real Service

##### Task 2.1: Register service factory in CatalogPlugin

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogPlugin.ts`
- `plugins/catalog-node/src/catalogStitcherService.ts`

The `catalogStitcherServiceRef` is currently a bare ref with no factory. Register it in the plugin init after `build()` completes:

```typescript
// CatalogPlugin.ts — after const { processingEngine, router, stitcher } = await builder.build();

import { createServiceFactory } from '@backstage/backend-plugin-api';
import { catalogStitcherServiceRef } from '@backstage/plugin-catalog-node/alpha';

// Inside the init function, after builder.build():
const stitcherServiceFactory = createServiceFactory({
  service: catalogStitcherServiceRef,
  deps: {},
  async factory() {
    return stitcher;
  },
});
env.registerServiceFactory(stitcherServiceFactory);
```

This makes `catalogStitcherServiceRef` resolvable by any module that depends on it through the standard DI system. Mergers that need to trigger stitching can declare a dependency on `catalogStitcherServiceRef` instead of relying on the `init()` callback.

The `CatalogStitchingExtensionPointImpl.setStitcher()` method and the `init` callback on mergers can remain as a secondary mechanism for backward compatibility during alpha.

##### Task 2.2: Add defaultFactory to catalogStitcherServiceRef (optional)

**Files to change:**

- `plugins/catalog-node/src/catalogStitcherService.ts`

Alternatively (or in addition), add a `defaultFactory` that throws a clear error if the catalog plugin isn't installed:

```typescript
export const catalogStitcherServiceRef =
  createServiceRef<CatalogStitcherService>({
    id: 'catalog.stitcher',
    // No defaultFactory — only available when catalog plugin is installed
  });
```

Keep it as-is (no default factory) since the service is plugin-provided. This is the same pattern as `catalogScmEventsServiceRef`.

**Validation:** A module depending on `catalogStitcherServiceRef` gets the real stitcher instance at runtime.

---

#### Phase 3: Extract Shared Validation & Deduplicate Utilities

##### Task 3.1: Move status validation to util/status.ts

**Files to change:**

- `plugins/catalog-backend/src/util/status.ts` (extend)
- `plugins/catalog-backend/src/service/createRouter.ts` (simplify)

Add validation constants and a shared validation function to the existing `status.ts`:

```typescript
// util/status.ts — add to existing file

export const RESERVED_STATUS_KEYS = ['items'] as const;
export const MAX_STATUS_SIZE = 64 * 1024; // 64KB

export function validateStatusPayload(status: Record<string, any>): void {
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
}
```

Update the router to use it:

```typescript
// createRouter.ts — replace inline validation
import { validateStatusPayload } from '../util/status';

// In the POST handler:
validateStatusPayload(status);
```

This means any future caller of `statusStore.setStatus()` can also use `validateStatusPayload()` without duplicating the logic.

##### Task 3.2: Deduplicate scriptProtocolPattern

**Files to change:**

- `plugins/catalog-backend/src/util/status.ts`
- `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`

Export the regex from `util/status.ts`:

```typescript
// util/status.ts
export const scriptProtocolPattern =
  // eslint-disable-next-line no-control-regex
  /^[ - ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*\:/i;
```

Import it in `performStitching.ts` and remove the local copy:

```typescript
// performStitching.ts — replace local regex definition
import { sanitizeStatus, scriptProtocolPattern } from '../../../util/status';
```

Remove lines 43-46 (the local `scriptProtocolPattern` definition).

**Validation:** `yarn tsc` passes. Annotation sanitization and status sanitization use the same regex.

---

#### Phase 4: Add Status Source Listing Endpoint

##### Task 4.1: Add GET status sources endpoint

**Files to change:**

- `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`
- `plugins/catalog-backend/src/service/createRouter.ts`
- `plugins/catalog-backend/src/schema/openapi.yaml`

Add a method to list sources for an entity:

```typescript
// DefaultCatalogStatusStore.ts
async listSources(entityRef: string): Promise<string[]> {
  const rows = await this.db('entity_status')
    .where('entity_ref', entityRef.toLowerCase())
    .select('source');
  return rows.map(r => r.source);
}
```

Add a lightweight GET endpoint:

```typescript
// createRouter.ts
router.get(
  '/entities/by-name/:kind/:namespace/:name/status',
  async (req, res) => {
    const { kind, namespace, name } = req.params;
    const entityRef = stringifyEntityRef({ kind, namespace, name });

    const credentials = await httpAuth.credentials(req);

    const decision = await permissionsService.authorize(
      [{ permission: catalogEntityReadPermission, resourceRef: entityRef }],
      { credentials },
    );

    if (decision[0].result !== AuthorizeResult.ALLOW) {
      throw new NotAllowedError('Unauthorized');
    }

    const sources = await statusStore.listSources(entityRef);
    res.json({ sources });
  },
);
```

This uses the existing read permission (not the status write permission) since it's a read operation.

Add OpenAPI spec for `GetEntityStatusSourcesByName`.

**Validation:** GET returns list of sources for an entity that has status data.

---

#### Phase 5: Test Coverage

##### Task 5.1: Update DefaultCatalogStatusStore.test.ts

**Files to change:**

- `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.test.ts`

Add test for `listSources`:

```typescript
it.each(databases.eachSupportedId())(
  'should list sources for an entity on %p',
  async id => {
    const knex = await databases.init(id);
    await applyDatabaseMigrations(knex);
    const store = new DefaultCatalogStatusStore(
      knex,
      mockServices.logger.mock(),
    );

    await store.setStatus('component:default/test', 'github', { prs: 5 });
    await store.setStatus('component:default/test', 'pagerduty', { alerts: 1 });

    const sources = await store.listSources('component:default/test');
    expect(sources.sort()).toEqual(['github', 'pagerduty']);
  },
);
```

##### Task 5.2: Add unit tests for validateStatusPayload

**Files to change:**

- `plugins/catalog-backend/src/util/status.ts` (add tests in `status.test.ts`)

```typescript
// util/status.test.ts
import { validateStatusPayload } from './status';
import { InputError } from '@backstage/errors';

describe('validateStatusPayload', () => {
  it('accepts valid status', () => {
    expect(() => validateStatusPayload({ ok: true })).not.toThrow();
  });

  it('rejects reserved keys', () => {
    expect(() => validateStatusPayload({ items: [] })).toThrow(InputError);
  });

  it('rejects oversized payload', () => {
    const large = { data: 'x'.repeat(65 * 1024) };
    expect(() => validateStatusPayload(large)).toThrow(InputError);
  });
});
```

##### Task 5.3: Update integration test for list sources

**Files to change:**

- `plugins/catalog-backend/src/tests/status-integration.test.ts`

Add a step after writing status to verify the GET sources endpoint:

```typescript
// After step 2 (push status)
const sourcesResponse = await request(server)
  .get('/api/catalog/entities/by-name/component/default/test/status')
  .set('Authorization', mockCredentials.user.header());

expect(sourcesResponse.status).toBe(200);
expect(sourcesResponse.body.sources).toContain('test-source');
```

---

## System-Wide Impact

### Interaction Graph

- `POST /status` → `validateStatusPayload()` → `statusStore.setStatus()` → `stitcher.stitch()` → `DefaultStitcher.stitch()` → `preFetchStatus(query)` → `performStitching()` → `merger.merge(query)` → entity written
- `DELETE /status` → `statusStore.deleteStatus()` → `stitcher.stitch()` → same chain
- `GET /status` → `statusStore.listSources()` → response
- `catalogStitcherServiceRef` resolution → plugin-registered factory → same stitcher instance

### Error Propagation

- Validation errors (reserved keys, oversized) → `InputError` → 400
- Permission errors → `NotAllowedError` → 403
- Entity not found → `NotFoundError` → 404
- Merger errors → caught and logged, stitch continues (eventually consistent)

### State Lifecycle Risks

- Status write + stitch remain non-transactional — intentional eventually consistent design
- No new state lifecycle risks introduced by these changes

### API Surface Parity

| Change                                         | Impact                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `StitchingStatusQuery` → `EntityStatusQuery`   | Breaking for `@alpha` consumers (acceptable per Backstage conventions) |
| `catalogStitcherServiceRef` becomes resolvable | Additive, non-breaking                                                 |
| `GET /status` endpoint                         | Additive, non-breaking                                                 |
| Shared `validateStatusPayload()`               | Internal refactor, non-breaking                                        |

## Acceptance Criteria

### Functional Requirements

- [ ] `StitchingStatusQuery` replaced with typed `EntityStatusQuery` interface
- [ ] Custom mergers receive `EntityStatusQuery` (not raw Knex) in `preFetch` and `merge`
- [ ] `catalogStitcherServiceRef` resolves to the real stitcher through DI
- [ ] Status validation (size, reserved keys) shared via `validateStatusPayload()` in `util/status.ts`
- [ ] `scriptProtocolPattern` defined once in `util/status.ts`, imported by `performStitching.ts`
- [ ] `GET /entities/by-name/:kind/:namespace/:name/status` returns list of sources
- [ ] All existing tests pass

### Non-Functional Requirements

- [ ] `yarn tsc` passes at project root
- [ ] `CI=1 yarn test plugins/catalog-backend/src/service/createRouter.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/database/DefaultCatalogStatusStore.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/tests/status-integration.test.ts` passes
- [ ] OpenAPI spec updated for new GET endpoint

### Quality Gates

- [ ] No raw Knex types exposed through `@alpha` extension point interfaces
- [ ] No duplicated regex patterns
- [ ] Service ref is properly registered and resolvable

## Dependencies & Risks

**Dependencies:**

- Phase 1 is self-contained and should land first (it changes the extension point interface)
- Phase 2 depends on Phase 1 (service factory needs the stitcher to be fully wired)
- Phase 3 is independent (validation extraction and dedup)
- Phase 4 depends on Phase 1 (new endpoint uses the store)
- Phase 5 depends on all prior phases

**Risks:**

- Renaming `StitchingStatusQuery` to `EntityStatusQuery` is a breaking change for `@alpha` consumers. Per Backstage conventions, alpha APIs can break. This is acceptable.
- Adding `statusStore` to `performStitching` options increases the function's parameter surface. The alternative (passing it through the merger) was considered but rejected because it would require each merger to hold a store reference.
- Registering `catalogStitcherServiceRef` as a service factory means it becomes available to all modules. The stitcher's `stitch()` method is already safe to call from external code.

## Alternative Approaches Considered

**1. Keep StitchingStatusQuery but type the parameters more narrowly**
Rejected: Still exposes table names and column names. The fundamental problem is that "select from arbitrary table" is too broad an interface for what mergers need (they only ever query entity status).

**2. Pass statusStore directly to mergers instead of a query interface**
Rejected: Would couple mergers to `DefaultCatalogStatusStore` implementation. The `EntityStatusQuery` interface allows for alternative implementations (e.g., caching, remote stores).

**3. Don't register catalogStitcherServiceRef as a service factory, keep extension point only**
Rejected: The extension point callback pattern (`init({ stitcher })`) is a secondary mechanism. Proper DI is the Backstage standard for service dependencies.

## Sources & References

### Internal References

- Extension point definitions: `plugins/catalog-node/src/extensions.ts:169-207`
- Dead service ref: `plugins/catalog-node/src/catalogStitcherService.ts:39-42`
- Duplicated regex: `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts:43-46` and `plugins/catalog-backend/src/util/status.ts:19-21`
- Current validation: `plugins/catalog-backend/src/service/createRouter.ts` (inline in POST handler)
- Service factory pattern example: `plugins/catalog-node/src/catalogService.ts:405-421`
- Status store: `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`
- Built-in merger: `plugins/catalog-backend/src/service/CatalogBuilder.ts` (BuiltinStatusMerger class)
- Plugin wiring: `plugins/catalog-backend/src/service/CatalogPlugin.ts:208-320`

### Related Work

- Previous plan (partially implemented): `docs/plans/2026-05-04-fix-catalog-status-api-architectural-issues-plan.md`
