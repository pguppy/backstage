---
name: backstage-catalog-system
description: "Use when working with the Backstage Software Catalog: defining entities, writing entity providers, building processors, using the catalog-client, configuring locations, understanding the ingestion pipeline, or extending the catalog with modules."
version: 2.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, catalog, entities, providers, processors, ingestion, catalog-client]
    related_skills: [backstage-plugin-blueprint, backstage-core-services, backstage-frontend-services]
---

# Backstage Catalog System

## Overview

The Software Catalog is Backstage's central data model — it tracks ownership and metadata for ALL software. 30 packages. Entities defined in YAML (`catalog-info.yaml`), ingested via processor pipeline, stored in database, rendered by frontend.

**Entity refs:** `[kind:][namespace/]name` (namespace defaults to `"default"`).

## Entity Model — 9 Kinds

| Kind | Purpose | Key spec fields |
|---|---|---|
| **Component** | Software piece | `type`, `lifecycle`, `owner`, `system` |
| **API** | Component boundary | `type`, `lifecycle`, `owner`, `definition` |
| **Resource** | Infrastructure | `type`, `lifecycle`, `owner`, `system` |
| **System** | Component+resource collection | `owner`, `domain` |
| **Domain** | System collection | `owner` |
| **Group** | Org group (team) | `type`, `parent`, `children`, `members` |
| **User** | Individual | `memberOf` |
| **Template** | Scaffolder template | `type`, `parameters`, `steps` |
| **Location** | Points to YAML files | `type` (url/file), `target` |

## Ingestion Pipeline (Processing → Stitching)

Backstage separates entity ingestion into three phases:

```
Entity Providers → Processing → Stitching → final_entity (API-visible)
                      ↑              ↑
                 Processors      Fixed process
                 run here        (cannot extend)
```

- **Processing**: Continuous loop where processors (`preProcessEntity`, `postProcessEntity`) validate, analyze, and mutate raw entities. Extensible via `catalogProcessingExtensionPoint.addProcessor()`.
- **Stitching**: Fixed process that assembles processed entity data + errors + relations into final API-visible entity. **Cannot be modified or extended.** Source code analysis of `performStitching.ts` confirms: only hardcoded enrichment (orphan annotation, error status, URL sanitization, relations, etag, uid). No hooks. No extension points. No merge strategies.

Source: `docs/features/software-catalog/life-of-an-entity.md` — "The stitching is currently a fixed process, that cannot be modified or extended."

## Architecture Decision Tree: Entity Field Enrichment

When adding data to entities, choose the right pattern based on the data's nature:

### 1. Static/Slow-Changing Enrichment → Processor

Use when data changes at entity ingestion time (adding computed fields, enriching with data from other catalog entities).

```ts
class MyProcessor implements CatalogProcessor {
  async postProcessEntity(entity, _location, _emit, _cache) {
    return { ...entity, metadata: { ...entity.metadata, annotations: { 'custom/key': 'value' } } };
  }
}
```

### 2. New Entity Ingestion → Entity Provider

Use when bringing NEW entities into the catalog from external systems (GitHub org, LDAP, Bitbucket).

```ts
catalog.addEntityProvider(new GithubOrgEntityProvider(...));
```

**CRITICAL: Entity providers CANNOT overlay onto existing entities.** Providers own their entities by `provider_id`. Two providers cannot output the same `entity_ref`. If GitHub already owns `component:default/svc`, a status provider cannot add status to it.

### 3. High-Churn Field Enrichment (Status, Cost, Metrics) → Externally-Managed Fields

**This is the primary recommended pattern** for fields that change frequently (1,667+ writes/s) and must appear in entity JSON.

Use when data changes frequently and must persist in the stored entity (filterable, searchable, exportable). Requires two small core contributions to `@backstage/plugin-catalog-backend`:

**A. `CatalogBuilder.addExternallyManagedField(fieldName)`** — tells the stitcher to preserve this field from the existing `final_entities` row instead of overwriting it. Inject after the stitcher's own enrichments in `performStitching.ts` line 213.

