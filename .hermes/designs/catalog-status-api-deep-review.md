# Catalog Status API — Deep Architecture Review

## Findings from Ultra-Think Analysis

### Finding 1: History Table Will Explode at Scale (CRITICAL)

**The math I missed:**

| Source | Update Frequency | Events/Day at 100K Entities |
|---|---|---|
| Health checks | Every 60s per entity | 100K × 1,440 = **144M/day** |
| CI/CD deployments | ~10/day per active service | ~100K/day |
| PagerDuty incidents | Rare | ~50/day |

144 million health check events per day. At ~200 bytes/row = **28.8 GB/day**. 30-day retention = **864 GB**. PostgreSQL handles this but the cost is unnecessary — 99.9% of health check writes are "info → info" (no change).

**Fix:** Filter history writes to LEVEL CHANGES only.

```ts
// Before (writes every update):
await trx('entity_status_history').insert({ ... });

// After (writes only on transition):
const previous = await trx('entity_status')
  .where({ entity_ref: entityRef, status_type: item.type })
  .first('status_level');

await trx('entity_status').insert({ ... }).onConflict(...).merge();

if (!previous || previous.status_level !== item.level) {
  await trx('entity_status_history').insert({ ... });
}
```

**Impact:** History volume drops from 144M/day to ~100K/day (only level transitions). 30-day retention = ~600 MB. Feasible.

### Finding 2: Signals Will Overwhelm WebSockets at Scale (CRITICAL)

**The math:**

Health checks fire 8K writes/second sustained (144M/day ÷ 86,400s). Each write currently publishes a signal. That's 8,000 WebSocket messages/second broadcast to all connected clients.

The Backstage signals infrastructure uses per-client WebSocket connections. Broadcasting 8K messages/second to potentially thousands of open connections = the signals server becomes the bottleneck.

**Fix:** Apply the same level-change filter to signals.

```ts
// Before (signals on every write):
await signals.publish({ channel: 'entity-status', message: { ... } });

// After (signals only on level change or new item):
const isNew = !previous;
const isTransition = previous && previous.status_level !== item.level;

if (isNew || isTransition) {
  await signals.publish({ channel: 'entity-status', message: { ... } });
}

// Always publish events (for automation) — events bus handles volume better
if (isNew || isTransition) {
  await events.publish({ topic: 'status.changed', eventPayload: { ... } });
}
```

**Impact:** Signal volume drops from 8K/s to ~100/s (deployment changes + incident transitions + occasional health flips). The signals system handles this comfortably.

### Finding 3: Events for Automation (Not Signals)

Signals are for FRONTEND real-time updates (per-client, ephemeral). Events are for BACKEND automation (persistent, replayable, routed). The design should use events for automation, not signals:

```
status.changed event:
├── PagerDuty subscriber → creates/updates incident
├── Slack subscriber → posts to #platform-eng
├── Notifications subscriber → alerts entity owner
└── Webhook subscriber → triggers auto-rollback
```

The event payload is richer than the signal (includes previous/new level, timestamp, source) because automation subscribers need context to decide whether to act.

### Finding 4: Built-in Catalog Processing Status (Free Win)

The catalog processing engine already has an `onProcessingError` hook. The status module can use it to automatically surface ingestion errors as status items — the most important status source, because it tells users WHY their entity isn't showing correctly.

```ts
// In status-backend-module-catalog:
env.registerInit({
  deps: {
    catalog: catalogProcessingExtensionPoint,
    handler: statusHandlerServiceRef, // Internal service ref
  },
  async init({ catalog, handler }) {
    catalog.setOnProcessingErrorHandler(
      async ({ unprocessedEntity, errors }) => {
        await handler.updateStatus(
          stringifyEntityRef(unprocessedEntity),
          {
            type: 'backstage.io/catalog-processing',
            level: 'error',
            message: errors.map(e => e.message).join('; '),
            error: errors[0] ? serializeError(errors[0]) : undefined,
          },
          'catalog-processing',
        );
      },
    );
  },
});
```

This costs nothing — the hook already exists. It gives every entity automatic visibility into why its catalog ingestion is failing.

### Finding 5: Type Namespace Governance (Documentation, Not Code)

Two CI/CD systems reporting "deployment status" for the same entity is a governance problem, not a code problem. The solution is unique type keys per source:

```yaml
# GOOD: each source has a unique type key
ci-cd/deployment-github      # GitHub Actions deployment status
ci-cd/deployment-argo        # ArgoCD deployment status
incident/pagerduty            # PagerDuty incident status
health/readiness-datadog     # Datadog health check

# BAD: sources share type keys — last writer wins unpredictably
ci-cd/deployment              # Both GitHub AND ArgoCD write here
```

The `entity_status` primary key `(entity_ref, type)` makes this safe — different type keys = different rows. But it's a best practice to enforce, not a code constraint.

### Finding 6: Dashboard Aggregation Performance

Dashboard queries that JOIN entity_status with entity data (for "by system" or "by owner" aggregation) can be slow at scale. Solution: materialized views for common aggregation patterns.

```sql
-- Optional: for deployments with dashboard needs
CREATE MATERIALIZED VIEW status_by_system AS
SELECT
  rs.final_entity->'spec'->>'system' AS system,
  es.status_level,
  COUNT(*) as count
FROM entity_status es
JOIN refresh_state rs ON es.entity_ref = rs.entity_ref
GROUP BY system, es.status_level;

CREATE UNIQUE INDEX ON status_by_system(system, status_level);
```

Refresh every 60 seconds via scheduled task. Dashboard queries hit the materialized view in <10ms instead of joining 500K rows in ~200ms.

**Decision:** Defer to Phase 3. Dashboard at MVP scale (100K entities, 500K status rows) handles JOIN queries fine without materialized views.

### Finding 7: The `entity_status` Table IS the Right Abstractions

After exploring alternatives (event sourcing, entity column, annotations, materialized views), the `entity_status` table remains the correct choice because:

| Alternative | Why Rejected |
|---|---|
| **Event sourcing** (immutable events, materialized current state) | Too complex for MVP. The upsert model (current state + history) gives 95% of the value at 20% of the complexity |
| **Entity JSONB column** (status directly in entity) | Entity refresh rebuilds final_entity from scratch. Stitcher doesn't preserve arbitrary fields. Need a durable source that survives rebuild |
| **Annotations** | String-only, no queryability, annotation bloat |
| **Materialized view only** (current state is a query) | Requires the source data (entity_status table). The table already exists — the MV is an optimization, not a replacement |

### Finding 8: What Complexity We're Avoiding

The current design deliberately avoids:

| Complexity | Why Avoided |
|---|---|
| **Status propagation** ("entity X is broken because entity Y is broken") | Requires sources to understand causality. Kubernetes doesn't solve this either. Operators correlate in the dashboard |
| **Status lifecycle** (auto-clearing vs manual-clearing) | Each source manages its own lifecycle. Health checks auto-clear (info overwrites error). Incidents require explicit resolve |
| **Type-level access control** (security status hidden from devs) | Complex permission model. Entity visibility gates everything for MVP. Specialized status types use separate systems |
| **Cross-instance status sync** (multi-backend) | Catalog already requires shared DB for multi-instance. Entity_status is in the same DB — inherited consistency |

---

## Revised Implementation Plan

### Phase 1: Foundation
1. `status-common`, `status-node`: Types, contracts, extension point
2. `status-backend`: Migration (active + history tables), handler (with level-change filtering), bulk endpoint, entity deletion cleanup
3. `status-backend-module-catalog`: EntityStatusProcessor + processing error hook + deletion event subscriber

### Phase 2: Sources + Frontend
4. `status-backend-module-github`: GitHub deployment status
5. `status-react`: ApiRef, `useEntityStatus()` with signal merge
6. `status`: EntityStatusContent blueprint, badge, dashboard

### Phase 3: Scale + History
7. `status-backend-module-pagerduty`: PagerDuty incident status
8. `status-backend-module-health`: Health check agent
9. History retention tuning (30 days, level-change filtered)
10. Materialized views for dashboard (optional, based on performance testing)

---

## Summary of Changes from v4

| Finding | Change |
|---|---|
| History table volume explosion (144M rows/day) | Filter to level changes only (~100K/day) |
| Signals volume explosion (8K messages/s) | Filter to level changes only (~100/s) |
| Events for automation (not signals) | `status.changed` event for PagerDuty/Slack/Notifications |
| Processing error status (free win) | Hook into existing `onProcessingError` |
| Type namespace governance | Documented best practice, not enforced |
| Dashboard aggregation | Materialized views deferred to Phase 3 |
