# Catalog Status API — Full Architecture

## Overview

Out-of-band entity status system allowing external sources to write status data to catalog entities. Status data is persisted in a dedicated `entity_status` DB table and merged into `entity.status` during stitching.

## Packages Changed (22 files, +869/-22 lines)

### Database Layer

- **New table `entity_status`**: columns `entity_ref`, `source`, `status` (JSON text), `updated_at`. PK on `(entity_ref, source)`.
- **Migration `20260503000000_entity_status.js`**: creates the table
- **Migration `20260506000000_entity_status_index.js`**: adds index on `entity_ref` (non-SQLite)
- **`DefaultCatalogStatusStore`** (`database/DefaultCatalogStatusStore.ts`): Knex-based store with `setStatus` (upsert), `deleteStatus`, `getStatuses` (batch), `listSources`, `deleteAllForEntity`, `cleanOrphanedStatuses`

### REST API (createRouter.ts)

Three new endpoints on `/entities/by-name/:kind/:namespace/:name/status`:

- **GET**: List status sources for an entity (requires `catalogEntityReadPermission`)
- **POST**: Set status from a source (requires `catalogEntityStatusWritePermission`, validates source/status, triggers stitch unless `?stitch=deferred`)
- **DELETE**: Remove status from a source (requires `catalogEntityStatusWritePermission`, requires `?source=` query param, triggers stitch unless deferred)

All endpoints: entity existence check, permission authorization, auditor events, readonly mode check.

### Stitching Pipeline (DefaultStitcher.ts + performStitching.ts)

- `DefaultStitcher` now accepts `stitchingStatusMergers[]` and `statusStore`
- **Pre-fetch**: Before each stitch batch, calls `preFetchStatus()` to batch-load statuses and give mergers a `preFetch` hook
- **Merger invocation**: In `performStitching()`, after relations are assembled, all `StitchingStatusMerger.merge()` are called with a cached `EntityStatusQuery`
- **Orphan cleanup**: During deferred stitching cycles, `cleanOrphanedStatuses()` removes rows for entities no longer in `refresh_state`
- **Orphan entity cleanup**: When an entity is marked orphaned during stitch, its status rows are deleted
- **XSS sanitization**: `sanitizeStatus()` strips `javascript:` and `vbscript:` protocol values from status strings

### Validation (util/status.ts)

- `validateSource()`: max 128 chars, alphanumeric/dots/dashes/underscores only, rejects reserved names (`items`)
- `validateStatusPayload()`: rejects reserved top-level keys, max 64KB serialized
- `sanitizeStatus()`: recursive sanitization of `javascript:`/`vbscript:` URL values
- `scriptProtocolPattern` / `vbscriptProtocolPattern` exported from React's sanitize URL pattern

### Extension Points (catalog-node)

- **`StitchingStatusMerger`** interface: `init?({stitcher})`, `preFetch?({entityRefs, query})`, `merge({entity, entityRef, query})`
- **`EntityStatusQuery`** interface: `getStatuses(entityRefs)` → Map
- **`CatalogStitchingExtensionPoint`** interface: `addStitchingStatusMerger(merger)`
- **`catalogStitchingExtensionPoint`**: registered in `CatalogPlugin`
- **`CatalogStitcherService`** interface + `catalogStitcherServiceRef`: service ref for DI
- **`catalogStitcherServiceFactory`**: placeholder factory in catalog-backend, overridden by the plugin

### Permissions (catalog-common)

- **`catalogEntityStatusWritePermission`** (`catalog.entity.status.update`): resource-type permission for status write/delete operations
- Exported from `alpha.ts` and added to `catalogPermissions`

### Built-in Merger (CatalogBuilder.ts)

- `BuiltinStatusMerger`: reads statuses from `EntityStatusQuery`, spreads them into `entity.status`
- Registered last so custom mergers run first, but built-in takes precedence on conflicting keys

### Plugin Wiring (CatalogPlugin.ts)

- `CatalogStitchingExtensionPointImpl`: collects mergers, initializes them with stitcher reference after build
- Mergers registered via extension point are wired into `CatalogBuilder`
- `build()` now returns `stitcher` alongside `processingEngine` and `router`

### OpenAPI Spec (openapi.yaml)

- Full spec for GET/POST/DELETE on `/entities/by-name/{kind}/{namespace}/{name}/status`
- Generated server/client/router code updated accordingly

### Tests

- `performStitching.test.ts`: all stitch tests pass `statusStore` mock
- `status-integration.test.ts`: full E2E test — push status via POST, verify reflected in GET entity
- `DefaultRefreshService.test.ts`, `createRouter.test.ts`, `DefaultStitcher.test.ts`, `integration.test.ts`: minor import/test adjustments

## Key Design Decisions

1. Status is out-of-band: external systems write to a separate table, not directly to entity YAML
2. Merged during stitching: status becomes visible only after stitch cycle processes it
3. Pre-fetch optimization: batch status loading avoids N+1 queries during bulk stitching
4. Source validation prevents collision with reserved `entity.status` keys (e.g., `items` from relations)
5. Orphan cleanup prevents stale status rows from accumulating
6. Stitcher service ref enables external plugins to trigger stitching on demand