**B. `CatalogDatabase.updateEntityField(entityRef, fieldName, value)`** — direct write to `final_entities.final_entity` using the stitcher's own `stitch_ticket` pattern for concurrency safety. Plugin owns its field; stitcher preserves it.

```ts
// Core usage — ~60 lines of core code total:
catalogBuilder.addExternallyManagedField('status');

// Plugin writes status directly to the entity:
await catalogDatabase.updateEntityField(entityRef, 'status', { items: [...] });
// → Status appears in entity JSON. Instant. Filterable. Exportable.
```

**Why this works:** The stitcher already merges status items at `performStitching.ts` lines 208-213:
```ts
entity.status = {
  ...entity.status,                                          // preserves existing
  items: [...(entity.status?.items ?? []), ...statusItems],  // appends errors
};
```
With `addExternallyManagedField('status')`, the stitcher reads the existing `final_entities` row, extracts external status items (filtering out its own error types), and merges them with freshly-computed error items. No full processing needed for field updates.

**Alternative: Entity Read Enricher (if freshness > persistence)**
Use when data MUST be real-time and doesn't need to be stored in the entity (not filterable by catalog, not exportable). This also requires a core contribution: `CatalogBuilder.addEntityReadEnricher()`. Status injected at READ time, always fresh, zero processing. See `references/entity-field-enrichment.md`.

### ⚠️ Anti-Patterns (Confirmed by Source Code Analysis)

| Pattern | Why It Fails |
|---|---|
| Processor + refresh queue | Processor can't initiate processing. `refreshEntity()` floods catalog. |
| Entity provider overlay | Provider ownership conflict. `type: 'full'` replaces all entities from that provider. Cross-plugin extension point invalid. |
| Direct entity DB write (without stitcher coordination) | Stitcher overwrites entire `final_entity` column. External writes are clobbered unless stitcher is told to preserve the field. Use `addExternallyManagedField` to coordinate. |
| Response interceptor (monkey-patch `res.json`) | Fragile. No catalog filter support. |
| In-memory notification bus across plugin boundaries | Extension points are plugin-scoped. Cross-plugin buses require root-scoped services. |
| Custom HTTP API for event ingestion | Backstage has EventsService + HTTP ingress (`/api/events/http/:topic`). No reason to build a separate ingestion API. |
| Separate backend plugin for logic needing direct catalog access | Cross-plugin HTTP adds latency, failure surfaces, and serialization. Use a catalog backend module (`createBackendModule({ pluginId: 'catalog' })`). |
| Hardcoded event-to-status translation | Use an extension point + interface pattern (like CatalogProcessor). Pluggable translators — extensible without modifying core module. |
| Over-engineering (multi-phase, multi-package without verifying the simple path first) | Always trace the actual source code before designing. The stitcher lines 208-213 already merge status — revealed by source audit, not by assumption. If the existing code does 80% of what you need, work WITH it, not around it. |

## Entity Providers (Programmatic Ingestion)

Push NEW entities from external systems via `catalogProcessingExtensionPoint`:

```ts
env.registerInit({
  deps: { catalog: catalogProcessingExtensionPoint, scheduler: coreServices.scheduler },
  async init({ catalog, scheduler }) {
    catalog.addEntityProvider(new MyProvider());
  },
});
```

**Provider contract:** `getProviderName()`, `connect(connection)`. Mutations: `{ type: 'full', entities }` (replace all entities from this provider) or `{ type: 'delta', added, removed }` (incremental). Schedule with `scheduler.scheduleTask()`.

**Pitfall:** `type: 'full'` with a single entity REPLACES all entities previously emitted by that provider. Use `type: 'delta'` for incremental additions. Never emit the same `entity_ref` from two different providers.

## Catalog Client

### Frontend (`catalogApiRef` from `@backstage/plugin-catalog-react`)

