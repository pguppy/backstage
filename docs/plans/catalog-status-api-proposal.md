# Proposal: Out-of-Band Entity Status API for the Catalog

## Summary

A mechanism for external systems to write live status information to catalog
entities without modifying entity YAML. Status data is stored in a dedicated
database table and merged into `entity.status` during the stitching pipeline,
making it available to all catalog consumers.

## Motivation

The Backstage catalog currently has two ways to surface information about an
entity:

1. **Entity definition** — the YAML descriptor in source control. This is the
   source of truth for static metadata (owner, lifecycle, type, etc.) but
   cannot reflect real-time state.

2. **`entity.status.items`** — processing errors populated by the catalog
   ingestion pipeline during stitching. This is write-only by the catalog
   itself and not extensible by plugins.

There is no standard way for external systems to report live status to the
catalog. Common use cases that are difficult or impossible today:

- **CI/CD pipelines** reporting build/deploy status on a component
- **Monitoring systems** writing health check results to a service
- **Security scanners** surfacing vulnerability scan outcomes
- **Cloud providers** reporting resource provisioning state
- **Custom plugins** that compute and display operational metadata

Organizations work around this gap in ad-hoc ways: maintaining shadow
databases, decorating entities via processors that call external APIs on every
refresh, or building sidecar services. All of these have drawbacks in
consistency, freshness, and operational complexity.

## Design Goals

1. **Out-of-band writes** — external systems update status without touching
   entity YAML or requiring a catalog refresh cycle
2. **First-class in the catalog** — status is visible through standard catalog
   APIs and surfaces in the catalog UI
3. **Multi-source** — multiple independent systems can write to the same
   entity under different source names without conflict
4. **Stitching integration** — status is merged during the existing stitch
   cycle, keeping the eventual-consistency model the catalog already uses
5. **Extensible** — plugins can register custom merging logic via the
   extension point system
6. **In-process friendly** — backend modules can write status via service ref
   without HTTP overhead, enabling event-driven integrations

## Architecture

### Data Model

A new `entity_status` table stores status data keyed by entity reference and
source name:

| Column       | Type     | Description                            |
| ------------ | -------- | -------------------------------------- |
| `entity_ref` | string   | Lowercase entity reference (PK part 1) |
| `source`     | string   | Source identifier (PK part 2)          |
| `status`     | text     | JSON status payload                    |
| `updated_at` | datetime | Last update timestamp                  |

The composite primary key on `(entity_ref, source)` means each source writes
to its own slot for each entity — no cross-source conflicts.

### Write Path

External systems write status through two mechanisms:

**HTTP API** — for out-of-process integrations:

```
POST /api/catalog/entities/by-name/{kind}/{namespace}/{name}/status
  ?source=my-ci-pipeline
  Body: { "build": "succeeded", "commit": "abc123" }

POST /api/catalog/entities/status-batch
  Body: [
    { "entityRef": "component:default/my-service", "source": "monitoring", "status": {...} },
    ...
  ]
```

**In-process service ref** — for backend modules running in the same process:

```ts
// In a backend module
export const myStatusModule = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'my-status',
  deps: { catalogStatus: catalogStatusServiceRef },
  async init({ catalogStatus }) {
    await catalogStatus.setEntityStatus(
      'component:default/my-service',
      'my-plugin',
      { health: 'ok', lastCheck: new Date().toISOString() },
    );
  },
});
```

Both paths validate the source name and status payload, persist to
`entity_status`, and trigger a stitch of the affected entity (unless
`?stitch=skip` is specified for batch scenarios).

### Read Path

Status is surfaced through two mechanisms:

1. **`GET /entities/by-name/.../status`** — strongly consistent. Reads
   directly from `entity_status`. Use this when you need real-time status.

2. **`entity.status` on stitched entities** — eventually consistent. Status is
   merged during the stitch cycle and available through the standard entity
   API. Use this for UI rendering and general consumption.

### Stitching Pipeline

Status merging integrates into the existing stitch cycle:

```
Stitch batch begins
  └─ preFetch: batch-load all statuses for entities in this batch
  └─ Relations are assembled
  └─ Custom mergers run (via CatalogStitchingExtensionPoint)
  └─ Built-in merger runs: spreads status sources into entity.status
  └─ Orphaned status rows are cleaned up
Stitch batch completes
```

