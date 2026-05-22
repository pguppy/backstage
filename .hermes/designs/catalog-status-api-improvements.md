# Catalog Status API — Design Improvements & Edge Case Analysis

## Methodology

Analyzed the design against 7 failure modes, 3 architectural tensions, and 4 alternative patterns (Kubernetes Conditions, Materialized Views, Annotation-based storage, API-level merge). For each improvement: what breaks without it, why it matters at 100K scale, and how it integrates with existing Backstage infrastructure.

---

## Improvement 1: Entity Deletion Cleanup

### What breaks without it

When a catalog entity is deleted (e.g., `catalog-info.yaml` removed from repo), its rows in `entity_status` persist forever. At 100K entities with typical churn of 5% monthly, that's 5,000 orphaned rows per month, 60,000 per year. The table grows unbounded. More critically: if a NEW entity is created with the same entity ref later (unlikely but possible with name reuse), it inherits the OLD entity's status — completely wrong data.

### How relations solves this

The catalog's `removeEntityByUid()` deletes the entity AND its relations in a single transaction. Relations don't have an orphan problem because the entity's lifecycle controls them.

### Fix: Two-tier cleanup

**Tier 1 (immediate):** Subscribe to entity deletion events. The catalog publishes `catalog.entity` events with `action: 'deleted'` on entity removal.

```ts
// status-backend-module-catalog/src/module.ts (extend existing module)
events.subscribe({
  id: 'status-entity-cleanup',
  topics: ['catalog.entity'],
  async onEvent({ eventPayload }) {
    if (eventPayload.action === 'deleted') {
      await db('entity_status')
        .where('entity_ref', eventPayload.entityRef)
        .del();
      logger.debug(`Cleaned up status for deleted entity ${eventPayload.entityRef}`);
    }
  },
});
```

**Tier 2 (safety net):** Scheduled cleanup that cross-references the catalog entity table. Handles the case where the events subscriber was down during deletion.

```ts
scheduler.scheduleTask({
  id: 'status-orphan-cleanup',
  frequency: { hours: 6 },
  fn: async () => {
    // Delete status rows for entities that no longer exist
    const deleted = await db('entity_status')
      .whereNotIn('entity_ref', db('refresh_state').select('entity_ref'))
      .del();
    if (deleted) logger.info(`Cleaned up ${deleted} orphaned status rows`);
  },
});
```

### Why two tiers

Event-based cleanup is instant but not guaranteed (subscriber could be down). Scheduled cleanup is guaranteed but not instant (up to 6 hours of orphaned rows). Together they provide both freshness and reliability.

---

## Improvement 2: Stitch Freshness via Rate-Limited Refresh

### What breaks without it

Status is written to `entity_status` instantly. But `final_entity` is NOT updated until the stitcher processes that entity. In deferred stitching mode (the production default), entities are stitched on a polling interval — typically 5-30 seconds. If status is the ONLY change to an entity, it may never get re-stitched until the entity's next natural change (e.g., catalog-info.yaml update — could be days).

**Result:** Entity API returns stale status. CI/CD deployment shows "succeeded" from last week even though a new deployment just failed.

### Why this is subtle

The stitcher doesn't know about `entity_status` writes. It only knows about entity changes from entity providers and location refreshes. Status writes happen outside this system. The processor runs on every stitch, but the stitcher doesn't know it NEEDS to stitch.

### Fix: Post-write refresh with per-entity cooldown

After writing status, signal the catalog that the entity needs re-stitching. But rate-limit to prevent overwhelming the processing engine during incident cascades.

```ts
// In StatusHandler.updateStatus():
await db('entity_status')
  .insert({ entity_ref: entityRef, ... })
  .onConflict(['entity_ref', 'status_type'])
  .merge();

// Rate-limited refresh: max 1 refresh per entity per 5 seconds
await maybeRefreshEntity(entityRef, auth, discovery);
```