```tsx
const catalog = useApi(catalogApiRef);
const entity = await catalog.getEntityByRef('component:default/my-service');
const { items } = await catalog.getEntities({ filter: { kind: 'Component' } });
```

### Backend (`catalogServiceRef` from `@backstage/plugin-catalog-node`)

```ts
const entity = await catalogService.getEntityByRef('component:default/my-service');
```

## Entity Status Field (Alpha)

The `status` root field on `AlphaEntity` (`@backstage/catalog-model/alpha`) is **read-only in YAML** and populated programmatically by the catalog processing pipeline.

```ts
export type EntityStatus = { items?: EntityStatusItem[] };
export type EntityStatusItem = {
  type: string; level: 'info' | 'warning' | 'error'; message: string; error?: SerializedError;
};
```

- **Multiple items per type allowed** — "Each type may appear more than once in the array"
- **Current use: ingestion errors** — The stitcher hardcodes error status items from processing errors
- **For custom status:** Requires a core contribution — `addExternallyManagedField('status')` + `CatalogDatabase.updateEntityField()` for stored-entity persistence, or `addEntityReadEnricher()` for read-time freshness. See `references/entity-field-enrichment.md` and `references/stitch-ticket-concurrency.md`.
- **`status` must be in `defaultKnownFields`** in `NoForeignRootFieldsEntityPolicy` to pass entity validation

## 4 Extension Points

| Point | Purpose |
|---|---|
| `catalogProcessingExtensionPoint` | Add processors, entity providers |
| `catalogAnalysisExtensionPoint` | Location analyzers, SCM analyzers |
| `catalogModelExtensionPoint` | Field validators, entity data parser |
| `catalogLocationsExtensionPoint` | Allowed location types |

## Configuration Reference

```yaml
catalog:
  processingInterval: { minutes: 3 }
  rules: [{ allow: [Component, API, Resource, System, Domain, Group, User, Template, Location] }]
  locations: [{ type: url, target: https://... }]
```

**`processingInterval`:** Controls how often the processing loop checks for mutated entities. Default 100-150s. Reducing to 5-10s improves entity freshness without increasing load — only mutated entities are processed. Backstage docs warn this is a suggested minimum; actual interval may be longer under load.

## Common Pitfalls

1. **Over-engineering: designing complex architectures before auditing the source.** The stitcher's status merge (lines 208-213) makes 80% of the problem trivial — discovered by reading code, not by assumption. Always trace the actual code paths before designing.
2. **Entity providers cannot overlay existing entities** — Provider ownership conflict. Two providers can't own the same entity_ref.
3. **`type: 'full'` replaces ALL entities from that provider** — Use `type: 'delta'` for incremental additions.
4. **Extension points are plugin-scoped** — A `status` extension point cannot be consumed by a `catalog` module.
5. **No field-level entity update API exists in core today** — Every mutation path is full pipeline traversal. No PATCH-style updates. Use `addExternallyManagedField` + `updateEntityField` (requires core contribution).
6. **The stitcher rewrites the entire `final_entity` column** — Direct DB writes to `final_entities` will be clobbered on next stitch unless the stitcher is told to preserve the field via `addExternallyManagedField`.
7. **`processingInterval` is a suggestion, not a guarantee** — May be longer under catalog load.
8. **Not limiting `fields` in queries** — Full entities are expensive.
9. **Hardcoding entity refs** — Use `parseEntityRef`/`stringifyEntityRef`.

## Reference Files

- `references/externally-managed-fields.md` — DEFINITIVE pattern for plugin-managed entity fields (status, cost, compliance). Source-code-verified correctness, concurrency model, anti-patterns. **Read this first when adding dynamic fields to entities.**
- `references/entity-field-enrichment.md` — Source code analysis of catalog internals, enrichment patterns, anti-patterns, read enricher proposal
- `references/catalog-pipeline.md` — Processing vs stitching pipeline details
- `references/type-import-gotchas.md` — Import paths for common catalog types
- `references/type-import-gotchas.md` — Import paths for common catalog types