The built-in merger spreads each source as a top-level key under
`entity.status`:

```json
{
  "status": {
    "items": [...],
    "monitoring": { "health": "ok", "uptime": "99.9%" },
    "cicd": { "lastBuild": "succeeded", "commit": "abc123" }
  }
}
```

### Extension Point

Plugins can register custom `StitchingStatusMerger` implementations to
transform or enrich status data before it is written to the entity:

```ts
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

Mergers are registered via the `catalogStitchingExtensionPoint`:

```ts
const myModule = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'my-merger',
  deps: { stitching: catalogStitchingExtensionPoint },
  async init({ stitching }) {
    stitching.addStitchingStatusMerger({
      async merge({ entity, entityRef, query }) {
        const statuses = await query.getStatuses([entityRef]);
        // Custom merge logic...
      },
    });
  },
});
```

### Permissions

A new permission governs write access:

- **`catalog.entity.status.update`** — required for POST and DELETE on status
  endpoints. Uses resource-type authorization scoped to the target entity.

Read access uses the existing `catalog.entity.read` permission.

### Validation & Security

- **Source names**: max 128 characters, alphanumeric plus dots, dashes, and
  underscores. Reserved names (`items`) are rejected to avoid collisions with
  catalog-internal status fields.
- **Status payload**: max 64KB serialized. Reserved top-level keys are
  rejected.
- **XSS sanitization**: `javascript:` and `vbscript:` URL values in status
  payloads are replaced with a safe placeholder.
- **Readonly mode**: status write endpoints respect the catalog readonly flag.

### Lifecycle Management

- **Orphan cleanup**: during deferred stitch cycles, status rows whose entity
  no longer exists in `refresh_state` are deleted in batches.
- **Entity deletion**: when an entity is marked orphaned during stitch, all
  its status rows are deleted.
- **Migration**: two database migrations — one to create the table, one to add
  an index on `entity_ref` for batch lookup performance.

## Packages Affected

| Package                             | Change                                                           | Semver |
| ----------------------------------- | ---------------------------------------------------------------- | ------ |
| `@backstage/plugin-catalog-backend` | Status store, router endpoints, stitcher integration, migrations | minor  |
| `@backstage/plugin-catalog-node`    | Extension point, service ref, merger interface                   | patch  |
| `@backstage/catalog-client`         | `setEntityStatus`, `deleteEntityStatus` on CatalogApi            | patch  |
| `@backstage/plugin-catalog-common`  | `catalogEntityStatusWritePermission`                             | patch  |
| `@backstage/plugin-catalog-react`   | Mock updates                                                     | patch  |

## Alternatives Considered

### Status via entity annotation

Write status as an annotation on the entity (e.g.
`backstage.io/status-monitoring`). This would require modifying entity YAML or
the final entity table, breaking the immutability of entity definitions. It
also creates conflicts if multiple sources write to overlapping keys.

### Status via processor

A `CatalogProcessor` that fetches external status on every refresh. This ties
status freshness to the refresh interval, adds latency to the processing
pipeline, and makes external API calls a blocking part of entity ingestion.

### Separate status microservice

A standalone service that stores and serves status, separate from the catalog.
This fragments the data model, requires consumers to query two systems, and
duplicates entity resolution logic. It also cannot participate in the stitching
pipeline.

### EventBridge-only approach

Require all status writes to go through an event bridge (e.g. AWS EventBridge,
Cloudevents). This works for large-scale async integrations but excludes
simpler in-process use cases and adds infrastructure dependencies that many
Backstage adopters do not have.

## Open Questions

1. **UI presentation** — Should the catalog entity page display status sources
   automatically, or should each plugin that writes status also provide its own
   card? The current design leaves this to individual plugins.

2. **Status history** — The current design stores only the latest status per
   source. Should we support historical status records for trend analysis?

3. **Rate limiting** — Should the status write endpoints enforce rate limits
   per source to prevent a misbehaving integration from overwhelming the
   stitcher?

4. **Status TTL** — Should status entries support an optional TTL, after which
   they are automatically cleaned up? This would handle cases where a status
   source stops updating without explicitly deleting its entries.

## Implementation Status

A working implementation exists across 29 modified and 16 new files
(~1500 lines). It includes the full database layer, REST API, stitching
integration, extension point, permissions, validation, and integration tests.
The implementation is ready for review as a draft PR.
