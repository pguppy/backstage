---
title: 'Fix Catalog Status API Review Recommendations'
type: fix
status: active
date: 2026-05-05
origin: docs/plans/2026-05-05-fix-catalog-status-api-design-flaws-plan.md
---

# Fix Catalog Status API Review Recommendations

## Overview

Architectural review of the catalog entity status API identified 7 issues across 3 severity tiers. This plan addresses all findings with targeted fixes following existing Backstage patterns. No architectural rewrites — each fix is minimal and independently testable.

## Problem Statement

**High severity:**

1. Missing database index on `entity_ref` — `getStatuses()` and `listSources()` do full table scans on the composite PK
2. No entity existence check on DELETE — inconsistent with POST, allows status writes for deleted entities
3. No `source` field validation — any string accepted as source name, no length/format constraints

**Medium severity:** 4. DELETE returns 204 for non-existent rows — callers can't distinguish "deleted" from "nothing to delete" 5. `BuiltinStatusMerger.preFetch` signature mismatch with interface — works by structural typing coincidence

**Low severity:** 6. Merger ordering is implicit — custom mergers should always run before built-in, but this is not enforced 7. Sanitizer only covers `javascript:` protocol — `vbscript:` and similar bypass vectors exist

## Proposed Solution

Seven targeted fixes across 3 phases. Phase 1 addresses correctness and performance (high severity). Phase 2 addresses API consistency (medium severity). Phase 3 addresses quality and documentation (low severity). Each phase is independently deployable.

## Technical Approach

### Architecture

All fixes follow existing patterns observed in the codebase:

- Index creation follows `20201007201501_index_entity_search.js` pattern (SQLite guard, descriptive index name)
- Entity existence check reuses the `entitiesBatch()` pattern already used in POST
- Source validation uses Zod schema constraints in `validateRequestBody()`
- 404 on missing row follows `DefaultLocationStore.deleteLocation()` pattern (check existence first)
- Sanitization expansion follows the existing `scriptProtocolPattern` regex approach

### Design Decisions

| Decision              | Choice                           | Rationale                                                                                                                                                          |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source max length     | 128 chars                        | Matches typical identifier lengths in Backstage (e.g., entity names)                                                                                               |
| Source allowed chars  | `[a-zA-Z0-9._-]`                 | Safe identifier characters, prevents SQL/key injection, consistent with how source appears as JSON key                                                             |
| DELETE 404 semantics  | Return 404 if status row missing | POST returns 404 for missing entity; consistency matters. Alpha API — breaking change acceptable per Backstage conventions                                         |
| Entity existence race | Accept as eventually consistent  | Matches existing Backstage pattern. Stitch is already non-transactional with status write                                                                          |
| Sanitization scope    | Add `vbscript:` only             | `javascript:` pattern is React's well-tested pattern. `data:` URLs have legitimate uses (images). `vbscript:` is the other dangerous protocol with browser support |
| Merger ordering       | Enforce built-in last in code    | Document AND enforce. Array spread ensures built-in always appended                                                                                                |

### Implementation Phases

#### Phase 1: High Severity Fixes

##### Task 1.1: Add database index on entity_ref

**Files to change:**

- `plugins/catalog-backend/migrations/20260506000000_entity_status_index.js` (new)

Create a new migration adding an index on `entity_ref`. Follow the existing Backstage pattern with SQLite guard:

```javascript
// migrations/20260506000000_entity_status_index.js

exports.up = async function up(knex) {
  if (!knex.client.config.client.includes('sqlite3')) {
    await knex.schema.alterTable('entity_status', table => {
      table.index('entity_ref', 'entity_status_entity_ref_idx');
    });
  }
};

exports.down = async function down(knex) {
  if (!knex.client.config.client.includes('sqlite3')) {
    await knex.schema.alterTable('entity_status', table => {
      table.dropIndex('entity_ref', 'entity_status_entity_ref_idx');
    });
  }
};
```

