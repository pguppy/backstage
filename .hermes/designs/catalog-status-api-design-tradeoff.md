# Deep Analysis — The Requirement Question

## What "Status in Entity JSON" Actually Enables

Every design from v3.2 through v8.0 accepts that status must be stored in the entity object. This forces status through catalog processing, creating inherent staleness (5-10s minimum). Let me trace exactly what this requirement buys us versus what a separate API provides:

| Capability | In Entity JSON | Separate Status API |
|---|---|---|
| **See status on entity page** | Yes — reads `entity.status.items` | Yes — `EntityStatusContent` fetches from `/api/status/:entity`. Same UX, TanStack Query caching. |
| **Filter catalog by status level** | Yes — `GET /entities?filter=status.items.level=error` | No — catalog doesn't know about status. But `/api/status/dashboard?filter=level:error` provides same information. |
| **External tool reads status** | Yes — status in entity JSON from catalog API | Yes — status from `/api/status/:entity`. Same REST API, same auth, same discovery. |
| **Zero additional API calls** | Yes — entity page renders inline | Yes — TanStack Query fetches both entity and status in parallel. Same number of waterfall steps. |
| **Homepage widgets** | Partial — entity JSON includes status | Yes — status API provides aggregation natively |
| **Alerting/rules** | Partial — filter catalog API | Yes — status API provides filtering natively |

**The only unique capability of "status in entity JSON" is catalog API filtering by status level.** Everything else is achievable with a separate API.

## The Simplicity Trade-Off

### Design A: Status in Entity JSON (v8.0)

```
4,000 lines of code
├── Entity provider + notification bus + extension point
├── Catalog processing pipeline integration
├── Catch-up poll + partition maintenance
├── 5-10s inherent staleness from processing interval
└── Complexity: high

Catalog filtering by status level: YES
```

### Design B: Separate Status API Only

```
200 lines of code (new)
├── EntityStatusContent fetches from /api/status/:entity
├── TanStack Query: useQuery(['status', entityRef])
├── Parallel fetch with entity (no waterfall)
├── Instant freshness (reads entity_status_active directly)
└── Complexity: minimal

Catalog filtering by status level: NO (use status dashboard instead)
```

### Design C: Hybrid (Minimal Entity Provider + Status API)

```
~1,500 lines of code
├── Entity provider writes ONLY worst-level badge to entity
│   (one item, not 20 — lightweight, infrequent processing)
├── EntityStatusContent shows badge from entity, detail from API
├── Status API handles full detail, filtering, dashboard
├── Provider runs every 30 minutes (catch-up only)
└── Complexity: moderate

Catalog filtering: partial (worst level only)
Full detail: via API
```

## The Question

Design A is ~20x more complex than Design B for one capability: filtering catalog entities by status level via `GET /entities?filter=status.items.level=error`.

Is that capability worth the architectural complexity? Or does the status dashboard (`/api/status/dashboard?filter=level:error`) provide sufficient filtering for the use cases that matter?

The answer determines whether we implement 4,000 lines of catalog integration or 200 lines of API + frontend.
