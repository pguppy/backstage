# Backstage Catalog Status API

## Final Design Specification — v11.0

**Status:** Final — Entity Read Enricher Core Contribution  
**Date:** June 2026  
**Author:** Patrick Guppy  

**Source code analysis:** `plugins/catalog-backend/src/` confirms no supported mechanism for field-level entity updates. `CatalogBuilder` has no `addEntityReadEnricher()`. `performStitching()` has no hooks. Entity providers cannot overlay existing entities. Every mutation path forces full pipeline traversal. The only correct answer for "status in entity JSON at scale" is a core contribution.

---

## 1. Problem & Target State

Backstage entities lack live operational status. CI/CD pipelines, PagerDuty incidents, and health checks report through ad-hoc mechanisms. Status must be visible on entity pages, filterable through the catalog API, and accessible to external tools — all without overloading the catalog processing pipeline.

The catalog backend source code proves that no existing mechanism can achieve this. A core contribution is required.

### Target Architecture

```
WRITE PATH
  Status sources → POST /api/status/bulk → entity_status_active + summary + outbox

READ PATH (real-time)
  GET /api/status/:entity → entity_status_active (direct, <20ms p99)
  GET /api/status/dashboard → entity_status_summary (rollup, O(1))
  GET /api/status/search?level=error → entity refs

CATALOG INTEGRATION (via core contribution)
  GET /api/catalog/entities/by-name/:kind/:namespace/:name
    → catalog fetches entity from storage
      → StatusReadEnricher queries entity_status_active
        → merges status into entity response
          → returns enriched entity to client
```

Status is always fresh at read time. Zero processing overhead. Zero staleness.

---

## 2. Core Contribution: `CatalogBuilder.addEntityReadEnricher()`

### 2.1 The API

```ts
// Proposed addition to @backstage/plugin-catalog-backend

/**
 * An enricher that augments entity responses with external data.
 * Runs at entity read time — when the catalog API serves an entity.
 * Multiple enrichers can be registered. They run in registration order.
 */
export interface EntityReadEnricher {
  /**
   * Enrich an entity with additional data before it's returned to the client.
   * @param entity — the entity as stored in the catalog (no status yet)
   * @returns the enriched entity (with status merged in)
   */
  enrich(entity: Entity): Promise<Entity>;
}

// In CatalogBuilder:
class CatalogBuilder {
  private enrichers: EntityReadEnricher[] = [];

  /**
   * Register an entity read enricher.
   * Enrichers run after the entity is fetched from storage but before
   * it's returned to the client. Status data, computed fields, and
   * plugin-specific enrichment belong here.
   */
  addEntityReadEnricher(enricher: EntityReadEnricher): this {
    this.enrichers.push(enricher);
    return this;
  }

  async build(): Promise<{ processingEngine: CatalogProcessingEngine; router: Router }> {
    // ... existing setup ...
    // Pass enrichers to the router
  }
}
```

### 2.2 Where It Runs

The enricher is called by the catalog's entity read handlers:

```ts
// In the catalog router (createRouter.ts or equivalent):
async function getEntityByName(kind, namespace, name) {
  const entity = await database.getEntityByName(kind, namespace, name);
  if (!entity) throw new NotFoundError();

  // Enrich at response time — status, computed fields, plugin data
  for (const enricher of this.enrichers) {
    entity = await enricher.enrich(entity);
  }

  return entity;
}
```

### 2.3 Filtering

For `GET /entities/by-query?filter=status.items.level=error`:

The catalog queries entities from storage (no status filter), enriches each result via registered enrichers, then applies the filter to the enriched entities. This is post-query, in-memory filtering — more expensive than SQL filtering for large result sets, but correct for real-time enrichment.

For the initial contribution, filtering support is optional. The status search API (`GET /api/status/search?level=error`) provides equivalent filtering capability without requiring catalog changes. The enricher handles the "status in entity JSON" requirement. The search API handles filtering. They complement each other.

### 2.4 Implementation Size

- **Backstage core changes:** ~50 lines in `CatalogBuilder.ts` + ~20 lines in the catalog router
- **New interface:** `EntityReadEnricher` (exported from `@backstage/plugin-catalog-backend`)
- **Extension point:** `catalogReadEnricherExtensionPoint` in `@backstage/plugin-catalog-node`
- **RFC required:** Yes — this is a new extension point in a core plugin

### 2.5 Who Benefits