```ts
const refreshCooldowns = new Map<string, number>();

async function maybeRefreshEntity(
  entityRef: string,
  auth: AuthService,
  discovery: DiscoveryService,
) {
  const now = Date.now();
  const lastRefresh = refreshCooldowns.get(entityRef) ?? 0;
  if (now - lastRefresh < 5_000) return; // Cooldown active

  refreshCooldowns.set(entityRef, now);

  try {
    const baseUrl = await discovery.getBaseUrl('catalog');
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: await auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });

    await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ entityRef }),
    });
  } catch (err) {
    // Refresh is best-effort. Status is still in the table.
    // Next natural stitch or next status write will trigger it.
    refreshCooldowns.delete(entityRef); // Allow retry on next write
  }
}
```

### Why 5 seconds

- Below 5s: risk overwhelming the processing engine during incident cascades (1000 writes/s → 200 refreshes/s)
- Above 5s: status staleness exceeds acceptable latency for operational monitoring
- 5s is the sweet spot: status visible in `final_entity` within 5 seconds of the last write

### What about the processor?

The processor still runs and merges status during every stitch — including natural catalog processing cycles. The refresh just accelerates the stitch. If refresh fails, the processor catches up on the next natural stitch. Two paths, complementary.

---

## Improvement 3: Bulk Write Endpoint

### What breaks without it

A health check agent scanning 10K entities every 60 seconds makes 10K individual HTTP requests. Each request:
- Authenticates
- Validates entity exists (catalog API call)
- Performs DB upsert

At 10K requests/min = 167 requests/second. Each request takes ~10ms (DB + catalog lookup). Total: 1.67 seconds of CPU per minute. Acceptable. But at 100K entities: 1,667 requests/second, 16.7 seconds of CPU per minute. The write path becomes the bottleneck.

### Why individual writes are wrong for health checks

Health checks are inherently bulk operations — an agent scans all entities and reports status. The agent already knows the full list of entities and their health status. Forcing it to make individual HTTP calls for each entity is:
- Network overhead (1,667 HTTP round trips per minute)
- Serialization overhead (JSON encode/decode × 1,667)
- Catalog lookup overhead (entity validation × 1,667)

### Fix: Bulk endpoint with transaction

```ts
POST /api/status/bulk
Authorization: Bearer <service-token>
Content-Type: application/json

{
  "items": [
    {
      "entityRef": "component:default/svc-a",
      "type": "health/readiness",
      "level": "info",
      "message": "OK"
    },
    {
      "entityRef": "component:default/svc-b",
      "type": "health/readiness",
      "level": "error",
      "message": "Connection refused",
      "error": { "name": "ConnectionError", "message": "Connection refused" }
    }
    // ... up to 1000 items per request
  ]
}
```

```ts
// In router.ts
router.post('/bulk', async (req, res) => {
  const creds = await httpAuth.credentials(req, { allow: ['service'] });
  const { items } = req.body;

  if (!Array.isArray(items) || items.length > 1000) {
    throw new InputError('items must be an array of 1-1000 status updates');
  }

  const results = await db.transaction(async trx => {
    let upserted = 0;
    for (const item of items) {
      await trx('entity_status')
        .insert({
          entity_ref: item.entityRef,
          status_type: item.type,
          status_level: item.level,
          message: item.message,
          error_json: item.error ?? null,
          source: 'health-check-agent', // Or derived from auth
        })
        .onConflict(['entity_ref', 'status_type'])
        .merge();
      upserted++;
    }
    return upserted;
  });

  res.json({ acknowledged: results });

  // Rate-limited refresh for affected entities (batched, non-blocking)
  for (const item of items) {
    maybeRefreshEntity(item.entityRef, auth, discovery).catch(() => {});
  }
});
```

### Performance characteristics

| Metric | Individual Writes | Bulk Writes |
|---|---|---|
| HTTP calls for 10K entities | 10,000 | 10 (1000 per call) |
| DB transactions for 10K entities | 10,000 | 10 |
| Total latency for 10K entities | ~100s (serial) | ~5s (batched) |
| Network overhead | 10,000 round trips | 10 round trips |

