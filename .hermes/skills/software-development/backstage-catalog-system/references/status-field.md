# Catalog Status Field — Design Notes

## Pipes Architecture (Dead-Simple MVP)

```
PostgreSQL entity_status table (upsert by PK)
       ↑
status-backend handler (fast writes)
       ↑
Events bus ← GitHub, PagerDuty, health agents
       ↓
EntityStatusProcessor (stitcher merge)
       ↓
final_entity.status (inline, zero extra frontend fetch)
```

## Key Decisions

1. **Status is an entity field, not a separate API.** AlphaEntity already has `status?: EntityStatus`. The catalog API returns it inline.

2. **Durable table + stitcher merge = survives entity refresh.** Entity refresh rebuilds `final_entity` from scratch. The stitcher re-reads the durable table and re-merges status — exactly like relations.

3. **4 core components, everything else additive.** The core (table + write API + processor + entity page) is ~200 lines. Dashboard, signals, history, bulk endpoint are all additive and independently valuable.

## Scale Math

| Component | At 100K Entities |
|---|---|
| Active rows (5 sources/entity) | 500K |
| Write throughput ceiling | 10K upserts/sec (PG handles this) |
| Health check writes/day (60s interval) | 144M |
| History writes/day (level-change filtered) | ~100K |
| Signal messages/sec (level-change filtered) | ~100 |

## Pitfalls

- **Don't put status data in a separate API.** Entity is the single source of truth.
- **Don't use TTL/expires_at.** Status persists until explicitly cleared. Stopped source = last state visible. Use `last_seen_at` for staleness indicators.
- **Don't record every health check in history.** Filter to level transitions only (info→error, error→info). "Healthy→healthy" is noise.
- **Don't signal every write.** Same filter. 8K signals/sec → 100 signals/sec after filtering.

## Design Resources

- Full spec: `.hermes/designs/catalog-status-api-spec-v4.md`
- Deep review (scale bugs caught): `.hermes/designs/catalog-status-api-deep-review.md`
- Ultra-think analysis: `.hermes/designs/catalog-status-api-final.md`