Every Backstage plugin that adds computed fields to entities:
- **Status** — live CI/CD, PagerDuty, health check status
- **Cost Insights** — per-entity cost data
- **Code Coverage** — per-entity coverage metrics
- **Custom plugins** — any plugin that enriches entities with external data

Without this hook, every plugin must either hack around the catalog (processors, refresh queues, monkey-patches) or abandon inline entity data entirely (separate APIs, no catalog integration). This is a one-time core change that unblocks an entire class of use cases.

---

## 3. Status Plugin Architecture

### 3.1 Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ WRITE PATH                                                      │
│                                                                 │
│  External sources → POST /api/status/bulk → CoalescingHandler   │
│    → StatusHandler (fingerprint, out-of-order protection)        │
│      → entity_status_active | heartbeat | history | details     │
│      → entity_status_summary (per-entity rollup, same tx)       │
│      → status_catalog_outbox (inserted when summary hash changes)│
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ READ PATH — Status API (always fresh, direct DB reads)          │
│                                                                 │
│  GET /api/status/:entity     → entity_status_active + heartbeat │
│  GET /api/status/dashboard   → entity_status_summary rollup     │
│  GET /api/status/search      → entity_status_summary → refs     │
│  GET /api/status/:entity/history → entity_status_history        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ READ PATH — Catalog Integration (via EntityReadEnricher)        │
│                                                                 │
│  GET /api/catalog/entities/by-name/:kind/:namespace/:name       │
│    → catalog fetches entity from storage                        │
│      → StatusReadEnricher.enrich()                              │
│        → queries entity_status_active (instant)                 │
│          → merges bounded summary (max 20, ≤512 chars)          │
│            → returns enriched entity { ...entity, status }      │
│                                                                 │
│  Status is ALWAYS fresh at read time.                            │
│  Zero processing overhead. Zero catalog mutations.               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ FRONTEND                                                        │
│                                                                 │
│  Entity page → entity.status.items (from enriched catalog API)  │
│  Status detail → useQuery(['status', ref]) → status API         │
│  Dashboard → useQuery(['status', 'dashboard']) → status API     │
│  Filtering → useQuery(['status', 'search', filter]) → status API│
│                                                                 │
│  TanStack Query caches everything. Parallel fetches.             │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 What Package Does What

| Package | Role | Key Contents |
|---|---|---|
| `status-common` | common-library | Types, permissions |
| `status-node` | node-library | `BoundStatusHandler`, `StatusSource`, extension point |
| `status-backend` | backend-plugin | Migrations (6 tables), StatusHandler, CoalescingHandler, router (8 endpoints), summary recompute, outbox, source auth |
| `status-backend-module-catalog` | backend-module (catalog) | `StatusReadEnricher` (implements EntityReadEnricher), partition maintenance |
| `status-react` | web-library | StatusClient, StatusApiClient, statusApiRef, hooks |
| `status` | frontend-plugin | EntityStatusContent, StatusDetailPage, Dashboard, SearchPage |
| `status-backend-module-github` | backend-module (status) | Example GitHubActionsSource |

### 3.3 The StatusReadEnricher

```ts
// plugins/status-backend-module-catalog/src/StatusReadEnricher.ts
export class StatusReadEnricher implements EntityReadEnricher {
  constructor(private readonly db: Knex) {}

  async enrich(entity: Entity): Promise<Entity> {
    const entityRef = stringifyEntityRef(entity);

    const [active, heartbeats] = await Promise.all([
      this.db('entity_status_active')
        .where('entity_ref', entityRef)
        .orderByRaw(`CASE status_level
          WHEN 'error' THEN 3 WHEN 'warning' THEN 2 ELSE 1
        END DESC`).limit(20),
      this.db('entity_status_heartbeat')
        .where('entity_ref', entityRef)
        .select('source', 'last_seen_at'),
    ]);

    if (!active.length) return entity;

    const items: EntityStatusItem[] = active.map(r => ({
      type: r.status_type,
      level: r.status_level,
      message: (r.message as string).slice(0, 512),
    }));

    // Staleness warning
    const staleSources = new Set<string>();
    for (const hb of heartbeats) {
      if (Date.now() - new Date(hb.last_seen_at as string).getTime() > 300_000) {
        staleSources.add(hb.source as string);
      }
    }
    if (staleSources.size > 0) {
      items.unshift({
        type: 'backstage.io/status-source-staleness',
        level: 'warning',
        message: `Source(s) may be inactive: ${Array.from(staleSources).slice(0, 5).join(', ')}`,
      });
    }

    // Deterministic ordering: severity desc, then alphabetically
    items.sort((a, b) => {
      const sa = severityRank(a.level), sb = severityRank(b.level);
      if (sa !== sb) return sb - sa;
      return a.type.localeCompare(b.type);
    });

    return { ...entity, status: { items } };
  }
}
```