---

## Improvement 4: Real-Time Signals for Frontend

### The 15-Second Gap

The stitcher merges status into `final_entity` within 5 seconds (with rate-limited refresh). But the frontend polls the entity API every 15 seconds (TanStack Query `refetchInterval`). Between the stitch and the next poll, there's a window where:

- Status is in `final_entity` (correct)
- Frontend hasn't polled yet (stale display)

For CI/CD status (deployments take minutes), 15 seconds is fine. For PagerDuty incidents ("payment service is DOWN"), 15 seconds of additional staleness is unacceptable.

### Fix: Signal on every write

```ts
// In StatusHandler.updateStatus(), after DB write:
try {
  await signals.publish({
    recipients: {
      type: 'user',
      entityRef: entityOwner, // Resolved from catalog
    },
    channel: 'entity-status',
    message: {
      entityRef,
      item: { type: item.type, level: item.level, message: item.message },
    },
  });
} catch (err) {
  // Signal is best-effort. Entity API has fresh status via stitch.
  logger.debug(`Signal publish failed for ${entityRef}: ${err}`);
}
```

### Frontend merges entity + signal data

```tsx
// packages/status-react/src/hooks/useEntityStatus.ts
function useEntityStatus(entityRef: string): EntityStatus | null {
  // 1. Entity data (stitched, authoritative, 15s polling)
  const { data: entity } = useQuery({
    queryKey: ['entity', entityRef],
    queryFn: () => catalogApi.getEntityByRef(entityRef),
    select: (e) => e?.status ?? null,
    staleTime: 15_000,
  });

  // 2. Signal data (pushed, real-time, sub-second)
  const { lastSignal } = useSignal('entity-status',
    (signal) => signal.entityRef === entityRef,
  );

  // 3. Merge: entity is the base (authoritative), signal overrides on match
  return useMemo(() => {
    const baseItems = entity?.items ?? [];
    if (!lastSignal) return entity;

    const signalItem = lastSignal.item;
    const merged = new Map(baseItems.map(i => [i.type, i]));
    merged.set(signalItem.type, signalItem); // Signal wins on conflict

    return {
      items: [...merged.values()].sort(
        (a, b) => severityRank(b.level) - severityRank(a.level),
      ),
    };
  }, [entity, lastSignal]);
}
```

### Why two sources, not just signals

Signals are ephemeral — they deliver the latest update but don't carry the full state. If a user navigates to an entity page, they need the COMPLETE status (all items, not just the last signal). The entity API provides the authoritative full state. Signals provide the real-time update for the last change. Together they give both completeness and freshness.

---

## Improvement 5: Source Liveness Tracking

### What breaks without it

A CI/CD pipeline is decommissioned. It stops sending deployment status. The entity keeps showing the last deployment status forever — "deployed abc123" from 3 months ago. There's no indication that this data is stale.

### Why staleness matters

- Operators see "deployed successfully" and assume the service is healthy
- Actually the pipeline hasn't run in months — the service could be broken
- Silent failure: no error, no warning, just wrong information

### Fix: `last_seen_at` column

```sql
ALTER TABLE entity_status ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
```

```ts
// On every write:
await db('entity_status')
  .insert({ ..., last_seen_at: db.fn.now() })
  .onConflict(['entity_ref', 'status_type'])
  .merge({ ..., last_seen_at: db.fn.now() });
```

### Frontend staleness indicator

```tsx
function StatusItem({ item }: { item: EntityStatusItem & { last_seen_at?: string } }) {
  const isStale = item.last_seen_at
    ? (Date.now() - new Date(item.last_seen_at).getTime()) > 300_000 // 5 min
    : false;

  return (
    <ListItem>
      <StatusIcon level={item.level} />
      <span>{item.message}</span>
      {isStale && <StaleBadge tooltip="Status source may be inactive" />}
    </ListItem>
  );
}
```

### Scheduled source health alert