SQLite doesn't benefit from additional indexes beyond the composite PK for `WHERE IN` queries because it uses the PK index. PostgreSQL and MySQL benefit significantly because `WHERE entity_ref IN (...)` can't efficiently use the composite `(entity_ref, source)` PK for `IN` queries on just `entity_ref`.

**Validation:** Migration runs without error on all supported databases. `getStatuses()` queries use index scan instead of full table scan on PostgreSQL.

##### Task 1.2: Add source field validation

**Files to change:**

- `plugins/catalog-backend/src/util/status.ts`

Add source validation constants and function:

```typescript
// util/status.ts — add to existing file

export const MAX_SOURCE_LENGTH = 128;
export const SOURCE_PATTERN = /^[a-zA-Z0-9._-]+$/;

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
}
```

Then update the router to validate source on both POST and DELETE:

**Files to change:**

- `plugins/catalog-backend/src/service/createRouter.ts`

```typescript
// createRouter.ts — in the POST handler, after parsing body
import { validateStatusPayload, validateSource } from '../util/status';

// In POST /status handler, after extracting source:
validateSource(source);

// In DELETE /status handler, after extracting source from query:
validateSource(source);
```

Update the Zod schema for POST to also constrain at parse time:

```typescript
// In POST /status handler, update the zod schema:
const { source, status } = await validateRequestBody(
  req,
  z.object({
    source: z.string().min(1).max(128),
    status: z.record(z.any()),
  }),
);
```

The Zod schema provides first-pass validation (non-empty, max length). `validateSource()` adds the format check (allowed characters). This two-layer approach matches the existing pattern where `validateRequestBody` handles structural validation and `validateStatusPayload` handles semantic validation.

**Validation:** POST with source "github" succeeds. POST with source "a".repeat(129) returns 400. POST with source "has spaces" returns 400. DELETE with source "../../etc" returns 400.

##### Task 1.3: Add entity existence check to DELETE handler

**Files to change:**

- `plugins/catalog-backend/src/service/createRouter.ts`

Add the same entity existence check that POST uses:

```typescript
// createRouter.ts — in the DELETE handler, after permission check

const { items } = await entitiesCatalog!.entitiesBatch({
  entityRefs: [entityRef],
  credentials,
});

if (!(items as unknown as any[])[0]) {
  throw new NotFoundError(`Entity not found: ${entityRef}`);
}
```

This makes DELETE consistent with POST: both verify the entity exists before modifying status.

**Race condition acceptance:** There is an inherent race condition — the entity could be deleted between the existence check and the status deletion. This matches the POST behavior and the overall eventually-consistent design of the status system. The worst case is an orphaned status row that gets cleaned up on the next stitch.

**Validation:** DELETE for non-existent entity returns 404. DELETE for existing entity with status returns 204.

---

#### Phase 2: Medium Severity Fixes

##### Task 2.1: Return 404 when DELETE targets non-existent status row

**Files to change:**

- `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`

Change `deleteStatus` to return the number of affected rows:

```typescript
// DefaultCatalogStatusStore.ts
async deleteStatus(entityRef: string, source: string): Promise<number> {
  const deleted = await this.db('entity_status')
    .where('entity_ref', entityRef.toLowerCase())
    .where('source', source)
    .delete();
  return deleted;
}
```

Then update the DELETE handler to check the result:

**Files to change:**

- `plugins/catalog-backend/src/service/createRouter.ts`

```typescript
// createRouter.ts — in the DELETE handler, replace:
//   await statusStore.deleteStatus(entityRef, source);
// with:
const deleted = await statusStore.deleteStatus(entityRef, source);
if (deleted === 0) {
  throw new NotFoundError(
    `No status found for entity ${entityRef} from source ${source}`,
  );
}
```

**Breaking change note:** This is a behavioral change for the alpha API. Previously, DELETE was idempotent (always 204). Now, a second DELETE returns 404. This is the correct RESTful behavior and matches the DELETE location endpoint pattern in `DefaultLocationStore`. Since this is `@alpha`, the breaking change is acceptable per Backstage conventions.

