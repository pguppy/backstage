# Deep Analysis — Beyond v5.0

## Questioning the Foundation

Five versions of the design spec all share an unexamined assumption: **that status propagation must go through catalog processing.** Every solution — processor, refresh queue, entity provider, notifier — couples status freshness to the catalog's processing interval. Let me question whether this coupling is necessary at all.

---

## 1. The Coupling Problem

Status changes and catalog processing are fundamentally different concerns:

| | Status Changes | Catalog Processing |
|---|---|---|
| **Nature** | Operational telemetry | Metadata management |
| **Frequency** | 1,667 writes/s | 0.01-0.1 cycles/s |
| **SLA** | Seconds | Minutes |
| **Failure mode** | Stale data on entity page | Missing entities in catalog |
| **Data source** | External (CI/CD, PagerDuty) | Internal (entity descriptors) |
| **Mutation type** | Field-level update | Full entity ingestion |

Routing status through catalog processing is like routing text messages through your nightly database backup job. The mechanisms operate at different time scales, under different SLAs, with different failure characteristics. Forcing them through the same pipeline creates:

1. **Latency coupling**: If the catalog is slow (large backlog, many processors), status propagation slows down. An incident goes undetected for minutes because the catalog is processing a bulk import.

2. **Load coupling**: If status is heavy (many writes), the catalog gets overloaded. A CI/CD pipeline running 1,000 concurrent deployments floods the catalog's processing queue.

3. **Failure coupling**: If the catalog is down, status stops propagating even though the status plugin itself is healthy. Two independent systems fail together.

## 2. What Does "Inline on Entities" Actually Mean?

The requirement has been stated as: "Status must be part of catalog entities." But there are three distinct interpretations:

### Interpretation A: Visual — Status must be visible on entity pages

The `EntityStatusContent` component renders status on the entity page. It could fetch from the status API or read from the entity. The user sees status. Visual requirement met.

**Implementation:** Frontend component fetches from `/api/status/:entity` in parallel with entity fetch. TanStack Query caches. No catalog integration needed at all.

### Interpretation B: Queryable — Status must be filterable through catalog API

"Show me all components with error status" requires the catalog to know about status. The catalog's `/entities` endpoint must support `filter: { status.level: 'error' }`.

**Implementation:** This requires status to be in the entity, OR requires the catalog to support external field queries. Entity provider satisfies this. Read enricher could also satisfy this (populate at query time, filter after enrichment).

### Interpretation C: External — Status must be visible to tools that read the catalog

Third-party tools, API consumers, and downstream systems read entity data from the catalog API. They expect status to be in the entity JSON.

**Implementation:** Requires status in the entity. Entity provider or read enricher.

**Which interpretation is the real requirement?** If A, we can eliminate the entire catalog integration layer. If B or C, we need some form of entity enrichment — but maybe not through the processing pipeline.

## 3. The Decoupled Architecture

What if status NEVER goes through catalog processing? Instead, status is attached to entities at READ time, not WRITE time:

```
┌─────────────────────────────────────────────────────────────┐
│ WRITE PATH (decoupled from catalog)                         │
│                                                             │
│  Status write → entity_status_active (instant, independent) │
│  Zero catalog involvement. Zero processing overhead.        │
│                                                             │
│  Tables: entity_status_active, heartbeat, history, details  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ READ PATH — Entity Enrichment (no processing involved)      │
│                                                             │
│  GET /api/catalog/entities/by-name/:kind/:namespace/:name   │
│    → Catalog returns entity                                 │
│      → EntityReadEnricher intercepts response               │
│        → Queries entity_status_active                       │
│          → Merges status into entity JSON                   │
│            → Returns enriched entity to client              │
│                                                             │
│  Status is ALWAYS fresh at read time.                       │
│  Zero processing overhead.                                  │
│  Zero coupling between status and catalog processing.       │
└─────────────────────────────────────────────────────────────┘
```

This requires ONE thing: the ability to enrich entity responses at read time. This doesn't exist in Backstage today, but it's a small, focused contribution.

### What the Core Change Looks Like

```ts
// In @backstage/plugin-catalog-backend — CatalogBuilder
interface EntityReadEnricher {
  enrich(entity: Entity): Promise<Entity>;
}

class CatalogBuilder {
  private enrichers: EntityReadEnricher[] = [];

  addEntityReadEnricher(enricher: EntityReadEnricher): this {
    this.enrichers.push(enricher);
    return this;
  }

  async build(): Promise<Router> {
    // ... existing setup ...
    // Pass enrichers to the router for response-time enrichment
  }
}
```

```ts
// In @backstage/plugin-catalog-backend — entity read handler
router.get('/entities/by-name/:kind/:namespace/:name', async (req, res) => {
  const entity = await database.getEntityByName(kind, namespace, name);
  if (!entity) throw new NotFoundError();

  // Enrich at response time
  for (const enricher of this.enrichers) {
    entity = await enricher.enrich(entity);
  }

  res.json(entity);
});
```

```ts
// In plugins/status-backend-module-catalog — StatusReadEnricher
class StatusReadEnricher implements EntityReadEnricher {
  constructor(private db: Knex) {}

  async enrich(entity: Entity): Promise<Entity> {
    const active = await this.db('entity_status_active')
      .where('entity_ref', stringifyEntityRef(entity))
      .orderByRaw(severityOrder)
      .limit(20);

    if (!active.length) return entity;

    const items = active.map(r => ({
      type: r.status_type, level: r.status_level,
      message: (r.message as string).slice(0, 512),
    }));

    return { ...entity, status: { items } };
  }
}
```