```ts
scheduler.scheduleTask({
  id: 'source-health-check',
  frequency: { minutes: 15 },
  fn: async () => {
    const staleSources = await db('entity_status')
      .where('last_seen_at', '<', db.raw("NOW() - INTERVAL '30 minutes'"))
      .select('source')
      .count('* as stale_count')
      .groupBy('source');

    for (const row of staleSources) {
      logger.warn(
        `Status source '${row.source}' has ${row.stale_count} items not updated in 30+ minutes`,
      );
    }
  },
});
```

---

## Improvement 6: Audit Trail (History)

### What breaks without it

Status is overwritten on each update. When a deployment fails then succeeds, the failure is lost. Debugging requires external systems (CI/CD logs, PagerDuty timeline). The status system tells you "current state" but not "how we got here."

### Fix: Append-only history table

```sql
CREATE TABLE entity_status_history (
  id BIGSERIAL PRIMARY KEY,
  entity_ref TEXT NOT NULL,
  status_type TEXT NOT NULL,
  status_level TEXT NOT NULL,
  message TEXT NOT NULL,
  error_json JSONB,
  source TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_status_history_ref
  ON entity_status_history(entity_ref, recorded_at DESC);

CREATE INDEX idx_status_history_time
  ON entity_status_history(recorded_at);
```

### Write to both tables in transaction

```ts
async updateStatus(entityRef, item, source) {
  await db.transaction(async trx => {
    // Active table (current state)
    await trx('entity_status')
      .insert({ entity_ref: entityRef, status_type: item.type, ... })
      .onConflict(['entity_ref', 'status_type'])
      .merge();

    // History table (append-only audit trail)
    await trx('entity_status_history').insert({
      entity_ref: entityRef,
      status_type: item.type,
      status_level: item.level,
      message: item.message,
      error_json: item.error ?? null,
      source,
    });
  });
}
```

### Retention policy

```ts
scheduler.scheduleTask({
  id: 'status-history-cleanup',
  frequency: { hours: 6 },
  fn: async () => {
    const deleted = await db('entity_status_history')
      .where('recorded_at', '<', db.raw("NOW() - INTERVAL '30 days'"))
      .del();
    logger.debug(`Pruned ${deleted} history rows older than 30 days`);
  },
});
```

---

## Improvement Priority & Implementation Order

| # | Improvement | Why Now | Complexity | Phase |
|---|---|---|---|---|
| 1 | Entity deletion cleanup | Orphaned rows accumulate immediately. Fix early to avoid cleanup debt later | Low | **Phase 1** |
| 2 | Stitch freshness (rate-limited refresh) | Core correctness — status must be visible within seconds | Low | **Phase 1** |
| 3 | Bulk write endpoint | Required for health check agents at scale. Without it, 100K entities = 1,667 req/s | Low | **Phase 2** |
| 4 | Real-time signals | Critical incident latency. PagerDuty integration is useless with 15s polling lag | Medium | **Phase 2** |
| 5 | Source liveness (`last_seen_at`) | Operational visibility. Prevents silent staleness | Low | **Phase 2** |
| 6 | Audit trail (history) | Debugging tool. Not blocking for MVP | Medium | **Phase 3** |

---

## What Stays Unchanged (Design Strengths)

These aspects of the current design are correct and should not be modified:

1. **`entity_status` table as durable storage** — Survives entity refresh by being re-read during every stitch, exactly like the relations table

2. **Primary key `(entity_ref, status_type)`** — One status item per source per entity. Idempotent upserts. No duplicate or conflicting status from the same source

3. **Stitcher processor merges status into `final_entity`** — Follows the proven relations pattern. Status is always in the entity, always consistent, always available through the existing entity API

4. **Status plugin as standalone plugin** — Owns the write path. Extension points for source modules. Does not modify catalog core code

5. **Live overrides static on same `type`** — Simple, predictable merge. Live is operational truth; static is baseline

6. **No separate status read API** — Frontend reads entity as it always does. Status is just another field, like relations