**Validation:** First DELETE returns 204. Second DELETE for same source returns 404 with descriptive message.

##### Task 2.2: Fix BuiltinStatusMerger.preFetch signature

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogBuilder.ts`

Update the `BuiltinStatusMerger.preFetch` method to accept the full interface signature, ignoring `query` since it has direct store access:

```typescript
// CatalogBuilder.ts — BuiltinStatusMerger

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

This ensures the built-in merger matches the `StitchingStatusMerger` interface exactly. The `query` parameter is ignored because the built-in merger has direct store access and pre-fetches into its own cache. Custom mergers use `query` because they don't have direct store access.

Also update the `merge` method to use `options.entityRef` and `options.entity` from the options object (rather than destructured parameters) for consistency.

**Validation:** TypeScript compilation passes. No behavioral change.

---

#### Phase 3: Low Severity Fixes

##### Task 3.1: Enforce and document merger ordering

**Files to change:**

- `plugins/catalog-backend/src/service/CatalogBuilder.ts`

The current code already appends the built-in merger last via `addStitchingStatusMerger()`. Enforce this in `build()` by moving the built-in merger addition to the end, after any custom mergers:

```typescript
// CatalogBuilder.ts — in build()

// Add custom mergers first (already set via setStitchingStatusMergers)
// Then append the built-in merger last — this ensures built-in status
// data takes precedence over custom merger data if keys conflict
this.addStitchingStatusMerger(new BuiltinStatusMerger(statusStore));
```

This is already the current behavior. The fix is ensuring this order is maintained even if future code changes the call order. Add a code comment documenting the ordering guarantee.

Also update the `addStitchingStatusMerger` JSDoc:

```typescript
/**
 * Adds a status merger for stitching out-of-band data into entities.
 *
 * Custom mergers are called before the built-in status merger, which
 * runs last and takes precedence for conflicting keys.
 *
 * @param merger - The status merger to add
 */
addStitchingStatusMerger(merger: StitchingStatusMerger): CatalogBuilder {
```

**Validation:** No behavioral change. Documentation is clearer.

##### Task 3.2: Expand sanitization to cover vbscript: protocol

**Files to change:**

- `plugins/catalog-backend/src/util/status.ts`

Add `vbscript:` to the sanitization pattern:

```typescript
// util/status.ts — update the sanitizeStatus function

export const dangerousProtocolPattern =
  // eslint-disable-next-line no-control-regex
  /^[ - ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*\:/i;

export const vbscriptProtocolPattern =
  // eslint-disable-next-line no-control-regex
  /^[ - ]*v[\r\n\t]*b[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*\:/i;

export function sanitizeStatus(status: JsonObject) {
  const sanitize = (obj: any) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        if (
          dangerousProtocolPattern.test(value) ||
          vbscriptProtocolPattern.test(value)
        ) {
          obj[key] =
            'https://backstage.io/annotation-rejected-for-security-reasons';
        }
      } else if (typeof value === 'object') {
        sanitize(value);
      }
    }
  };
  sanitize(status);
}
```

Keep the existing `scriptProtocolPattern` export for backward compatibility (it's imported by `performStitching.ts` for annotation sanitization). Add the new patterns alongside it. The annotation sanitization in `performStitching.ts` continues to only check `javascript:` (which is the correct scope for annotations — they're trusted data, not user-provided status).

**Why not `data:` URLs:** `data:` URLs have legitimate uses in status payloads (e.g., `data:image/png;base64,...` for status badges). Blocking all `data:` URLs would break these use cases. The real XSS protection for `data:text/html` comes from the frontend rendering framework, not the backend storage layer. The backend's job is to catch obvious protocol-based attacks.

**Validation:** `vbscript:msgbox("xss")` in status value gets replaced. `javascript:alert(1)` still gets replaced. `data:image/png;base64,...` passes through. `https://example.com` passes through.

---

#### Phase 4: Test Coverage

##### Task 4.1: Add tests for source validation

