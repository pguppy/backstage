# Catalog Status API — Source Code Analysis

## Finding: No Supported Field-Level Entity Update Exists

Analysis of `plugins/catalog-backend/src/` confirms there is no mechanism to update a single field on an existing entity without going through the full processing pipeline. Every path requires: EntityProvider → Processor pipeline → Stitcher → Database. All writes are full-entity replacements.

### CatalogBuilder Public API (CatalogBuilder.ts)

| Method | Purpose |
|---|---|
| `addEntityProvider(...)` | Register entity ingestion sources |
| `addProcessor(...)` | Register entity transformation processors |
| `addEntityPolicy(...)` | Register validation policies |
| `setProcessingIntervalSeconds(...)` | Control processing cadence |
| `build()` | Wire everything, return engine + router |
| **`addEntityReadEnricher(...)`** | **DOES NOT EXIST** |

No method for entity enrichment at read time. No method for field-level updates. No overlay or merge API.

### How the Stitcher Works (performStitching.ts)

```ts
// Lines 169-246 — the stitcher reads processed_entity, enriches with:
// 1. backstage.io/orphan annotation
// 2. Error status items from processing errors
// 3. URL sanitization (script protocol injection)
// 4. Relations from relations table
// 5. metadata.uid and metadata.etag
// 6. Search entries
// 7. Writes to final_entities table
// NO hooks. NO extension points. NO merge strategies.
```

### How Entity Providers Work (connectEntityProviders.ts)

```ts
// applyMutation({ type: 'full', entities }) →
//   replaceUnprocessedEntities() → replaces ALL entities for this provider
//   Two providers CANNOT output the same entity_ref
//   Entity ownership is tracked by provider_id
```

### The Processing Engine (DefaultCatalogProcessingEngine.ts)

```ts
// Loop: poll processable → orchestrate (policies → processors) →
//   compute hash → if changed: updateProcessedEntity (full JSON) →
//   trigger stitching
// No field-level update path. All writes are full entity replacements.
```

### How Refresh Works (DefaultCatalogDatabase.ts)

```ts
// refresh(tx, { entityRef }):
//   UPDATE refresh_state SET next_update_at = NOW() WHERE entity_ref = ?
// This marks the entity for re-processing. The ENTIRE pipeline runs.
// At 100 status changes/s, this would be 100 full entity re-processings/s.
```

### The Status Field in Existing Entities

```ts
// performStitching.ts lines 180-189:
// The stitcher reads processing errors and adds them as status items:
// entity.status = { items: [{ type: 'backstage.io/catalog-processing',
//   level: 'error', message: '...' }] }
//
// This is the ONLY status population mechanism. It's hardcoded for
// catalog processing errors only. No way to add custom status items.
```

---

## Revised Design Direction

The source code analysis confirms: getting status into catalog entity JSON at scale requires a Backstage core contribution. Two options:

### Option A: Entity Read Enricher (Recommended)

Add `addEntityReadEnricher()` to `CatalogBuilder`. Enricher runs at entity read time, queries `entity_status_active`, merges status into response. Always fresh, zero processing. ~50-line core change.

```ts
// Proposed addition to CatalogBuilder:
addEntityReadEnricher(enricher: (entity: Entity) => Promise<Entity>): this;
```

### Option B: Stitcher Field Hook

Add `addStitcherFieldProvider()` to `CatalogBuilder`. Stitcher queries external data during assembly. Status populated at stitch time. ~30-line core change, but adds latency to every stitch.

### Fallback (until core contribution lands)

Status API as source of truth. Entity page fetches in parallel via TanStack Query. Status search API for filtering. Catalog not involved in status at all.
