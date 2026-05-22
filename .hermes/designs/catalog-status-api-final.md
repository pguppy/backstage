# Catalog Status API — Ultra-Think Final Analysis

## The Single Most Important Insight

After exploring event sourcing, materialized views, multi-tenancy, access control granularity, status propagation, namespace governance, status-as-code, federation, and migration paths — the design converges on one truth:

**The core system is 4 components. Everything else is optimization.**

```
entity_status table  +  POST /api/status  +  EntityStatusProcessor  +  entity page reads entity.status
─────────────────       ────────────────      ─────────────────────      ──────────────────────────────
(durable storage)       (write path)          (stitcher merge)           (read path — already exists)
```

Every other feature (dashboard, signals, history, bulk endpoint, liveness tracking, cleanup, events) is additive. None of them change the core architecture. None of them require redesigning the 4 components. Each can be added independently when needed.

## The Core (What Must Exist)

### Component 1: Database Table

```sql
CREATE TABLE entity_status (
  entity_ref TEXT NOT NULL,
  status_type TEXT NOT NULL,
  status_level TEXT NOT NULL CHECK (status_level IN ('info', 'warning', 'error')),
  message TEXT NOT NULL,
  error_json JSONB,
  source TEXT NOT NULL,
  PRIMARY KEY (entity_ref, status_type)
);
```

Durable. Survives entity refresh because the stitcher re-reads it on every stitch. 500K rows at 100K entity scale. No TTL, no partitioning needed at this size.

### Component 2: Write API

```
POST /api/status/:kind/:namespace/:name
{
  "type": "ci-cd/deployment",
  "level": "error",
  "message": "Deploy #42 failed"
}
```

Service-to-service auth. Validates entity exists. Upserts into entity_status. Returns 202.

### Component 3: Stitcher Processor

```ts
class EntityStatusProcessor implements CatalogProcessor {
  async postProcessEntity(entity: Entity): Promise<Entity> {
    const rows = await db('entity_status')
      .where('entity_ref', stringifyEntityRef(entity));

    const staticItems = (entity as AlphaEntity).status?.items ?? [];
    const liveItems = rows.map(toStatusItem);

    return {
      ...entity,
      status: { items: mergeStatus(staticItems, liveItems) },
    };
  }
}
```

Runs on every stitch. Entity refresh re-reads the table. Status always current. Single indexed query per entity (<1ms).

### Component 4: Entity Page (Already Exists)

The entity API returns `final_entity` with `status` inline. The frontend reads `entity.status` directly. No new endpoint. No new hook (unless using signals). Zero additional fetches.

```
GET /api/catalog/entities/by-name/component/default/my-service
→ { ..., status: { items: [...] } }
```

## Additive Features (Build After Core Validated)

| Feature | When to Add | Trigger |
|---|---|---|
| **History table** | When debugging requires "what changed when" | First production incident where timeline matters |
| **Bulk endpoint** | When health check agent writes 10K+ updates/cycle | First performance complaint about individual writes |
| **Signals** | When PagerDuty latency (15s poll) is unacceptable | First critical incident where 15s was too slow |
| **Dashboard** | When operators need cross-entity visibility | First "how many services are down?" question |
| **Last seen tracking** | When stale status causes confusion | First "this says deployed but it's not" bug report |
| **Entity cleanup** | When table grows beyond 1M rows | First monitoring alert on table size |
| **status.changed events** | When automation is needed | First "auto-create PagerDuty incident" request |

## What the Ultra-Think Eliminated

| Idea | Why Eliminated |
|---|---|
| **Event sourcing** (immutable events, materialized current state) | Too complex for 98% of use cases. Upsert model handles current state; history table handles audit trail. Separate concerns |
| **Separate status API** (own endpoint, own storage) | Breaks entity as single source of truth. Extra fetch. Consistency risk |
| **Status in annotations** | String-only, no queryability, annotation bloat |
| **Materialized views** (pre-computed aggregations) | Premature optimization. 500K-row indexed queries handle dashboard fine. Add when needed |
| **Status propagation** (X broken because Y broken) | Requires causality understanding from sources. K8s doesn't solve this. Operators correlate |
| **Type-level access control** | Over-engineering. Entity visibility gates status visibility. Specialized types use separate systems |
| **Status contracts** (expected vs actual) | Powerful but complex. `last_seen_at` field gives 80% of value. Contracts are Phase 4 |

## Design Principles (Distilled)

1. **Entity is the API.** Status is an entity field, not a separate system. Frontend reads entities — status comes along for free.

2. **Durable table, stitch-time merge.** Status lives in a durable table re-read on every stitch. Survives entity refresh. Follows the relations pattern.

3. **Write throughput > write freshness.** Direct DB upserts handle 1000 writes/second. The stitcher catches up within 5 seconds (with rate-limited refresh). Status is eventually consistent, like relations.

4. **Level-change filtering.** Don't record or broadcast "nothing changed." History, signals, and events only fire on transitions. Eliminates 99.9% of noise from health check polling.

5. **Build the core first.** 4 components. Ship. Validate with real traffic. Then add history, signals, bulk, dashboard based on actual need.

## What Already Exists (De-Risked)

| Component | Source | Lines of New Code |
|---|---|---|
| EntityStatus type system | `@backstage/catalog-model/alpha` | 0 |
| Schema validation | `@backstage/catalog-model` | 0 |
| `AlphaEntity` with `status` field | `@backstage/catalog-model/alpha` | 0 |
| `defaultKnownFields` includes `status` | Your commit | 0 |
| Stitcher architecture | `@backstage/plugin-catalog-backend` | 0 |
| Processor pipeline | `@backstage/plugin-catalog-backend` | 0 |
| Entity API returns `final_entity` | `@backstage/plugin-catalog-backend` | 0 |
| EntityContentBlueprint | `@backstage/plugin-catalog-react/alpha` | 0 |

**Total new code for core:** ~200 lines (table migration + processor + write handler + router). Everything else is existing Backstage infrastructure wired together.
