# Catalog Status API — v12.0: Minimal Design

**Status:** Draft  
**Date:** 2025-05-16  
**Predecessors:** v3.2 (deleted), v4.0-v9.0 (provider+extension point), v10.0 (standalone), v11.0 (read enricher)

---

## 1. Why Every Previous Design Failed

| Version | Approach | Fatal Flaw |
|---------|----------|------------|
| v3.2 | Processor + refresh queue | `refreshEntity()` floods catalog processing pipeline at scale |
| v4.0-v6.0 | Entity Provider | Two providers cannot own same `entity_ref` |
| v7.0-v9.0 | Provider + cross-plugin extension point | Extension points are plugin-scoped; cross-plugin buses unsafe |
| v10.0 | Standalone status API | User requirement: status MUST be in entity JSON |
| v11.0 | Read Enricher (core contribution) | Status not in stored entity — can't filter, search, export |

**Root cause of ALL failures:** trying to work AROUND the stitcher instead of WITH it.

---

## 2. What We Actually Need

**One capability:** a way to update a field on the final entity.

That's it. Not a 10-package architecture. Not a custom notification bus. Not a read enricher. Just:

```ts
catalogDb.updateEntityField('component:default/my-svc', 'status', { items: [...] });
```

This requires the stitcher to **preserve** that field when it re-stitches the entity.

---

## 3. The Stitcher Already Supports This (Partially)

Source: `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`

**Lines 208-213** — the stitcher MERGES status items:
```ts
// Line 208-213: Stitcher merges error status items
if (statusItems.length) {
  entity.status = {
    ...entity.status,                                   // preserves existing
    items: [...(entity.status?.items ?? []), ...statusItems],  // appends errors
  };
}
```

This proves the stitcher **already knows how to preserve non-error status items**. A processor can add `status.items` in `postProcessEntity()` and they survive to `final_entities`.

The problem: triggering re-processing for every status update is wasteful (full pipeline traversal).

---

## 4. The Minimal Fix: Two Small Changes

### 4.1 `CatalogBuilder.addExternallyManagedField(fieldName)`

Registers a field that the stitcher should read from the **existing** `final_entities` row and merge into the stitched entity before writing.

**Injection point:** `performStitching.ts`, after line 213, before line 216 (hash computation).

```ts
// NEW: After all stitcher enrichments (lines 171-213), before hash (line 216):
// Preserve externally-managed fields from existing final_entity
if (options.externallyManagedFields?.length) {
  const existingRow = await knex<DbFinalEntitiesRow>('final_entities')
    .select('final_entity')
    .where('entity_id', entityId)
    .first();
  
  if (existingRow?.final_entity) {
    const existing = JSON.parse(existingRow.final_entity) as AlphaEntity;
    
    if (options.externallyManagedFields.includes('status')) {
      // Status merge: external items + stitcher error items
      const externalItems = (existing.status?.items ?? [])
        .filter(i => i.type !== ENTITY_STATUS_CATALOG_PROCESSING_TYPE);
      const stitcherErrorItems = (entity.status?.items ?? [])
        .filter(i => i.type === ENTITY_STATUS_CATALOG_PROCESSING_TYPE);
      entity.status = {
        items: [...externalItems, ...stitcherErrorItems],
      };
    }
  }
}
```

**Why this merge strategy:**
- External items (CI status, PagerDuty, health) → preserved as-is
- Stitcher error items (processing errors) → freshly recomputed each stitch
- No duplicates because error items are filtered from external set

### 4.2 `CatalogDatabase.updateEntityField(entityRef, field, value)`

Direct update to `final_entities.final_entity` using the same `stitch_ticket` concurrency pattern the stitcher uses.

**New interface method:**
```ts
// In database/types.ts — CatalogDatabase interface:
updateEntityField(
  entityRef: string,
  field: string,
  value: unknown,
): Promise<void>;
```

**Implementation in `DefaultCatalogDatabase`:**
```ts
async updateEntityField(
  entityRef: string,
  field: string,
  value: unknown,
): Promise<void> {
  const db = this.options.database;
  
  // Set stitch ticket for concurrency control
  const stitchTicket = uuid();
  await db<DbFinalEntitiesRow>('final_entities')
    .where('entity_ref', entityRef)
    .update({ stitch_ticket: stitchTicket });
  
  // Read existing entity
  const row = await db<DbFinalEntitiesRow>('final_entities')
    .select('entity_id', 'final_entity')
    .where('entity_ref', entityRef)
    .whereNotNull('final_entity')
    .first();
  
  if (!row) return; // Entity not yet stitched — will be picked up on first stitch
  
  // Mutate
  const entity = typeof row.final_entity === 'string'
    ? JSON.parse(row.final_entity)
    : row.final_entity;
  entity[field] = value;
  const hash = generateStableHash(entity);
  
  // Write with ticket gate
  const updated = await db<DbFinalEntitiesRow>('final_entities')
    .where('entity_id', row.entity_id)
    .where('stitch_ticket', stitchTicket)
    .update({
      final_entity: JSON.stringify(entity),
      hash,
      last_updated_at: db.fn.now(),
    });
  
  if (updated === 0) {
    throw new ConflictError(`Concurrent modification of ${entityRef}`);
  }
}
```

