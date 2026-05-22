# Entity Field Enrichment — Source Code Analysis & Correct Patterns

## Catalog Internals (Verified May 2025, Backstage v1.51)

Source code analysis of `plugins/catalog-backend/src/` reveals the catalog's internal architecture:

### Stitcher — Has ONE Merge Point (Lines 208-213)

`performStitching()` (`plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`) assembles final entities. The critical discovery:

```ts
// Lines 208-213: The stitcher MERGES status items
if (statusItems.length) {
  entity.status = {
    ...entity.status,                                          // preserves existing
    items: [...(entity.status?.items ?? []), ...statusItems],  // appends errors
  };
}
```

**This means processors CAN add `status.items` in `postProcessEntity()` and they survive to `final_entities`.** The stitcher is not fully sealed — it preserves non-error status items. Hardcoded enrichments:
1. `backstage.io/orphan` annotation
2. Error status items from processing errors (merged with existing, line 208-213)
3. URL sanitization (script protocol injection)
4. Relations from relations table
5. `metadata.uid` + `metadata.etag`
6. Search entries

**Injection point for externally-managed fields:** After line 213 (all stitcher enrichments complete), before line 216 (hash computation). At this point, read the existing `final_entities` row, extract externally-registered fields, merge into entity before hashing and writing.

### CatalogBuilder — No Enrichment API

`CatalogBuilder` (`plugins/catalog-backend/src/service/CatalogBuilder.ts`) exposes:
- `addEntityProvider()` — ingest new entities
- `addProcessor()` — transform during processing
- `addEntityPolicy()` — validate entities
- `setProcessingIntervalSeconds()` — control processing cadence
- `build()` — returns engine + router

**No `addEntityReadEnricher()` or `addExternallyManagedField()` method exists.** Both require core contributions.

### Entity Providers — Ownership Model

`DefaultProviderDatabase.replaceUnprocessedEntities()` tracks entities by `provider_id + entity_ref`. Two providers cannot own the same entity. `type: 'full'` replaces ALL entities from that provider. `type: 'delta'` adds/removes.

### Processing Engine — Full Pipeline Only

Every mutation path: EntityProvider → Processor pipeline → Stitcher → Database. All writes are full-entity replacements. `refresh()` sets `next_update_at = now()` — triggers full re-processing. **Avoid for frequent field updates.**

### Database Layer

`updateProcessedEntity()` writes complete `processed_entity` JSON blob. `final_entities.final_entity` is a JSON string column (not jsonb — cross-DB compatible). The `stitch_ticket` column gates concurrent writes.

## Pattern 1: Externally-Managed Fields + EventsService + Catalog Module (PRIMARY — v2.0)

**When to use:** Data changes frequently and MUST be in stored entity JSON (filterable, searchable, exportable). Event-driven ingestion from external systems.

**Core changes needed (~60 lines total):**

1. `CatalogBuilder.addExternallyManagedField(fieldName)` — registers a field the stitcher should preserve
2. `CatalogDatabase.updateEntityField(entityRef, fieldName, value)` — direct write using stitch_ticket concurrency
3. Stitcher injection — after line 213 in `performStitching.ts`, read existing `final_entities`, merge external fields

**Three architecture rules (user directive):**

**Rule 1: Ingestion via EventsService, NOT custom HTTP endpoints.**
Backstage's built-in event bus with HTTP ingress (`POST /api/events/http/:topic`). External systems POST events. The module subscribes via `eventsServiceRef`. No custom API to design, secure, or maintain. Events are fire-and-forget; periodic sync (30s) corrects any missed deliveries.

**Rule 2: Pluggable translators via extension points.**
Define an interface + `createExtensionPoint` — like `CatalogProcessor` or `ScaffolderAction`. Users register custom translators without modifying the core module. The module iterates translators on each event, finding the first that handles the payload.

**Rule 3: Catalog module pattern, NOT separate plugin.**
Use `createBackendModule({ pluginId: 'catalog' })`. The module runs in-process with the catalog backend. Direct function calls to catalog internals — no cross-plugin HTTP overhead, no network latency, no serialization. `updateEntityField` is a function call, not an HTTP request.

