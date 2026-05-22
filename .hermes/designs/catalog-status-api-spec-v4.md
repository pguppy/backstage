# Backstage Catalog Status API — Final Design Specification (v4)

**Status:** Definitive  
**Date:** May 2026  
**Author:** Patrick Guppy  
**Target:** Backstage 1.51+ (New Backend + Frontend Systems)

---

## 0. Executive Summary

The Catalog Status API adds a live `status` field to every Backstage entity. Status flows from external operational systems (CI/CD, PagerDuty, health checks) through an event-driven write pipeline, merges into the entity via the existing catalog stitcher, and surfaces on entity pages and dashboards with zero additional frontend fetches.

**Three design principles:**
1. **Status is an entity field** — not a separate API, not a separate storage system. Status lives in the entity, just like relations.
2. **Status survives entity refresh** — stored in a durable `entity_status` table re-read by the stitcher on every stitch, following the proven relations pattern.
3. **Status is a platform, not a feature** — extension points, events, signals, and aggregation enable an ecosystem of sources, consumers, and automations.

---

## 1. User Experience (Target State)

### 1.1 Entity Page

Every entity page shows a Status tab with all live status items, sorted by severity:

```
my-service                                    🔴 ERROR
component:default/my-service

[Overview] [Docs] [Status] [CI/CD] [K8s]

  🔴 ci-cd/deployment
     Deploy #42 failed: type errors in src/routes.ts
     5 min ago · GitHub Actions · [View Logs →]

  🟡 ci-cd/build
     Build #43 succeeded with 3 warnings
     12 min ago · GitHub Actions

  🟢 health/readiness
     All probes passing (latency: 45ms)
     1 min ago · Health Agent

  🔴 backstage.io/catalog-processing
     NotFoundError: catalog-info.yaml not found at ref main
     2 hours ago · Catalog    ⚠ Source may be inactive
```

**Key behaviors:**
- Severity badge in entity header (green/yellow/red/grey)
- Stale indicator when source hasn't updated in 5+ minutes
- Error details expandable (stack trace, error object)
- Links to external systems (GitHub Actions run, PagerDuty incident)
- History timeline (last 24 hours of status changes)

### 1.2 Status Dashboard

```
Status Dashboard

  Summary                 Systems with Errors        Recent Changes
  ┌─────────────────┐    ┌──────────────────────┐   ┌──────────────────────┐
  │ 3 Errors         │    │ 🔴 payments (2)      │   │ 14:32 payment-api    │
  │ 12 Warnings      │    │ 🔴 user-svc (1)      │   │       deploy error   │
  │ 985 Healthy      │    │ 🟡 platform (3)      │   │ 14:30 user-db        │
  │ 0 Unknown        │    └──────────────────────┘   │       health error    │
  └─────────────────┘                                │ 14:28 order-svc      │
                                                     │       build warning   │
  Entities by Severity                               └──────────────────────┘
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 🔴 payment-api       deploy error     5 min ago    owner: team-payments │
  │ 🔴 payment-db        health error     3 min ago    owner: team-payments │
  │ 🔴 user-service      deploy error     2 min ago    owner: team-user     │
  │ 🟡 order-service     build warning   12 min ago    owner: team-orders   │
  └─────────────────────────────────────────────────────────────────────────┘
```

**Key behaviors:**
- Aggregate counts by severity, system, domain, owner
- Filter by kind, system, owner, status type
- Real-time updates via signals (no polling)
- Click-through to entity page for detail

### 1.3 Automation

Status changes trigger automated actions:

```
status.changed event (level: info → error, type: ci-cd/deployment)
  ├── PagerDuty: auto-create incident
  ├── Slack: notify #platform-eng channel
  ├── Notifications: alert entity owner
  └── Webhook: trigger auto-rollback pipeline
```

---

## 2. Architecture

### 2.1 Data Flow

```
EXTERNAL SYSTEMS                    BACKSTAGE INTERNAL                FRONTEND
────────────────                    ──────────────────                ────────
GitHub Actions ──┐
PagerDuty ───────┤   events bus    ┌──────────────┐
Health Agent ────┼──────────────→  │ status-backend│
Custom Source ───┘                 │              │
                                   │ write handler │──→ entity_status table (durable)
HTTP API (bulk) ─────────────────→ │              │
                                   │ signal pub    │──→ WebSocket → entity page (instant)
                                   │ event pub     │──→ automation (PagerDuty, Slack)
                                   └──────┬───────┘
                                          │
                                   catalog stitcher (reads entity_status)
                                          │
                                          ▼
                                   final_entity.status (merged)
                                          │
                                          ▼
                                   GET /api/catalog/entities/...
                                          │
                                          ▼
                                   entity page (15s polling fallback)
```