### Concurrency Safety

The `stitch_ticket` pattern ensures mutual exclusion between stitcher writes and external field writes:

```
Scenario: Status write wins

Time 1: StatusPlugin.setTicket(T1)
Time 2: Stitcher merges ticket → T2 (overwrites T1)
Time 3: StatusPlugin reads entity (has T2 now, but that's fine)
Time 4: StatusPlugin mutates, writes with WHERE stitch_ticket = T1 → 0 rows → ConflictError
Time 5: StatusPlugin RETRIES: set T3, read entity, write with T3 → success
Time 6: Stitcher processes, reads entity (includes T3's status via external field), writes with T2 → 0 rows → abandoned
Time 7: Stitcher will re-run on next cycle, reads status from external field, preserves it
```

```
Scenario: Stitcher wins

Time 1: Stitcher.setTicket(T1)
Time 2: StatusPlugin.setTicket(T2) (overwrites T1)
Time 3: Stitcher processes, writes with WHERE stitch_ticket = T1 → 0 rows → abandoned
Time 4: StatusPlugin reads entity, mutates, writes with T2 → success
Time 5: Stitcher re-runs, reads status from external field, preserves it
```

Both scenarios converge correctly because:
- The stitcher preserves externally-managed fields on every stitch
- The stitch_ticket prevents concurrent blind overwrites

---

## 5. What This Enables

### The Status Plugin (Simplified)

```ts
// packages/status-backend/src/router.ts
async function handlePostStatus(req, res) {
  const { entityRef, type, level, message } = req.body;
  
  // 1. Write to status tables (high-churn, indexed)
  await db('entity_status_active')
    .insert({ entity_ref: entityRef, type, level, message, ... })
    .onConflict(['entity_ref', 'type'])
    .merge(['level', 'message', 'updated_at']);
  
  await db('status_history').insert({ entity_ref: entityRef, type, level, message });
  
  // 2. Compute bounded summary
  const items = await db('entity_status_active')
    .where('entity_ref', entityRef)
    .select('type', 'level', 'message');
  
  // 3. Push to catalog entity — ONE LINE
  await catalogDatabase.updateEntityField(entityRef, 'status', {
    items: items.map(i => ({ ...i, source: 'status-plugin' }))
  });
  
  res.json({ success: true });
}
```

### Frontend

```tsx
// Status appears directly on entity — no separate API call
const entity = await catalogApi.getEntityByRef('component:default/my-svc');
console.log(entity.status?.items);
// [
//   { type: 'ci-cd', level: 'error', message: 'Build #123 failed' },
//   { type: 'pagerduty', level: 'warning', message: '1 open incident' },
// ]
```

### Catalog Filtering (Future)

Since `status` is in `final_entities.final_entity`, catalog queries could filter by status once the catalog supports JSON field filtering. For now, the status API provides its own filtering.

---

## 6. What Changed (vs v11.0)

| v11.0 (Read Enricher) | v12.0 (Minimal) |
|---|---|
| Read enricher injects status at read time | Status stored directly in `final_entities` |
| Status not in stored entity | Status in stored entity — filterable, exportable |
| Requires core contribution + separate API | Two small core changes + simple plugin |
| ~50 lines core code | ~40 lines core code |
| Fresh every read | Eventually consistent (status API → entity, ~seconds) |
| Frontend: entity.status appears magically | Frontend: entity.status reads from entity JSON |

---

## 7. Complete Change List

### Core Changes (catalog-backend)

1. **`database/types.ts`** — Add `updateEntityField` to `CatalogDatabase` interface
2. **`database/DefaultCatalogDatabase.ts`** — Implement `updateEntityField` (~30 lines)
3. **`service/CatalogBuilder.ts`** — Add `addExternallyManagedField()` method, thread through to stitcher
4. **`stitching/DefaultStitcher.ts`** — Accept `externallyManagedFields` in constructor, pass to `performStitching`
5. **`database/operations/stitcher/performStitching.ts`** — Inject field preservation after line 213 (~15 lines)
6. **`stitching/types.ts`** — Add `externallyManagedFields` to `Stitcher` type / options

### Status Plugin

7. **`plugins/status-common/`** — Shared types: `StatusRequest`, `StatusResponse`
8. **`plugins/status-node/`** — `StatusApi` interface (backend)
9. **`plugins/status-backend/`** — Tables, router, `updateEntityField` call
10. **`plugins/status-react/`** — React hooks for fetching status (fallback: reads from entity)
11. **`plugins/status/`** — Frontend plugin (entity page card, catalog table column)

### Wiring