### Why This Is Better Than Every Previous Design

| Property | Entity Provider (v5.0) | Read Enricher (proposed) |
|---|---|---|
| Staleness | 15-150s | 0s (instant at read time) |
| Catalog processing load | ~100 entity mutations/cycle | Zero |
| Coupling to catalog health | Tight (if catalog down, no propagation) | None (status always available) |
| Filter support | Yes (status in entity) | Yes (enriched before filter) |
| External tool support | Yes | Yes |
| Core change required | No | Yes (small, focused) |
| Implementation complexity | Medium (provider, polling, batching) | Low (single hook, single query) |

### What About Catalog API Filters?

"Show me all components with error status." If status is enriched at read time, filtering happens AFTER enrichment:

```
GET /api/catalog/entities?filter=status.items.level=error
  → Catalog queries entities
    → For each entity, enrichers run
      → Status enricher adds status
        → Filter is applied to enriched entity
          → Returns matching entities
```

This requires the catalog to support filtering on enriched fields. If the current catalog API filters at the query level (SQL), this won't work — enrichment happens after the query. We'd need post-query filtering.

Alternative: the status enricher could maintain a materialized view or secondary index for filtering:

```sql
CREATE MATERIALIZED VIEW entity_status_summary AS
SELECT entity_ref,
       MAX(CASE status_level WHEN 'error' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END)
         AS worst_level
FROM entity_status_active
GROUP BY entity_ref;
```

The catalog could JOIN this view when filtering by status level. But this couples the status plugin's schema to the catalog's query layer — fragile.

**Realistic assessment:** For filtering by status in the catalog API, the entity provider pattern (v5.0) is currently the only viable approach. The read enricher handles the visual requirement (entity page) perfectly. For filtering, we need status in the entity itself.

## 4. The In-Process Notifier (Available Today, No Core Changes)

While we work toward the read enricher as a core contribution, we can eliminate the biggest pain point of v5.0 — the 15-second provider polling lag:

```ts
// plugins/status-node/src/StatusNotifierService.ts
export interface StatusNotifierService {
  notifyChange(entityRef: string, items: EntityStatusItem[]): Promise<void>;
  subscribe(handler: StatusChangeHandler): () => void;
}

export type StatusChangeHandler = (
  entityRef: string,
  items: EntityStatusItem[],
) => Promise<void>;

export const statusNotifierServiceRef =
  createServiceRef<StatusNotifierService>({
    id: 'status.notifier',
    scope: 'plugin',
  });
```

The `status-backend` implements this as an in-process event emitter. The catalog module subscribes:

```ts
// catalog module init:
statusNotifier.subscribe(async (entityRef, items) => {
  const entity = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: parseKind(entityRef),
    metadata: { name: parseName(entityRef) },
    status: { items },
  };
  await connection.applyMutation({
    type: 'full',
    entities: [{ entity, locationKey: `status:${entityRef}` }],
  });
});
```

The StatusHandler notifies on every fingerprint change:

```ts
// In StatusHandler.updateStatus(), after upsert:
if (fingerprintChanged) {
  await statusNotifier.notifyChange(entityRef, items);
  // Entity enters processing queue within microseconds
  // Visible on entity page in 5-10s (next processing cycle)
}
```

**This is the best approach available today:**
- No polling — push-based notification
- No HTTP calls — in-process
- No core changes — uses existing Backstage patterns
- Entity provider still exists as catch-up (runs at startup, handles missed notifications)
- Provider polling can be reduced to 5 minutes (catch-up only) instead of 15 seconds

## 5. Comparison Matrix

| Approach | Core Change? | p95 Staleness | Processing Load | Complexity | Filter Support |
|---|---|---|---|---|---|
| Processor + Refresh (v3.2) | No | N/A (broken) | Per-write flood | High | N/A |
| Entity Provider 15s (v5.0) | No | 25s | ~100/cycle | Medium | Yes |
| Provider + Notifier (proposed) | No | 10s | ~100/cycle | Medium | Yes |
| Read Enricher (future) | Yes | 0s | Zero | Low | Partial |
| Read Enricher + Provider (hybrid) | Yes | 0s | ~100/cycle | Medium | Yes |

## 6. Recommendations

### For immediate implementation (today):
**Entity Provider + In-Process Notifier** — combines the reliability of the provider with the speed of push-based notification. This is v5.0 with the 15s poll replaced by a direct subscribe/unsubscribe pattern.

### For Backstage core contribution (RFC):
**Entity Read Enricher** — a hook on entity reads that enriches responses with fresh plugin data. This eliminates all staleness and all processing overhead. Status is always fresh at read time. This benefits every plugin that wants to add computed fields to entities, not just status.

### For Backstage core contribution (RFC):
**Delta Entity Mutations** — entity providers can emit partial entity updates (`type: 'delta'`). The stitcher applies patches without running the full processor pipeline. Benefits all high-churn entity fields.

## 7. Open Question for Patrick

The architectural decision hinges on one question: **what does "status must be inline on entities" actually mean?**

- If it means **visible on entity pages** (Interpretation A) → we can skip the entire catalog integration layer. Frontend fetches from status API. Simplest, fastest, most decoupled design possible.

- If it means **filterable and queryable through catalog API** (Interpretation B) → we need status in the entity. Entity provider + notifier is the best approach available today. Read enricher is the ideal future state.

- If it means **both** → hybrid: entity provider for filter support, read enricher for instant freshness, plus status API for real-time detail.

Which interpretation drives this requirement?