### 2.2 Two Read Paths (Complementary)

| Path | Latency | Data | Use Case |
|---|---|---|---|
| **Signal push** | Sub-second | Single status item (latest change) | Real-time badge update, incident alert |
| **Entity API poll** | 15 seconds | Full status (all items, authoritative) | Page load, complete state, offline resilience |

Signals carry the latest CHANGED item. The entity API carries the full AUTHORITATIVE state. The frontend merges both: entity state is the base, signal items override on type conflict. If signals fail, the entity API is the fallback. If the entity API is slow, signals keep the UI fresh.

### 2.3 Two Write Paths (Complementary)

| Path | Throughput | Use Case |
|---|---|---|
| **Events bus** | Per-event (any volume) | CI/CD webhooks, PagerDuty events, streaming sources |
| **HTTP API (bulk)** | 1000 items/request | Health check agents, batch sync, migration tools |

---

## 3. Database Schema

### 3.1 Active Status Table

```sql
CREATE TABLE entity_status (
  entity_ref TEXT NOT NULL,
  status_type TEXT NOT NULL,
  status_level TEXT NOT NULL CHECK (status_level IN ('info', 'warning', 'error')),
  message TEXT NOT NULL,
  error_json JSONB,
  source TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_ref, status_type)
);

CREATE INDEX idx_entity_status_ref ON entity_status(entity_ref);
CREATE INDEX idx_entity_status_level ON entity_status(status_level);
```

### 3.2 History Table

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

CREATE INDEX idx_status_history_ref ON entity_status_history(entity_ref, recorded_at DESC);
CREATE INDEX idx_status_history_time ON entity_status_history(recorded_at);
```

### 3.3 Merge Logic (in Stitcher Processor)

```ts
function mergeStatus(
  staticItems: EntityStatusItem[],   // From entity YAML / entity provider
  liveRows: StatusRow[],             // From entity_status table
): EntityStatusItem[] {
  const merged = new Map<string, EntityStatusItem>();

  // Static provides baseline
  for (const item of staticItems) merged.set(item.type, item);

  // Live overrides static on same type
  for (const row of liveRows) {
    merged.set(row.status_type, {
      type: row.status_type,
      level: row.status_level,
      message: row.message,
      error: row.error_json ?? undefined,
    });
  }

  // Errors first, then warnings, then info
  return [...merged.values()].sort(
    (a, b) => severityRank(b.level) - severityRank(a.level)
  );
}
```

### 3.4 Why Not TTL / `expires_at`

Status items are replaced, not expired. A CI/CD deployment failure stays "error" until the next deployment writes "info" to the same `(entity_ref, status_type)` key. If a source stops sending, its last known status persists — silent disappearance of status is worse than stale status.

The `last_seen_at` column (not an expiry) provides STALENESS VISIBILITY without removing data. The frontend shows a "source may be inactive" indicator. Operators decide whether to investigate or clear the status manually.

---

## 4. Stitcher Integration (EntityStatusProcessor)

```ts
// status-backend-module-catalog/src/EntityStatusProcessor.ts
export class EntityStatusProcessor implements CatalogProcessor {
  constructor(private readonly db: Knex) {}

  getProcessorName(): string {
    return 'EntityStatusProcessor';
  }

  async postProcessEntity(
    entity: Entity,
    _location: LocationSpec,
    _emit: CatalogProcessorEmit,
  ): Promise<Entity> {
    const entityRef = stringifyEntityRef(entity);

    const rows = await this.db('entity_status')
      .where('entity_ref', entityRef)
      .select('status_type', 'status_level', 'message', 'error_json', 'last_seen_at', 'source');

    const staticItems = (entity as AlphaEntity).status?.items ?? [];

    if (!rows.length && !staticItems.length) {
      return entity; // No status — pass through unchanged
    }

    const liveItems: EntityStatusItem[] = rows.map(r => ({
      type: r.status_type,
      level: r.status_level,
      message: r.message,
      error: r.error_json ?? undefined,
    }));

    return {
      ...entity,
      status: {
        items: mergeStatus(staticItems, liveItems),
      },
    };
  }
}
```

**This runs on EVERY stitch — initial ingestion, entity refresh, periodic re-stitch, and refresh-triggered stitches.** Status is always re-read from the durable table and re-merged into `final_entity`. Entity refresh (which rebuilds the entity from scratch) does NOT lose status because the processor always re-reads the `entity_status` table.

---

## 5. Write Path

### 5.1 Status Handler

```ts
class StatusHandler {
  constructor(
    private readonly db: Knex,
    private readonly auth: AuthService,
    private readonly discovery: DiscoveryService,
    private readonly signals: SignalService,
    private readonly events: EventsService,
    private readonly catalog: CatalogService,
  ) {}