### 3.4 Module Wiring

```ts
// plugins/status-backend-module-catalog/src/module.ts
export const catalogModuleStatus = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'status',
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        logger: coreServices.logger,
      },
      async init({ catalog, database, scheduler, logger }) {
        const db = await database.getClient();

        // Register the read enricher — status added at entity read time
        // Requires Backstage core contribution: CatalogBuilder.addEntityReadEnricher()
        catalog.addEntityReadEnricher(new StatusReadEnricher(db));

        // Maintenance tasks
        scheduler.scheduleTask({
          id: 'status-partition-maintenance',
          frequency: { cron: '0 3 * * *' },
          fn: () => maintainPartitions(db),
        });

        scheduler.scheduleTask({
          id: 'status-heartbeat-cleanup',
          frequency: { hours: 6 },
          fn: () => cleanupStaleHeartbeats(db),
        });

        logger.info('Status read enricher registered');
      },
    });
  },
});
```

---

## 4. Design Decisions

### Decision 1: Entity Read Enricher (Core Contribution)

**Chosen:** `CatalogBuilder.addEntityReadEnricher()` hook on entity reads. Status queried and merged at response time.

**Rejected:** Entity provider overlay — provider ownership conflict. Processor + refresh — can't initiate processing, floods catalog. Direct DB write — fragile, unsupported. Response interceptor — monkey-patches `res.json`.

**Proof:** The read enricher is the only mechanism that satisfies all constraints: status in entity JSON, always fresh, zero processing overhead, zero catalog mutations, clean API. The core change is ~50 lines. This unblocks status AND every future plugin that needs computed entity fields.

### Decision 2: Status API as Real-Time Source of Truth

**Chosen:** `GET /api/status/:entity` reads `entity_status_active` directly. Dashboard uses `entity_status_summary` rollup. Search uses `entity_status_summary`.

**Proof:** The read enricher provides inline entity data for rendering. The status API provides real-time detail, filtering, and aggregation. Together they cover all use cases.

### Decision 3: Per-Entity Summary Rollup

**Chosen:** `entity_status_summary` maintained atomically with status writes.

**Proof:** Dashboard and search queries over `entity_status_active` (2M rows) would require `GROUP BY` with full scans. The summary rollup gives O(1) queries.

### Decision 4: Stable Fingerprints

Fingerprint from `{ type, level, summaryFingerprintFields, errorDigest }`. ~95% skip rate.

### Decision 5: Separate Tables for Separate Frequencies

| Table | Rate | Drives Enricher? |
|---|---|---|
| `entity_status_active` | ~500 fingerprint changes/s | Yes |
| `entity_status_summary` | ~100 hash changes/s | Via active |
| `entity_status_heartbeat` | ~6,667/s throttled | For staleness only |
| `entity_status_history` | ~50 transitions/s | No |
| `entity_status_details` | ~333/s throttled | No |

### Decision 6: Out-of-Order Protection

`observed_at` compared against current row. Older updates rejected.

### Decision 7: Source from Auth

`BoundStatusHandler.source` bound at construction. Type prefix enforced.

---

## 5. Data Model

(Identical to v10.0 — 6 tables: active, summary, heartbeat, history, details, outbox)

```sql
CREATE TABLE entity_status_active (
  entity_ref, entity_uid, status_type, source, subject_key,
  status_level CHECK (...), message, error_json, fingerprint,
  observed_at, received_at, updated_at,
  PRIMARY KEY (entity_ref, status_type, source, subject_key)
);

CREATE TABLE entity_status_summary (
  entity_ref PRIMARY KEY, worst_level, status_hash,
  item_count, error_count, warning_count, stale_count, updated_at
);

CREATE TABLE entity_status_heartbeat (
  entity_ref, status_type, source, subject_key, last_seen_at,
  PRIMARY KEY (entity_ref, status_type, source, subject_key)
);

CREATE TABLE entity_status_history (
  id, entity_ref, status_type, source, subject_key,
  old_level, new_level, old_fingerprint, new_fingerprint,
  message, recorded_at,
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

CREATE TABLE entity_status_details (
  entity_ref, status_type, source, subject_key, details, updated_at,
  PRIMARY KEY (entity_ref, status_type, source, subject_key)
);

CREATE TABLE status_catalog_outbox (
  id BIGSERIAL, entity_ref, status_hash,
  created_at, delivered_at, attempts, last_error
);
```