**Files to change:**

- `plugins/catalog-backend/src/util/status.test.ts` (new)

```typescript
import { validateSource, validateStatusPayload } from './status';
import { InputError } from '@backstage/errors';

describe('validateSource', () => {
  it('accepts valid source names', () => {
    expect(() => validateSource('github')).not.toThrow();
    expect(() => validateSource('my-source')).not.toThrow();
    expect(() => validateSource('source_v2')).not.toThrow();
    expect(() => validateSource('a.b')).not.toThrow();
  });

  it('rejects empty source', () => {
    expect(() => validateSource('')).toThrow(InputError);
  });

  it('rejects source exceeding max length', () => {
    expect(() => validateSource('a'.repeat(129))).toThrow(InputError);
  });

  it('rejects source with spaces', () => {
    expect(() => validateSource('has spaces')).toThrow(InputError);
  });

  it('rejects source with special characters', () => {
    expect(() => validateSource('src!@#')).toThrow(InputError);
  });

  it('rejects source with path traversal', () => {
    expect(() => validateSource('../../etc')).toThrow(InputError);
  });
});

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

##### Task 4.2: Add tests for DELETE 404 behavior

**Files to change:**

- `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.test.ts`

Add test for the return value:

```typescript
it.each(databases.eachSupportedId())(
  'should return 0 when deleting non-existent status on %p',
  async id => {
    const knex = await databases.init(id);
    await applyDatabaseMigrations(knex);
    const store = new DefaultCatalogStatusStore(
      knex,
      mockServices.logger.mock(),
    );
    const deleted = await store.deleteStatus(
      'component:default/test',
      'nonexistent',
    );
    expect(deleted).toBe(0);
  },
);
```

##### Task 4.3: Add tests for expanded sanitization

**Files to change:**

- `plugins/catalog-backend/src/util/status.test.ts` (add to existing file)

```typescript
import { sanitizeStatus } from './status';

describe('sanitizeStatus', () => {
  it('replaces javascript: protocol URLs', () => {
    const status = { url: 'javascript:alert(1)' };
    sanitizeStatus(status);
    expect(status.url).toBe(
      'https://backstage.io/annotation-rejected-for-security-reasons',
    );
  });

  it('replaces vbscript: protocol URLs', () => {
    const status = { url: 'vbscript:msgbox("xss")' };
    sanitizeStatus(status);
    expect(status.url).toBe(
      'https://backstage.io/annotation-rejected-for-security-reasons',
    );
  });

  it('preserves safe URLs', () => {
    const status = { url: 'https://example.com' };
    sanitizeStatus(status);
    expect(status.url).toBe('https://example.com');
  });

  it('preserves data: image URLs', () => {
    const status = { badge: 'data:image/png;base64,iVBOR' };
    sanitizeStatus(status);
    expect(status.badge).toBe('data:image/png;base64,iVBOR');
  });

  it('sanitizes nested objects', () => {
    const status = { nested: { url: 'javascript:alert(1)' } };
    sanitizeStatus(status);
    expect(status.nested.url).toBe(
      'https://backstage.io/annotation-rejected-for-security-reasons',
    );
  });
});
```

##### Task 4.4: Update integration test for new behaviors

**Files to change:**

- `plugins/catalog-backend/src/tests/status-integration.test.ts`

Add test steps for:

1. Verify GET sources endpoint returns the source after write
2. Verify DELETE for non-existent source returns 404
3. Verify second DELETE returns 404

```typescript
// After step 2 (push status), add:

// 2b. Verify GET sources lists the source
const sourcesResponse = await request(server)
  .get('/api/catalog/entities/by-name/component/default/test/status')
  .set('Authorization', mockCredentials.user.header());

expect(sourcesResponse.status).toBe(200);
expect(sourcesResponse.body.sources).toContain('test-source');

// ... after step 3 (verify status in entity) ...

// 4. Delete the status
const deleteResponse = await request(server)
  .delete(
    '/api/catalog/entities/by-name/component/default/test/status?source=test-source',
  )
  .set('Authorization', mockCredentials.user.header());