  async updateStatus(
    entityRef: string,
    item: EntityStatusItem,
    source: string,
  ): Promise<void> {
    // Validate entity exists
    const entity = await this.catalog.getEntityByRef(entityRef);
    if (!entity) throw new NotFoundError(`Entity ${entityRef} not found`);

    // Read previous state for change detection
    const previous = await this.db('entity_status')
      .where({ entity_ref: entityRef, status_type: item.type })
      .first('status_level');

    // Atomic write to active table + history
    await this.db.transaction(async trx => {
      await trx('entity_status')
        .insert({
          entity_ref: entityRef,
          status_type: item.type,
          status_level: item.level,
          message: item.message,
          error_json: item.error ?? null,
          source,
          last_seen_at: trx.fn.now(),
        })
        .onConflict(['entity_ref', 'status_type'])
        .merge();

      await trx('entity_status_history').insert({
        entity_ref: entityRef,
        status_type: item.type,
        status_level: item.level,
        message: item.message,
        error_json: item.error ?? null,
        source,
      });
    });

    // Push real-time signal to frontend
    this.signals.publish({
      recipients: { type: 'broadcast' },
      channel: 'entity-status',
      message: { entityRef, item: { ...item, source, last_seen_at: new Date().toISOString() } },
    }).catch(err => this.logger.debug(`Signal failed: ${err}`));

    // Publish change event for automation
    if (previous && previous.status_level !== item.level) {
      this.events.publish({
        topic: 'status.changed',
        eventPayload: {
          entityRef,
          statusType: item.type,
          previousLevel: previous.status_level,
          newLevel: item.level,
          source,
          timestamp: new Date().toISOString(),
        },
      }).catch(err => this.logger.debug(`Event failed: ${err}`));
    }

    // Trigger rate-limited entity refresh for stitch freshness
    this.maybeRefreshEntity(entityRef);
  }

  private refreshCooldowns = new Map<string, number>();

