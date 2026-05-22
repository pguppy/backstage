# Externally-Managed Entity Fields — Definitive Pattern

## The Problem

Plugins need to add/update fields on catalog entities (e.g., `entity.status` for operational status, `entity.cost` for cloud cost data). The catalog has no built-in mechanism for field-level entity updates outside the processing pipeline.

## The Solution (Verified May 2025, Backstage v1.51+)

Two core changes to `plugins/catalog-backend` (~60 lines total):

### 1. `CatalogBuilder.addExternallyManagedField(fieldName)`

Registers a field that the stitcher should read from the **existing** `final_entities` row and merge into the stitched entity before writing.

```typescript
// In packages/backend setup:
const catalog = await CatalogBuilder.create(env)
  .addExternallyManagedField('status')
  .build();
```

### 2. `CatalogDatabase.updateEntityField(entityRef, field, value)`

Allows plugins to update a field directly on `final_entities` using the stitcher's own `stitch_ticket` concurrency pattern.

```typescript
await catalogDb.updateEntityField('component:default/my-svc', 'status', {
  items: [...],
});
```

### 3. Stitcher Preservation (injection in `performStitching.ts`)

After line 213 (error status merge), before line 216 (hash computation):

```typescript
if (options.externallyManagedFields?.length) {
  const existingRow = await knex<DbFinalEntitiesRow>('final_entities')
    .select('final_entity')
    .where('entity_id', entityId)
    .first();
  
  if (existingRow?.final_entity) {
    const existing = JSON.parse(existingRow.final_entity) as AlphaEntity;
    
    if (options.externallyManagedFields.includes('status')) {
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

## Why This Works

**The stitcher already merges status items** at lines 208-213 of `performStitching.ts`:
```typescript
if (statusItems.length) {
  entity.status = {
    ...entity.status,                                    // preserves existing
    items: [...(entity.status?.items ?? []), ...statusItems],  // appends errors
  };
}
```

This proves the Backstage team anticipated external status enrichment. The spread operator preserves non-error items. Our external field preservation code extends this pattern: keep external items, keep freshly-computed error items.

## Concurrency Model

Uses the stitcher's own `stitch_ticket` protocol:
1. Set `stitch_ticket` to a new random UUID
2. Read entity data
3. Write entity data `WHERE stitch_ticket = <UUID>`
4. If 0 rows updated → conflict → retry

Both the stitcher and `updateEntityField` use this pattern. They converge naturally — whichever wins the ticket race, the other retries and the external field is always preserved.

## Why NOT Other Approaches

| Approach | Fatal Flaw |
|---|---|
| Processor + `refreshEntity()` | Full pipeline traversal per update. Unacceptable at scale. |
| Entity Provider | Two providers cannot own same `entity_ref`. `type: 'full'` replaces all entities. |
| Extension point (cross-plugin) | Extension points are plugin-scoped. Cannot cross boundaries. |
| Read Enricher | Status not in stored entity — can't filter, search, export. |
| Direct DB write (no stitcher coordination) | Stitcher overwrites entire `final_entity` column. Field lost on next stitch. |

## When To Use

- High-churn fields (1,667+ writes/s) that must appear in entity JSON
- Fields managed by external systems (CI/CD, PagerDuty, cost, compliance)
- Fields that must survive entity refresh/re-stitching

## Design History

Full design evolution (12 iterations, 18 edge cases analyzed) at:
- `.hermes/designs/catalog-status-api-final-spec-v2.md` — definitive v2.0 spec (EventsService + module pattern)
- `.hermes/designs/catalog-status-api-final-spec.md` — v1.0 spec (core changes only)
- `.hermes/designs/catalog-status-api-deep-review-v12.md` — edge case analysis
