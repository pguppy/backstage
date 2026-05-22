# Catalog Status API — Performance Optimization Guide

## Optimization Priority Matrix

| # | Optimization | Impact | Complexity | Phase |
|---|---|---|---|---|
| 1 | Async refresh (fire-and-forget) | Eliminates write latency coupling to catalog | Trivial | **Phase 1** |
| 2 | Write coalescing (dedup by entity) | Reduces DB writes by 60-90% for burst sources | Low | **Phase 2** |
| 3 | Dedicated connection pool for writes | Isolates status writes from catalog reads | Low | **Phase 2** |
| 4 | Bulk write endpoint | Reduces HTTP overhead by 1000× for health agents | Low | **Phase 2** |
| 5 | Batch status reads in stitcher | Reduces N queries to 1 query per stitch batch | Medium | **Phase 3** |
| 6 | JSONB query optimization | 2-5× faster status reads for complex filters | Low | **Phase 2** |
| 7 | Read replica for dashboard queries | Offloads aggregation from primary | Medium | **Phase 3** |

---

## 1. Async Refresh (Fire-and-Forget)

### Problem

Every status write waits for the catalog refresh to complete before returning:

```ts
// Current: write blocks until catalog responds
await handler.updateStatus(entityRef, item, source);
// ↓ internally calls:
await fetch('/api/catalog/refresh', { body: { entityRef } });
// Returns only after catalog processes the refresh (~50-200ms)
```

### Optimization

Don't await the refresh. Fire it and return immediately:

```ts
async updateStatus(entityRef, item, source) {
  await db.transaction(async trx => { ... }); // Write to DB (< 2ms)

  // Fire refresh asynchronously — don't block the response
  this.maybeRefreshEntity(entityRef).catch(err =>
    this.logger.debug(`Background refresh failed: ${err}`),
  );

  return { acknowledged: true }; // Return in < 3ms
}
```

**Impact:** Write latency drops from 50-200ms to < 3ms. The refresh still happens (entity gets fresh status within 5 seconds via rate-limited refresh), but the write caller doesn't wait for it.

**Risk:** If refresh fails silently, entity may take longer to get fresh status (next natural stitch cycle instead of triggered refresh). Mitigation: the background catch logs failures. The entity will still get fresh status on its next stitch.

---

## 2. Write Coalescing (Debounce by Entity)

### Problem

During an incident cascade, PagerDuty might fire 10 events for the same entity in rapid succession (incident created → acknowledged → escalated → resolved). Each event triggers a separate DB write + refresh:

```
10 events × (2ms write + 200ms refresh) = 2,020ms of work
But only the LAST state matters.
```

### Optimization

Buffer writes per entity for a short window (500ms). Only flush the latest state:

```ts
class CoalescingHandler implements StatusHandler {
  private buffer = new Map<string, { item: EntityStatusItem; source: string; timer: NodeJS.Timeout }>();

  updateStatus(entityRef, item, source) {
    const key = `${entityRef}:${item.type}`;
    const existing = this.buffer.get(key);

    if (existing) {
      clearTimeout(existing.timer);
      existing.item = item; // Replace with latest
    }

    this.buffer.set(key, {
      item,
      source,
      timer: setTimeout(async () => {
        this.buffer.delete(key);
        await this.innerHandler.updateStatus(entityRef, item, source);
      }, 500), // Flush after 500ms of inactivity
    });
  }
}
```

**Impact:** 10 rapid updates → 1 DB write. 90% reduction in write load for bursty sources. The trade-off: up to 500ms of additional latency for the final status to appear. Acceptable for all status sources (PagerDuty, CI/CD, health checks — none require sub-500ms precision).

**When NOT to coalesce:** Health check agents that send a single bulk update every 60 seconds. Their writes are already batched — coalescing adds latency with no benefit.

---

## 3. Dedicated Connection Pool

### Problem

The status plugin shares the catalog's database connection pool. At peak (1,000 writes/second), status writes consume connections that the catalog needs for entity queries.

### Optimization

Configure a small dedicated pool for status writes:

```yaml
# app-config.yaml
status:
  database:
    connection:
      pool:
        min: 2
        max: 5
```

```ts
// status-backend/src/plugin.ts
const statusDb = await database.getClient({
  connection: config.getConfig('status.database.connection'),
});
```

**Impact:** Status writes never compete with catalog reads for connections. The catalog pool (20 connections) handles entity queries. The status pool (5 connections) handles status writes. No contention at any scale.

---

## 4. Bulk Write Endpoint (Already Designed)

Reiterating because it's the single biggest optimization for health check agents:

```
Individual: 10K entities × 1 request each = 10K HTTP round trips = ~100 seconds
Bulk:       10K entities / 1,000 per request = 10 HTTP round trips = ~5 seconds
```

Plus single transaction (vs 10K transactions), single entity validation batch, single refresh trigger batch.

---

## 5. Batch Status Reads in Stitcher

### Problem

The `EntityStatusProcessor.postProcessEntity()` is called once per entity. For each entity, it makes one indexed query to `entity_status`. For a stitch batch of 100 entities, that's 100 individual queries. Even at 1ms each, that's 100ms of sequential DB time.

### Optimization (Phase 3 — Requires Stitcher Modification)

Add a pre-stitch batch hook to the processor interface:

```ts
// Proposed extension to CatalogProcessor interface
interface CatalogProcessor {
  // Existing:
  postProcessEntity?(entity: Entity, location: LocationSpec, emit: CatalogProcessorEmit): Promise<Entity>;

  // New:
  preProcessBatch?(entities: Entity[]): Promise<void>;  // Called once before batch
}
```

The processor pre-loads all status data for the batch:

```ts
class EntityStatusProcessor implements CatalogProcessor {
  private batchStatus: Map<string, EntityStatusItem[]> = new Map();

  async preProcessBatch(entities: Entity[]) {
    const refs = entities.map(e => stringifyEntityRef(e));
    const rows = await this.db('entity_status').whereIn('entity_ref', refs);
    this.batchStatus = groupBy(rows, 'entity_ref');
  }

  async postProcessEntity(entity: Entity) {
    const ref = stringifyEntityRef(entity);
    const rows = this.batchStatus.get(ref) ?? [];
    // merge...
  }
}
```

**Impact:** 100 queries → 1 query. 100ms → 2ms. 50× faster for the status read portion of stitching.

**Trade-off:** Requires a framework change to the `CatalogProcessor` interface. Not needed for MVP (100 queries × 1ms = 100ms is acceptable for a stitch batch).

---

## 6. JSONB Query Optimization

### Problem

The `error_json` column is JSONB — good for storage, but queries that filter on JSONB fields can be slow without proper indexing.

### Optimization

Add a GIN index for JSONB queries:

```sql
CREATE INDEX idx_entity_status_error
  ON entity_status USING GIN (error_json);
```

Enables fast queries like:
```sql
-- Find all entities with NotFoundError
SELECT * FROM entity_status
WHERE error_json @> '{"name": "NotFoundError"}';
```

**Impact:** JSONB containment queries go from sequential scan (500ms for 500K rows) to index scan (< 5ms). Only needed if error-based filtering becomes common.

---

## 7. Read Replica for Dashboard

### Problem

The status dashboard aggregates across all entities:
```sql
SELECT status_level, COUNT(*) FROM entity_status GROUP BY status_level;
```

At 500K rows, this is fast (< 50ms). But if the dashboard refreshes every 5 seconds AND serves 100 concurrent operators, that's 100 queries every 5 seconds. Still within capacity, but scaling.

### Optimization (Phase 3)

Route dashboard queries to a read replica:

```ts
const primaryDb = await database.getClient();        // Writes + entity queries
const replicaDb = await database.getClient({         // Dashboard reads
  connection: config.getConfig('status.database.replica'),
});
```

**Impact:** Dashboard queries never compete with writes or entity reads. Only needed when dashboard query volume exceeds 1,000 queries/minute (unlikely before 1M+ entities).

---

## Implementation Order

```
Phase 1 (MVP + Performance Foundation):
  ✅ Async refresh (fire-and-forget)

Phase 2 (Production Hardening):
  ✅ Dedicated connection pool
  ✅ Write coalescing (for bursty event sources)
  ✅ Bulk write endpoint
  ✅ JSONB GIN index

Phase 3 (Scale Optimization — only when metrics justify):
  ☐ Batch status reads in stitcher (when stitch p99 > 50ms)
  ☐ Read replica (when dashboard queries > 1,000/min)
```

---

## Benchmarks to Watch

| Metric | Baseline | Warning | Critical |
|---|---|---|---|
| Status write latency (p99) | < 5ms | > 20ms | > 50ms |
| Stitch latency (p99) | < 15ms | > 50ms | > 100ms |
| entity_status row count | 500K | > 2M | > 5M |
| Connection pool wait (avg) | < 1ms | > 5ms | > 20ms |
| History table growth | 100K/day | > 500K/day | > 2M/day |
| Dashboard query time (p99) | < 50ms | > 200ms | > 500ms |