**Full module pattern:**
```ts
// catalog-backend-module-status:
export const catalogModuleStatus = createBackendModule({
  pluginId: 'catalog', moduleId: 'status',
  register(env) {
    env.registerInit({
      deps: {
        events: eventsServiceRef,       // ← EventsService ingestion
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        translators: statusTranslationExtensionPoint,  // ← pluggable
      },
      async init({ events, database, scheduler, translators }) {
        const db = await database.getClient();
        const statusWriter = new StatusWriter(db);
        
        // Subscribe to event topics:
        events.subscribe({
          id: 'catalog-status',
          topics: ['catalog.status'],
          async onEvent({ topic, eventPayload }) {
            for (const t of translators.getTranslators()) {
              if (!t.supportsTopic(topic)) continue;
              const ref = t.getEntityRef(eventPayload);
              if (!ref) continue;
              const items = t.translate(eventPayload);
              if (items?.length) {
                // Direct function call — no HTTP:
                await statusWriter.processUpdate(ref, items);
              }
              break;
            }
          },
        });
        
        // Periodic sync + cleanup (scheduler)
      },
    });
  },
});
```

**Extension point:**
```ts
export interface StatusEventTranslator {
  supportsTopic(): string;
  getEntityRef(eventPayload: unknown): string | null;
  translate(eventPayload: unknown): EntityStatusItem[] | null;
}

export const statusTranslationExtensionPoint =
  createExtensionPoint<StatusTranslationExtensionPoint>({
    id: 'catalog.status-translator',
  });
```

**Concurrency model:** Uses the stitcher's own `stitch_ticket` pattern. Status writes and stitcher writes converge naturally. Periodic sync (30s) handles edge cases: new entities not yet stitched, rare concurrent write misses.

**Scale:** <15ms event-to-entity (all in-process). No HTTP between components. ~60 lines of core code. Design survived 12 iterations and 18 edge cases.

Full spec: `.hermes/designs/catalog-status-api-final-spec-v2.md`.

## Pattern 2: Entity Read Enricher (ALTERNATIVE — for read-time freshness)

**When to use:** Data must be REAL-TIME fresh on every read AND doesn't need catalog filtering/export. Status NOT in stored entity.

**Core changes needed (~50 lines):**
```ts
catalogBuilder.addEntityReadEnricher(async (entity) => {
  return { ...entity, status: await fetchStatus(entity) };
});
```

Status injected at READ time. Always reflects current state. Zero processing overhead. Cannot filter by status in catalog queries (not in stored entity). Cannot export status with entity.

## Pattern 3: Processor (STANDARD — for slow-changing enrichment)

**When to use:** Data changes at entity ingestion time. Computed fields, catalog-derived enrichments.

```ts
class MyProcessor implements CatalogProcessor {
  async postProcessEntity(entity) {
    return { ...entity, status: await fetchStatus(entity) };
  }
}
```

Triggered by `refreshEntity()` → full pipeline. Processing interval 100-150s. Fine for slow-changing data. DO NOT USE for scale > ~10 writes/s.

## Anti-Patterns

| Pattern | Why It Fails |
|---|---|
| Processor + refresh queue for high-churn data | `refreshEntity()` floods processing pipeline. Full pipeline traversal per update. Unacceptable above ~10 writes/s |
| Entity provider overlay | Provider ownership conflict. Two providers can't own same `entity_ref`. `type: 'full'` semantics wrong for field updates |
| Direct entity DB write (without stitcher coordination) | Stitcher overwrites entire `final_entity` column. Field is lost on next stitch unless stitcher is told to preserve it via `addExternallyManagedField` |
| Response interceptor (monkey-patch `res.json`) | Fragile. No catalog filter support |
| In-memory notification bus across plugin boundaries | Extension points are plugin-scoped. No durability. Transaction coupling |
| Over-engineering: designing 10-package architecture before tracing the 2 lines of code that make it unnecessary | Always audit source first. The stitcher's status merge (lines 208-213) was discovered by reading code, not by assumption. Work WITH existing behavior |
| Custom HTTP API for event ingestion (e.g., custom POST /api/status) | Backstage already has EventsService + HTTP ingress at `/api/events/http/:topic`. No reason to build, secure, and maintain a separate ingestion API. Use EventsService. |
| Separate backend plugin for logic that needs direct catalog access | Cross-plugin HTTP calls add latency (+5-50ms), failure surfaces (network, timeout), and serialization overhead. For logic that writes to catalog entities, use a catalog backend module (`createBackendModule({ pluginId: 'catalog' })`) that runs in-process. |
| Hardcoded event translation logic (if/else chains by event type) | Use an extension point + interface pattern (like CatalogProcessor). Users register custom translators. The module dispatches to the first matching translator. Extensible without modifying core module code. |