expect(deleteResponse.status).toBe(204);

// 5. Delete again — should return 404
const deleteAgainResponse = await request(server)
  .delete(
    '/api/catalog/entities/by-name/component/default/test/status?source=test-source',
  )
  .set('Authorization', mockCredentials.user.header());
expect(deleteAgainResponse.status).toBe(404);
```

---

## System-Wide Impact

### Interaction Graph

```
POST /status → validateSource() → validateStatusPayload() → statusStore.setStatus()
  → stitcher.stitch() → DefaultStitcher.stitch()
    → [immediate] preFetchStatus(query) → performStitching() → merger.merge(query) → sanitizeStatus() → entity written
    → [deferred] markForStitching() → queue processes → same chain

DELETE /status → validateSource() → entitiesBatch(exists?) → statusStore.deleteStatus()
  → stitcher.stitch() → same chain as POST

GET /status → permissionsService.authorize(read) → statusStore.listSources() → response
```

### Error Propagation

| Error                 | Source                          | HTTP Status | Behavior                            |
| --------------------- | ------------------------------- | ----------- | ----------------------------------- |
| Invalid source format | `validateSource()`              | 400         | `InputError`                        |
| Source too long       | Zod schema / `validateSource()` | 400         | `InputError`                        |
| Reserved status key   | `validateStatusPayload()`       | 400         | `InputError`                        |
| Oversized status      | `validateStatusPayload()`       | 400         | `InputError`                        |
| Entity not found      | `entitiesBatch()` check         | 404         | `NotFoundError`                     |
| Status row not found  | `deleteStatus()` check          | 404         | `NotFoundError`                     |
| Permission denied     | `authorize()` check             | 403         | `NotAllowedError`                   |
| Merger failure        | merger execution                | —           | Caught and logged, stitch continues |
| Sanitization trigger  | `sanitizeStatus()`              | —           | Silent replacement, entity stored   |

### State Lifecycle Risks

- **Status write + stitch non-transactional**: If stitch fails, status is persisted but not reflected. Next scheduled stitch picks it up. No change from current behavior.
- **Entity deletion race**: Status could be written for an entity that gets deleted between the existence check and the write. Acceptable — orphaned status rows don't affect entity reads.
- **DELETE idempotency change**: Second DELETE returns 404 instead of 204. Alpha API — acceptable breaking change.

### API Surface Parity

| Change                               | Impact                             | Breaking?               |
| ------------------------------------ | ---------------------------------- | ----------------------- |
| Index on `entity_ref`                | Performance only                   | No                      |
| Source validation on POST/DELETE     | Rejects previously accepted inputs | Yes (alpha)             |
| Entity existence check on DELETE     | Returns 404 for missing entities   | Yes (alpha)             |
| 404 on missing status row for DELETE | Returns 404 instead of 204         | Yes (alpha)             |
| `BuiltinStatusMerger` signature fix  | Internal only                      | No                      |
| Merger ordering documentation        | Documentation only                 | No                      |
| `vbscript:` sanitization             | Rejects previously accepted input  | No (silent replacement) |

All breaking changes are on `@alpha` endpoints, which is acceptable per Backstage conventions.

## Acceptance Criteria

### Functional Requirements

- [ ] `entity_status` table has index on `entity_ref` column (non-SQLite databases)
- [ ] `source` field validated: max 128 chars, alphanumeric/dash/dot/underscore only
- [ ] DELETE returns 404 for non-existent entities
- [ ] DELETE returns 404 when status row doesn't exist
- [ ] `BuiltinStatusMerger.preFetch` accepts `{ entityRefs, query }` matching interface
- [ ] Built-in merger documented as always running last
- [ ] `vbscript:` protocol URLs sanitized in status data
- [ ] `data:image/*` URLs preserved in status data

### Non-Functional Requirements

- [ ] `yarn tsc` passes at project root
- [ ] `CI=1 yarn test plugins/catalog-backend/src/service/createRouter.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/database/DefaultCatalogStatusStore.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/tests/status-integration.test.ts` passes
- [ ] `CI=1 yarn test plugins/catalog-backend/src/util/status.test.ts` passes
- [ ] OpenAPI spec unchanged (no new endpoints, behavioral changes only)

### Quality Gates

- [ ] No raw Knex types exposed through `@alpha` extension point interfaces
- [ ] Source validation consistent between POST and DELETE
- [ ] Entity existence check consistent between POST and DELETE
- [ ] All new test files follow existing patterns (fewer thorough tests, not many small ones)

## Dependencies & Risks

**Dependencies:**

- Phase 1 tasks are independent of each other (index, validation, existence check)
- Phase 2 Task 2.1 (404 on missing row) depends on Phase 1 Task 1.3 (entity existence check) — both modify the DELETE handler
- Phase 2 Task 2.2 (merger signature) is independent
- Phase 3 tasks are independent
- Phase 4 depends on all prior phases

**Risks:**

- Source validation (`[a-zA-Z0-9._-]`) may reject sources already in use. Mitigated by: this is alpha, existing data in DB is not validated retroactively, and the pattern covers all reasonable source identifiers.
- The 404-on-double-DELETE change may surprise callers. Mitigated by: alpha API, documented in OpenAPI spec.
- Adding an index on a large production table may cause brief increased load during migration. Mitigated by: Backstage handles this through standard migration runner; no special handling needed.

## Alternative Approaches Considered

**1. Make DELETE idempotent (keep 204 for missing rows)**
Rejected: Inconsistent with POST behavior (which returns 404 for missing entities). RESTful convention favors 404. The "ensure deleted" use case can be handled by callers catching 404.

**2. Validate source at database level with CHECK constraint**
Rejected: Knex CHECK constraints aren't portable across SQLite/PostgreSQL/MySQL. Application-level validation is the Backstage pattern. The source field is only written through the router, which is always validated.

**3. Block all `data:` URLs in sanitization**
Rejected: `data:image/png;base64,...` URLs are legitimate for status badges and icons. The backend sanitizer should only catch obvious protocol-based attacks. Frontend rendering provides the real XSS protection.

**4. Use CONCURRENTLY for PostgreSQL index creation**
Rejected: Not all Backstage databases are PostgreSQL. The existing migration pattern uses a simple `table.index()` with SQLite guard. For most deployments, the `entity_status` table is small enough that standard index creation is fast.

**5. Make `query` parameter optional in `StitchingStatusMerger.preFetch`**
Rejected: The interface should be consistent for all mergers. The built-in merger simply ignores `query` but accepts it. Making it optional would let custom mergers skip understanding the parameter, which could lead to bugs.

## Sources & References

### Origin

- **Previous plan:** [docs/plans/2026-05-05-fix-catalog-status-api-design-flaws-plan.md](2026-05-05-fix-catalog-status-api-design-flaws-plan.md) — Phase 1 (EntityStatusQuery) and Phase 3 (shared validation) already implemented
- **Architectural review:** Performed in this conversation session, identified 7 issues across 3 severity tiers

### Internal References

- Index pattern: `plugins/catalog-backend/migrations/20201007201501_index_entity_search.js`
- DELETE with 404 pattern: `plugins/catalog-backend/src/providers/DefaultLocationStore.ts:282-298`
- Entity existence check pattern: `plugins/catalog-backend/src/service/createRouter.ts:1046-1053` (POST handler)
- Source validation pattern: `plugins/catalog-backend/src/service/util.ts:58-64` (Zod schema validation)
- Stitcher interface: `plugins/catalog-backend/src/stitching/types.ts:25-30`
- BuiltinStatusMerger: `plugins/catalog-backend/src/service/CatalogBuilder.ts:116-140`
- Sanitization: `plugins/catalog-backend/src/util/status.ts:43-56`
- Permission checking: `plugins/catalog-backend/src/service/AuthorizedLocationService.ts`