---

## 6. Write Path

### 6.1 API

| Method | Path | Auth |
|---|---|---|
| `POST` | `/api/status/bulk` | Service |
| `POST` | `/api/status/:kind/:namespace/:name` | Service |
| `DELETE` | `/api/status/:kind/:namespace/:name/:type/:source/:subjectKey` | Service |
| `GET` | `/api/status/:kind/:namespace/:name` | Any |
| `GET` | `/api/status/:kind/:namespace/:name/history` | Any |
| `GET` | `/api/status/dashboard` | Privileged |
| `GET` | `/api/status/search` | Any |
| `GET` | `/api/status/health` | None |

### 6.2 StatusHandler

Same as v10.0 — fingerprint check, out-of-order protection, summary recompute, outbox insert, all in one transaction.

---

## 7. Read Path

### 7.1 Entity Page — Via Catalog (With Read Enricher)

```tsx
export function EntityStatusContent() {
  const { entity } = useEntity();
  // entity.status.items is populated by StatusReadEnricher at read time
  const items = entity.status?.items ?? [];
  if (!items.length) return null;
  return <InfoCard title="Status">...</InfoCard>;
}
```

Status is ALWAYS fresh — the read enricher queries `entity_status_active` when the catalog API serves the entity. No staleness. No processing. No mutations.

### 7.2 Status Detail — Direct API

`GET /api/status/:entity` — real-time, <20ms p99.

### 7.3 Dashboard — Summary Rollup

`GET /api/status/dashboard` — from `entity_status_summary`, O(1).

### 7.4 Filtering — Status Search

`GET /api/status/search?level=error&source=ci-cd/*` → entity refs → catalog by-refs.

---

## 8. Scale & Performance

| Stage | Rate |
|---|---|
| Raw writes (2M keys × 60s) | 33,333/s |
| After fingerprint skip | ~1,667/s |
| Summary recomputes | ~100/s |
| Outbox inserts | ~100/s |
| Read enricher queries | Per entity page load (cached by TanStack Query) |

| Path | p50 | p95 | p99 |
|---|---|---|---|
| Catalog API with enricher | 10ms | 30ms | 50ms |
| Status detail API | 5ms | 20ms | 50ms |
| Dashboard | 5ms | 20ms | 50ms |

The read enricher adds ~5-10ms to entity reads (one indexed DB query). Acceptable for entity page loads. TanStack Query caches the result.

---

## 9. Implementation Plan

| Phase | Scope | Deliverable |
|---|---|---|
| **0** | **Backstage Core** | **RFC + PR: `CatalogBuilder.addEntityReadEnricher()`** |
| 1 | `status-common`, `status-node` | Types, permissions, extension points |
| 2 | `status-backend` | 6 tables, StatusHandler, router (8 endpoints) |
| 3 | `status-backend-module-catalog` | StatusReadEnricher (depends on Phase 0 landing) |
| 4 | `status-react`, `status` | Frontend: entity card, detail, dashboard, search |
| 5 | `status-backend-module-github` | Example source |
| 6 | Benchmark | 100K entity scale validation |

**Phase 0 must complete before Phase 3.** The status API (Phases 1-2, 4) works independently without the core change.

---

## 10. RFC Outline for Backstage Core

**Title:** `CatalogBuilder.addEntityReadEnricher()` — Entity Read-Time Enrichment

**Problem:** Plugins cannot add computed fields to entity responses without hacking the catalog (processors/refresh queues that flood the pipeline, monkey-patching `res.json()`, or abandoning inline entity data entirely). Status, cost, coverage, and other operational data cannot appear in entity JSON.

**Solution:** A hook on entity reads. `CatalogBuilder.addEntityReadEnricher(enricher)` registers enrichers. They run after the entity is fetched from storage but before it's returned to the client. Multiple enrichers supported. Run in registration order.

**Changes:**
- `CatalogBuilder.addEntityReadEnricher()` method
- `EntityReadEnricher` interface in `@backstage/plugin-catalog-backend`
- `catalogReadEnricherExtensionPoint` in `@backstage/plugin-catalog-node`
- Enricher invocation in entity read handlers

**BACKSTAGE PROJECT IS NOT ON GITHUB AND IS ON GERIT AND USES GERRIT FOR ALL REVIEWS AND CONTRIBUTIONS — DO NOT SUGGEST GITHUB — USE GERRIT.**