12. **`packages/backend/src/index.ts`** — Register status backend plugin
13. **`packages/app/src/App.tsx`** — Register status frontend plugin

### Total
- **~6 core lines changed** in `performStitching.ts`
- **~30 lines** in `DefaultCatalogDatabase.ts`
- **~10 lines** in `CatalogBuilder.ts`
- **~10 lines** in `DefaultStitcher.ts`
- **~5 packages** for status feature (standard Backstage plugin structure)

---

## 8. Scale Analysis

| Metric | Value |
|---|---|
| `updateEntityField` call | 1 DB read + 1 DB write per status change |
| Latency | <10ms (single-row operations) |
| Write scale | 1,667 writes/s × 10ms = no bottleneck |
| Entity freshness | Instant (write to `final_entities` directly) |
| Stitcher impact | Reads 1 extra row per stitch (existing `final_entities` row) |
| Status table scale | Standard indexed tables — 100K rows in `entity_status_active` |

The only DB load is the extra read in `performStitching`: `SELECT final_entity FROM final_entities WHERE entity_id = ?`. This is a primary key lookup — essentially free.

---

## 9. Migration Path

### Phase 1: Core Changes (RFC → PR → merge → release)
- `addExternallyManagedField` + `updateEntityField`
- Fully backward compatible (optional feature)
- No status plugin dependency

### Phase 2: Status Plugin (independent)
- Can be built while core changes are in review
- Uses `catalogDatabase.updateEntityField` once available
- Works with any Backstage instance that has Phase 1

### Phase 3: Advanced (future)
- Catalog JSON field filtering on `status.items[].level`
- Status-based catalog search
- Status history aggregation

---

## 10. Comparison: All Approaches

| Approach | Lines of Code | Core Changes | Status in Entity | Scale Safe | Freshness |
|---|---|---|---|---|---|
| **v12.0: Minimal (this)** | ~200 | ~60 lines | ✅ Yes | ✅ Yes | ⚡ Instant |
| v11.0: Read Enricher | ~500 | ~50 lines | ❌ No | ✅ Yes | ⚡ Instant |
| v3.2: Processor + Refresh | ~4000 | None | ✅ Yes | ❌ No | 🐌 150s |
| v4.0-v9.0: Provider | ~4000 | None | ❌ No | ❌ FATAL | 🐌 15s |

---

## Appendix A: Core Change Pseudocode

### A.1 `performStitching.ts` — Injection Point

```diff
     if (statusItems.length) {
       entity.status = {
         ...entity.status,
         items: [...(entity.status?.items ?? []), ...statusItems],
       };
     }
 
+    // Preserve externally-managed fields (e.g., status from status plugin)
+    if (options.externallyManagedFields?.length) {
+      const existingRow = await knex<DbFinalEntitiesRow>('final_entities')
+        .select('final_entity')
+        .where('entity_id', entityId)
+        .first();
+      
+      if (existingRow?.final_entity) {
+        const existing = JSON.parse(existingRow.final_entity) as AlphaEntity;
+        
+        if (options.externallyManagedFields.includes('status')) {
+          const externalItems = (existing.status?.items ?? [])
+            .filter(i => i.type !== ENTITY_STATUS_CATALOG_PROCESSING_TYPE);
+          const stitcherErrorItems = (entity.status?.items ?? [])
+            .filter(i => i.type === ENTITY_STATUS_CATALOG_PROCESSING_TYPE);
+          entity.status = {
+            items: [...externalItems, ...stitcherErrorItems],
+          };
+        }
+      }
+    }
+
     // If the output entity was actually not changed, just abort
     const hash = generateStableHash(entity);
```

### A.2 `CatalogBuilder.ts` — New Method

```diff
+  private externallyManagedFields: string[] = [];
+
+  /**
+   * Registers a field that is managed externally (e.g., by another plugin).
+   * The stitcher will preserve this field from the existing final_entity
+   * instead of overwriting it during stitching.
+   */
+  addExternallyManagedField(field: string): CatalogBuilder {
+    this.externallyManagedFields.push(field);
+    return this;
+  }
```

### A.3 Wiring in `CatalogBuilder.build()`

```diff
     const stitcher = DefaultStitcher.fromConfig(config, {
       knex: dbClient,
       logger,
+      externallyManagedFields: this.externallyManagedFields,
     });
```

### A.4 `DefaultStitcher.ts` — Thread Through

```diff
   constructor(options: {
     knex: Knex;
     logger: LoggerService;
     strategy: StitchingStrategy;
+    externallyManagedFields?: string[];
   }) {
+    this.externallyManagedFields = options.externallyManagedFields ?? [];
   }

   async #stitchOne(options) {
     const result = await performStitching({
       knex: this.knex,
       logger: this.logger,
       strategy: this.strategy,
       entityRef: options.entityRef,
       stitchTicket: options.stitchTicket,
+      externallyManagedFields: this.externallyManagedFields,
     });
   }
```