  private async maybeRefreshEntity(entityRef: string): Promise<void> {
    const now = Date.now();
    if (now - (this.refreshCooldowns.get(entityRef) ?? 0) < 5_000) return;
    this.refreshCooldowns.set(entityRef, now);

    try {
      const baseUrl = await this.discovery.getBaseUrl('catalog');
      const { token } = await this.auth.getPluginRequestToken({
        onBehalfOf: await this.auth.getOwnServiceCredentials(),
        targetPluginId: 'catalog',
      });
      await fetch(`${baseUrl}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ entityRef }),
      });
    } catch {
      this.refreshCooldowns.delete(entityRef); // Allow retry
    }
  }
}
```

### 5.2 Bulk Write Endpoint

```ts
POST /api/status/bulk
{
  "items": [
    { "entityRef": "component:default/svc-a", "type": "health/readiness",
      "level": "info", "message": "OK" },
    { "entityRef": "component:default/svc-b", "type": "health/readiness",
      "level": "error", "message": "Connection refused",
      "error": { "name": "ConnectionError", "message": "Connection refused" } }
  ]
}
```

Processed in a single transaction. 1000 items per request max. Returns `{ acknowledged: N }`.

### 5.3 Status Source Extension Point

```ts
// packages/status-node/src/types.ts
export interface StatusSource {
  readonly name: string;
  connect(handler: StatusHandler): Promise<void> | void;
}

// packages/status-node/src/extensions.ts
export const statusSourceExtensionPoint =
  createExtensionPoint<StatusSource[]>({ id: 'status.sources' });
```

---

## 6. Entity Deletion Cleanup

```ts
// Tier 1: Immediate via events
events.subscribe({
  id: 'status-entity-cleanup',
  topics: ['catalog.entity'],
  async onEvent({ eventPayload }) {
    if (eventPayload.action === 'deleted') {
      await db('entity_status').where('entity_ref', eventPayload.entityRef).del();
      await db('entity_status_history').where('entity_ref', eventPayload.entityRef).del();
    }
  },
});

// Tier 2: Safety net via scheduled task (handles missed events)
scheduler.scheduleTask({
  id: 'status-orphan-cleanup',
  frequency: { hours: 6 },
  fn: async () => {
    const deleted = await db('entity_status')
      .whereNotIn('entity_ref', db('refresh_state').select('entity_ref'))
      .del();
    if (deleted) logger.info(`Cleaned ${deleted} orphaned status rows`);
  },
});
```

---

## 7. Scale & Performance

### 7.1 Write Path

| Component | Latency | Throughput |
|---|---|---|
| DB upsert (single) | < 1ms | 10,000+/sec per instance |
| DB transaction (history + active) | < 2ms | 5,000+/sec per instance |
| Bulk upsert (1000 items) | < 50ms | 20 batches/sec = 20,000 items/sec |
| Entity validation (cached) | < 5ms | N/A (depends on catalog caching) |

### 7.2 Read Path

| Component | Latency |
|---|---|
| Entity query (final_entity with status) | Same as current catalog performance (status embedded, no extra query) |
| Stitcher processor (adds status) | < 1ms (indexed query on entity_ref) |

### 7.3 Storage

| Metric | Value |
|---|---|
| Active rows (100K entities × 5 sources) | 500,000 |
| History rows (30 day retention, 1 update/source/hour) | 3,600,000 |
| Active table size | ~250 MB |
| History table size | ~1.8 GB |
| Total | ~2 GB (within single PostgreSQL instance) |

---

## 8. Package Structure

```
plugins/
  status/                              frontend-plugin
    src/alpha/
      plugin.tsx                       createFrontendPlugin
      apis.ts                          ApiBlueprint → statusApiRef
      entityContents.ts                EntityStatusContent blueprint (tab)
      entityBadges.ts                  EntityStatusBadge component (header)
      pages/
        StatusDashboard.tsx            System-wide status dashboard

  status-backend/                      backend-plugin
    src/
      plugin.ts                        createBackendPlugin + extension point
      handler/StatusHandler.ts         Write handler (DB + signals + events + refresh)
      router.ts                        POST /status/:kind/:namespace/:name + /bulk
    migrations/
      20260501000000_init.js           entity_status + entity_status_history tables

  status-backend-module-catalog/       backend-plugin-module
    src/
      module.ts                        EntityStatusProcessor + entity deletion cleanup

  status-backend-module-github/        backend-plugin-module
  status-backend-module-pagerduty/     backend-plugin-module
  status-backend-module-health/        backend-plugin-module

packages/
  status-common/                       common-library
    src/types.ts                       Re-exports EntityStatus from catalog-model/alpha
    src/StatusApi.ts                   Client interface (read + write)

  status-react/                        web-library
    src/api.ts                         statusApiRef
    src/hooks/
      useEntityStatus.ts               TanStack Query + signal merge
      useStatusDashboard.ts            Aggregation queries

  status-node/                         node-library
    src/extensions.ts                  statusSourceExtensionPoint
    src/types.ts                       StatusSource, StatusHandler interface
```

---

## 9. Extension Points & Module Contracts

### 9.1 statusSourceExtensionPoint

```ts
// Modules implement StatusSource:
interface StatusSource {
  name: string;
  connect(handler: StatusHandler): Promise<void> | void;
}

// Handler provides:
interface StatusHandler {
  updateStatus(entityRef: string, item: EntityStatusItem, source: string): Promise<void>;
  clearStatus(entityRef: string, type: string): Promise<void>;
}
```

### 9.2 status.changed Events

```ts
// Published on every level change:
{
  topic: 'status.changed',
  eventPayload: {
    entityRef: string;
    statusType: string;
    previousLevel: 'info' | 'warning' | 'error' | null;
    newLevel: 'info' | 'warning' | 'error';
    source: string;
    timestamp: string;
  }
}
```

Consumers (PagerDuty, Slack, Notifications, webhooks) subscribe to this topic.

### 9.3 entity-status Signal

```ts
// Pushed on every write:
{
  channel: 'entity-status',
  message: {
    entityRef: string;
    item: EntityStatusItem & { source: string; last_seen_at: string };
  }
}
```

---

## 10. Design Decisions Log

| # | Decision | Rejected | Rationale |
|---|---|---|---|
| 1 | Status in entity, not separate API | Separate `/api/status` | Entity is Backstage's universal data model. Inline status = zero extra fetches, zero loading states, zero consistency problems |
| 2 | Durable `entity_status` table + stitcher merge | Buffer table drained on stitch | Must survive entity refresh. Relations pattern proves this works at Backstage scale |
| 3 | Stitcher processor (`postProcessEntity`) | New stitcher extension point | `postProcessEntity` is the intended extension mechanism. No new framework APIs |
| 4 | Live overrides static on same type | Configurable priority | Live is operational truth. Static is baseline. Simple, predictable merge |
| 5 | Rate-limited entity refresh (5s cooldown) | Unrestricted refresh | 1000 writes/sec = 200 refreshes/sec max. Prevents stitcher overload during incidents |
| 6 | Signals + Entity API (dual read path) | Signals only, or polling only | Signals = instant but incomplete. Entity API = authoritative but 15s lag. Together = best of both |
| 7 | Bulk write endpoint | Individual writes only | Health agents need 10K+ writes/cycle. Individual = 1,667 req/s at 100K scale. Bulk = 10 req/cycle |
| 8 | `last_seen_at` over `expires_at` | TTL auto-expiry | Expiry hides problems. Staleness indicator shows problems. Operator decides |
| 9 | History table (separate from active) | History in same table with versioning | Active = fast upsert (PK lookup). History = append-only (no contention). Separate concerns |
| 10 | Service-only writes | User-initiated writes | Status is automated (CI/CD, probes, webhooks). Users shouldn't manually set operational status |
| 11 | Extension point as source array | Add-collector pattern | Sources need lifecycle (`connect`). Array lets plugin connect after module registration |
| 12 | No TTL, no auto-cleanup of active status | Auto-expiry | Status persists until explicitly cleared or overwritten. Stopped source = last state visible |

---

## 11. What Already Exists (De-Risked)

| Component | Source | Status |
|---|---|---|
| `EntityStatus` type | `@backstage/catalog-model/alpha` | ✓ Exists |
| `EntityStatusItem` type | `@backstage/catalog-model/alpha` | ✓ Exists |
| `AlphaEntity extends Entity { status? }` | `@backstage/catalog-model/alpha` | ✓ Exists |
| Schema validator (status items) | `@backstage/catalog-model` | ✓ Exists + tested |
| `defaultKnownFields` includes `status` | Your commit | ✓ Done |
| Stitcher architecture | `@backstage/plugin-catalog-backend` | ✓ Exists |
| Processor pipeline (`postProcessEntity`) | `@backstage/plugin-catalog-backend` | ✓ Exists |
| `POST /refresh` endpoint | `@backstage/plugin-catalog-backend` | ✓ Exists |
| Events bus | `@backstage/plugin-events-node` | ✓ Exists |
| Signals infrastructure | `@backstage/plugin-signals` | ✓ Exists |
| Entity API returns `final_entity` | `@backstage/plugin-catalog-backend` | ✓ Exists |
| `EntityContentBlueprint` | `@backstage/plugin-catalog-react/alpha` | ✓ Exists |

**Only new code:** `entity_status` table, `StatusHandler`, `EntityStatusProcessor`, extension point, bulk endpoint, frontend components. Everything else is existing Backstage infrastructure.

---

## 12. Implementation Phases

### Phase 1: Foundation (Core Write Path + Entity Integration)
1. `status-common`: Types, API interface
2. `status-node`: Extension point, `StatusSource`/`StatusHandler` contracts
3. `status-backend`: Migration, handler, bulk endpoint, entity cleanup
4. `status-backend-module-catalog`: `EntityStatusProcessor` + deletion cleanup
5. `status-backend-module-github`: First source module

### Phase 2: Frontend + Real-Time
6. `status-react`: `statusApiRef`, `useEntityStatus()` hook with signal merge
7. `status`: `EntityStatusContent` blueprint, badge, dashboard page
8. `status-backend-module-pagerduty`: PagerDuty source
9. `status-backend-module-health`: Health check agent source

### Phase 3: Scale + History
10. History retention tuning (30-day default)
11. Dashboard aggregation queries (by system, domain, owner)
12. `status.changed` event consumers (Slack, Notifications, webhooks)
13. Performance testing at 100K entity scale

---

## Appendix A: Why Status is in the Entity (Not Separate)

Three alternatives were evaluated and rejected:

| Alternative | Why Rejected |
|---|---|
| **Separate status API** (`/api/status/:ref`) | Extra frontend fetch, loading state, consistency risk. Entity is single source of truth |
| **Status as annotations** | String-only, no queryability, annotation bloat with 5+ status items |
| **In-memory only (no persistence)** | Lost on restart. No history. No audit trail |

The entity field approach gives us: zero extra fetches, automatic permission inheritance, refresh survival, and aggregation queries via the existing catalog infrastructure.

## Appendix B: Type References

```ts
// @backstage/catalog-model/alpha — EXISTING, UNCHANGED
export type EntityStatus = { items?: EntityStatusItem[] };
export type EntityStatusItem = {
  type: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  error?: SerializedError;
};
export type EntityStatusLevel = 'info' | 'warning' | 'error';
export interface AlphaEntity extends Entity { status?: EntityStatus; }
```
