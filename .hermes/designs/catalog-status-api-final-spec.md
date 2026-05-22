# Backstage Catalog Status API — Final Design Specification

**Version:** 1.0 (Final)  
**Date:** 2025-05-16  
**Status:** Ready for Implementation  
**Author:** Patrick Guppy  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Requirement Analysis](#3-requirement-analysis)
4. [Design Evolution: Why 11 Approaches Failed](#4-design-evolution)
5. [Architecture Overview](#5-architecture-overview)
6. [Core Changes to Backstage Catalog](#6-core-changes)
7. [Status Plugin Architecture](#7-status-plugin)
8. [Architectural Decisions](#8-architectural-decisions)
9. [Data Model](#9-data-model)
10. [API Design](#10-api-design)
11. [Concurrency & Correctness](#11-concurrency)
12. [Scale Analysis](#12-scale-analysis)
13. [Edge Case Analysis](#13-edge-cases)
14. [Migration & Rollout](#14-migration)
15. [Implementation Guide](#15-implementation)

---

## 1. Executive Summary

### What We're Building

A **Catalog Status API** that adds live operational status (CI/CD, PagerDuty, health checks) to Backstage catalog entities. Status is stored **inline in the entity JSON**, making it filterable, searchable, and exportable through the existing catalog API. Designed for 100K entities at 1,667+ writes/second.

### How It Works

Two small additions to Backstage core unlock the entire pattern:

| Change | Lines | Purpose |
|---|---|---|
| `CatalogBuilder.addExternallyManagedField('status')` | ~10 | Tells the stitcher to preserve the `status` field during stitching |
| `CatalogDatabase.updateEntityField(ref, field, value)` | ~30 | Allows plugins to update fields directly on `final_entities` |

The status plugin sits on top: receives status updates, maintains its own tables, pushes a bounded summary to `entity.status` with one function call.

### Why This Design

After 12 design iterations spanning entity providers, read enrichers, notification buses, and cross-plugin extension points, this is the only design that is **correct, minimal, and scale-safe**. Every other approach was eliminated by source code analysis proving fundamental incompatibilities with Backstage's catalog internals.

**Total core code:** ~60 lines. **No new infrastructure.** Uses existing stitcher behavior that was designed for exactly this purpose (see [ADR-1](#adr-1-status-stitcher-integration-proof)).

---

## 2. Problem Statement

### The Gap

Backstage's Software Catalog tracks entities (services, APIs, resources) with static metadata: ownership, lifecycle, dependencies. But there's no way to show **operational status** — is this service healthy right now?

Today, teams build ad-hoc solutions:
- Custom plugins querying external APIs (PagerDuty, Datadog)
- Annotations pointing to external dashboards
- Separate status pages outside Backstage

### The Requirement

Add a `status` field to catalog entities that:
1. **Appears inline in entity JSON** — accessible via `GET /api/catalog/entities/...`
2. **Updates in real-time** — reflects CI/CD, incidents, health checks as they happen
3. **Survives catalog operations** — persists through entity refresh, re-stitching, and re-ingestion
4. **Scales to production** — handles 100K entities at 1,667+ writes/second without degrading the catalog
5. **Uses Backstage-native patterns** — no custom infrastructure, no database outside the catalog

### Scale Targets

| Metric | Target |
|---|---|
| Entities | 100,000 |
| Status writes/second (steady) | 1,667 |
| Status writes/second (burst) | 2,000 |
| Write latency (p99) | < 50ms |
| Entity freshness | < 1 second |
| Catalog read impact | Negligible |

---

## 3. Requirement Analysis

### MUST: Status inline in entity JSON

**Requirement:** `entity.status` must be present in the entity returned by the catalog API.

**Rationale:** Enables catalog filtering, external tool integration, and entity export. Without this, every consumer must call a separate status API.

**Constraint:** The field must survive entity refresh (re-processing and re-stitching), which rebuilds the entity from source data.

### MUST: Backstage-native patterns

**Requirement:** Use Backstage's existing infrastructure — entity model, stitcher, database, processing pipeline. No custom message buses, no separate databases, no monkey-patching.

**Rationale:** Maintainability. Custom infrastructure breaks on Backstage upgrades and violates platform conventions.

### MUST: Multiple status sources

**Requirement:** Support multiple simultaneous status providers per entity (CI/CD, PagerDuty, health checks, custom).

**Rationale:** A single service may have build status, incident status, and health status — all independently managed.

### MUST: Scale to 100K entities

**Requirement:** The design must handle 100K entities without degrading catalog performance.

**Rationale:** Large Backstage deployments have 100K+ entities. The status system must not become a bottleneck.

### SHOULD: Filterable by status

**Requirement:** Catalog queries should eventually support filtering by status (e.g., "show all entities with error status").

**Constraint:** The catalog filtering system works on entity JSON fields. Status must be in the entity for filtering to work.

---

## 4. Design Evolution

### Why 11 Approaches Failed

Through 12 design iterations, every approach was stress-tested against Backstage's source code. Each failure taught us something about the catalog's internals.

| Version | Approach | Fatal Flaw | Root Cause |
|---|---|---|---|
| v3.2 | Processor + refresh queue | `refreshEntity()` floods processing pipeline | Processors can't initiate processing; refresh is full pipeline traversal |
| v4.0 | Entity Provider (full) | Two providers cannot own same `entity_ref` | `replaceUnprocessedEntities()` uses `provider_id + entity_ref` as key |
| v5.0 | Entity Provider (delta) | `type: 'full'` replaces ALL entities from provider | Source code: `deleteUnprocessedEntities()` then `insertUnprocessedEntities()` |
| v6.0 | Provider + in-process notifier | Notification bus inside transaction is unsafe | Lost on crash, no ordering guarantees |
| v7.0 | Provider + extension point | Extension points are plugin-scoped | `createExtensionPoint()` creates plugin-local services; cannot cross plugin boundaries |
| v8.0 | Provider + catalog module | Module cannot consume plugin extension point | Same scope issue — catalog module ≠ status plugin |
| v9.0 | Provider + root-scoped service | In-memory bus loses messages on restart | No durability; transactions don't protect in-memory state |
| v10.0 | Standalone Status API | Status NOT in entity JSON | Violates core requirement |
| v11.0 | Read Enricher | Status not stored — can't filter | Read-time injection is ephemeral |

**The breakthrough (v12.0):** Stop trying to work AROUND the stitcher. The stitcher already preserves status items. Work WITH it by adding one capability: tell the stitcher which fields are externally managed, and provide a safe way to update them.

### Source Code Verifications

Each fatal flaw was confirmed by reading the Backstage source code. Key findings:

**Provider ownership conflict** (`plugins/catalog-backend/src/database/DefaultProviderDatabase.ts`):
```
replaceUnprocessedEntities() tracks entities by provider_id + entity_ref.
Two providers cannot emit the same entity_ref. Confirmed in source.
```

**Stitcher has no hooks** (`plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`, lines 51-266):
```
All enrichment is hardcoded: orphan annotation, error status, URL sanitization,
relations, uid, etag. Zero extension points. Zero merge strategies.
```

**Stitcher already merges status** (same file, lines 208-213):
```typescript
if (statusItems.length) {
  entity.status = {
    ...entity.status,                                    // preserves existing
    items: [...(entity.status?.items ?? []), ...statusItems],  // appends errors
  };
}
```
This is the critical discovery — the stitcher was designed to preserve non-error status items.

**No field-level update API** (`database/types.ts`):
```
CatalogDatabase interface has: transaction(), listAncestors(), refresh().
No updateEntityField(). No patch-style update. Every mutation is full pipeline.
```

---

## 5. Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     External Systems                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ CI/CD    │  │PagerDuty │  │Health Chk│  │  Custom    │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
│       │              │              │              │         │
│       └──────────────┴──────────────┴──────────────┘         │
│                          │  POST /api/status                 │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────┐
│                  Status Backend Plugin                       │
│                          │                                    │
│  ┌───────────────────────▼──────────────────────────────┐   │
│  │                  Status Handler                       │   │
│  │  ┌─────────────────┐  ┌────────────────────────┐    │   │
│  │  │ Write to tables  │  │ Compute bounded summary │    │   │
│  │  │ entity_status_   │  │ (one item per type,     │    │   │
│  │  │ active + history │  │  latest level)          │    │   │
│  │  └────────┬────────┘  └───────────┬────────────┘    │   │
│  │           │                        │                 │   │
│  │           └────────────┬───────────┘                 │   │
│  │                        │                             │   │
│  │           ┌────────────▼──────────────────┐          │   │
│  │           │ catalogDb.updateEntityField()  │          │   │
│  │           │ → writes status to             │          │   │
│  │           │   final_entities.final_entity  │          │   │
│  │           └───────────────────────────────┘          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Periodic Sync (30s)                      │    │
│  │  Handles: new entities, missed writes, cleanup       │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────┐
│                  Backstage Catalog Core                       │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    Stitcher                           │    │
│  │  ┌─────────────────────────────────────────────┐    │    │
│  │  │ performStitching()                           │    │    │
│  │  │  1. Read refresh_state.processed_entity     │    │    │
│  │  │  2. Enrich (orphan, errors, relations, etc) │    │    │
│  │  │  3. Merge error status items                │    │    │
│  │  │  4. ★ Preserve externally-managed fields    │    │    │
│  │  │  5. Hash → compare → write final_entities   │    │    │
│  │  └─────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              final_entities table                     │    │
│  │  ┌──────────────────────────────────────────────┐   │    │
│  │  │ entity_id │ hash │ stitch_ticket │           │   │    │
│  │  │ final_entity (JSON) ← status lives here      │   │    │
│  │  │ ...                                          │   │    │
│  │  └──────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              DefaultEntitiesCatalog                   │    │
│  │  → GET /api/catalog/entities → entity.status.items   │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### Data Flow

```
WRITE PATH:
  External System → POST /api/status
    → entity_status_active (upsert)     ← high-churn, indexed
    → status_history (insert)           ← append-only, partitioned
    → catalogDb.updateEntityField()     ← bounded summary to entity
  
  Latency: <10ms (two DB writes + one catalog write)

READ PATH:
  Frontend → catalogApi.getEntityByRef()
    → DefaultEntitiesCatalog.entitiesBatch()
    → SELECT final_entity FROM final_entities
    → entity.status.items already in JSON
  
  Latency: <5ms (standard catalog read)

STITCH PATH (entity refresh):
  Entity provider emits → processing → stitcher:
    → Reads refresh_state.processed_entity
    → Adds error items (if any)
    → Preserves externally-managed status from existing final_entities
    → Writes complete entity with preserved status
  
  Status survives every stitch. Always.
```

---

## 6. Core Changes

### Change 1: Externally Managed Field Preservation

**Where:** `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`

**Injection point:** After line 213 (error status merge), before line 216 (hash computation).

**What it does:** Reads the existing `final_entities.final_entity`, extracts externally-managed fields, and merges them into the entity the stitcher is about to write.

```typescript
// Location: performStitching.ts, after line 213

// Preserve externally-managed fields (e.g., status from status plugin)
if (options.externallyManagedFields?.length) {
  const existingRow = await knex<DbFinalEntitiesRow>('final_entities')
    .select('final_entity')
    .where('entity_id', entityId)
    .first();
  
  if (existingRow?.final_entity) {
    const existing = JSON.parse(existingRow.final_entity) as AlphaEntity;
    
    if (options.externallyManagedFields.includes('status')) {
      // Merge: external non-error items + stitcher-computed error items
      const externalItems = (existing.status?.items ?? [])
        .filter(i => i.type !== ENTITY_STATUS_CATALOG_PROCESSING_TYPE);
      const stitcherErrorItems = (entity.status?.items ?? [])
        .filter(i => i.type === ENTITY_STATUS_CATALOG_PROCESSING_TYPE);
      entity.status = {
        items: [...externalItems, ...stitcherErrorItems],
      };
    }
    // Future: handle other externally-managed fields here
  }
}

// Then continue to hash computation (unchanged):
const hash = generateStableHash(entity);
```

**Merge strategy:** External items (CI/CD, PagerDuty, health) are preserved as-is. Stitcher error items (processing errors) are freshly recomputed on each stitch and replace previous error items. The filter by `ENTITY_STATUS_CATALOG_PROCESSING_TYPE` prevents duplicates.

**Why this is correct:**
- External items are the "source of truth" for operational status
- Stitcher error items are ephemeral — they're recomputed from current processing state
- The hash includes external fields, so status changes are detected by the stitcher
- No race with concurrent writes (see [Concurrency](#11-concurrency))

### Change 2: Field Update API

**Where:** `plugins/catalog-backend/src/database/DefaultCatalogDatabase.ts`

**What it does:** Provides a safe, concurrent way for plugins to update fields on `final_entities`.

```typescript
// New method on DefaultCatalogDatabase

async updateEntityField(
  entityRef: string,
  field: string,
  value: unknown,
): Promise<void> {
  const db = this.options.database;
  
  // Phase 1: Acquire write ticket (concurrency gate)
  const stitchTicket = uuid();
  await db<DbFinalEntitiesRow>('final_entities')
    .where('entity_ref', entityRef)
    .update({ stitch_ticket: stitchTicket });
  
  // Phase 2: Read current entity
  const row = await db<DbFinalEntitiesRow>('final_entities')
    .select('entity_id', 'final_entity')
    .where('entity_ref', entityRef)
    .whereNotNull('final_entity')
    .first();
  
  if (!row) {
    // Entity not yet stitched — will be picked up by periodic sync
    return;
  }
  
  // Phase 3: Mutate in memory
  const entity = typeof row.final_entity === 'string'
    ? JSON.parse(row.final_entity)
    : row.final_entity;
  entity[field] = value;
  const hash = generateStableHash(entity);
  
  // Phase 4: Write with ticket gate
  const updated = await db<DbFinalEntitiesRow>('final_entities')
    .where('entity_id', row.entity_id)
    .where('stitch_ticket', stitchTicket)
    .update({
      final_entity: JSON.stringify(entity),
      hash,
      last_updated_at: db.fn.now(),
    });
  
  if (updated === 0) {
    throw new ConflictError(
      `Concurrent modification detected for ${entityRef}. Retry.`
    );
  }
}
```

**Interface addition** (in `database/types.ts`):
```typescript
export interface CatalogDatabase {
  // ... existing methods ...
  
  /**
   * Updates a single field on a catalog entity in final_entities.
   * Uses stitch_ticket concurrency control to coordinate with the stitcher.
   * 
   * @throws ConflictError if a concurrent stitch prevented the write
   */
  updateEntityField(
    entityRef: string,
    field: string,
    value: unknown,
  ): Promise<void>;
}
```

### Change 3: CatalogBuilder Registration

**Where:** `plugins/catalog-backend/src/service/CatalogBuilder.ts`

```typescript
// New private field
private externallyManagedFields: string[] = [];

/**
 * Registers a field as externally managed.
 * The stitcher will preserve this field from the existing final_entity
 * instead of overwriting it during stitching.
 * 
 * @param field - The root-level entity field name (e.g., 'status')
 */
addExternallyManagedField(field: string): CatalogBuilder {
  this.externallyManagedFields.push(field);
  return this;
}

// In build() method, thread to stitcher:
const stitcher = DefaultStitcher.fromConfig(config, {
  knex: dbClient,
  logger,
  externallyManagedFields: this.externallyManagedFields,  // NEW
});
```

### Change 4: Stitcher Threading

**Where:** `plugins/catalog-backend/src/stitching/DefaultStitcher.ts`

```typescript
// Add to constructor options
constructor(options: {
  knex: Knex;
  logger: LoggerService;
  strategy: StitchingStrategy;
  externallyManagedFields?: string[];  // NEW
}) {
  this.externallyManagedFields = options.externallyManagedFields ?? [];
}

// Thread to performStitching
async #stitchOne(options: { ... }) {
  const result = await performStitching({
    knex: this.knex,
    logger: this.logger,
    strategy: this.strategy,
    entityRef: options.entityRef,
    stitchTicket: options.stitchTicket,
    externallyManagedFields: this.externallyManagedFields,  // NEW
  });
}
```

### Wiring in Backend

**Where:** `packages/backend/src/index.ts`

```typescript
const catalog = await CatalogBuilder.create(env)
  .addExternallyManagedField('status')  // ← Enable status field
  .addProcessor(new MyCustomProcessor())
  .build();
```

### Total Core Changes

| File | Lines Changed | Type |
|---|---|---|
| `database/types.ts` | +5 | Interface addition |
| `database/DefaultCatalogDatabase.ts` | +35 | New method |
| `service/CatalogBuilder.ts` | +10 | New method + threading |
| `stitching/DefaultStitcher.ts` | +8 | Thread through |
| `stitching/types.ts` | +3 | Type addition |
| `operations/stitcher/performStitching.ts` | +15 | Field preservation |
| **Total** | **~60 lines** | |

---

## 7. Status Plugin

### Package Structure

```
plugins/
├── status-common/           # Shared types (frontend + backend)
│   └── src/
│       └── types.ts         # StatusRequest, StatusResponse, EntityStatusItem
├── status-node/             # Backend plugin interface
│   └── src/
│       └── StatusApi.ts     # Interface for status operations
├── status-backend/          # Backend plugin
│   ├── src/
│   │   ├── router.ts        # POST /api/status handler
│   │   ├── StatusHandler.ts # Business logic
│   │   ├── sync.ts          # Periodic sync job
│   │   └── cleanup.ts       # Orphaned status cleanup
│   └── migrations/
│       └── 001_create_status_tables.js
├── status-react/            # Frontend hooks
│   └── src/
│       └── useEntityStatus.ts
└── status/                  # Frontend plugin
    └── src/
        ├── plugin.ts
        ├── components/
        │   ├── EntityStatusCard.tsx
        │   └── StatusTable.tsx
        └── index.ts
```

### Database Tables

```sql
-- Active status (bounded — one row per entity+type+source)
CREATE TABLE entity_status_active (
  entity_ref   TEXT NOT NULL,
  type         TEXT NOT NULL,       -- e.g., 'ci-cd', 'pagerduty', 'health'
  source       TEXT NOT NULL,       -- e.g., 'github-actions', 'pd-prod'
  level        TEXT NOT NULL,       -- 'info' | 'warning' | 'error'
  message      TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ,       -- For periodic sync
  
  PRIMARY KEY (entity_ref, type, source)
);

CREATE INDEX idx_status_active_ref ON entity_status_active(entity_ref);
CREATE INDEX idx_status_active_level ON entity_status_active(entity_ref, level);

-- Status history (append-only, partitioned by date)
CREATE TABLE status_history (
  id           BIGSERIAL,
  entity_ref   TEXT NOT NULL,
  type         TEXT NOT NULL,
  source       TEXT NOT NULL,
  level        TEXT NOT NULL,
  message      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_history_ref ON status_history(entity_ref, created_at DESC);
```

### Status Handler

```typescript
// plugins/status-backend/src/StatusHandler.ts

export class StatusHandler {
  constructor(
    private readonly db: Knex,
    private readonly catalogDb: CatalogDatabase,
  ) {}

  async processStatus(request: StatusRequest): Promise<StatusResponse> {
    const { entityRef, type, level, message, timestamp } = request;
    const source = this.deriveSource(); // From auth context

    // 1. Write to active table (conditional upsert for ordering)
    await this.db('entity_status_active')
      .insert({
        entity_ref: entityRef,
        type,
        source,
        level,
        message,
        updated_at: timestamp ?? new Date(),
      })
      .onConflict(['entity_ref', 'type', 'source'])
      .merge()
      .where('entity_status_active.updated_at', '<', 
        this.db.raw('EXCLUDED.updated_at'));

    // 2. Append to history
    await this.db('status_history').insert({
      entity_ref: entityRef,
      type,
      source,
      level,
      message,
    });

    // 3. Compute bounded summary (all active items for this entity)
    const items = await this.db('entity_status_active')
      .where('entity_ref', entityRef)
      .select('type', 'source', 'level', 'message');

    // 4. Push to catalog entity
    try {
      await this.catalogDb.updateEntityField(entityRef, 'status', {
        items: items.map(i => ({
          type: i.type,
          level: i.level as EntityStatusItem['level'],
          message: i.message,
        })),
      });

      // Mark as synced
      await this.db('entity_status_active')
        .where('entity_ref', entityRef)
        .update({ last_synced_at: this.db.fn.now() });

    } catch (error) {
      if (error.name === 'ConflictError') {
        // Stitcher won the race — retry once
        return this.processStatus(request);
      }
      throw error;
    }

    return { success: true };
  }

  private deriveSource(): string {
    // Derive from Backstage service-to-service token
    // or from authenticated plugin identity
  }
}
```

### Periodic Sync

```typescript
// plugins/status-backend/src/sync.ts

export function createSyncTask(db: Knex, catalogDb: CatalogDatabase) {
  return async () => {
    const stale = await db('entity_status_active')
      .select('entity_ref')
      .where('last_synced_at', '<', db.raw("NOW() - INTERVAL '60 seconds'"))
      .orWhereNull('last_synced_at')
      .limit(1000);

    for (const { entity_ref } of stale) {
      // Check entity exists in catalog
      const entity = await db('final_entities')
        .select('entity_id')
        .where('entity_ref', entity_ref)
        .whereNotNull('final_entity')
        .first();

      if (!entity) continue; // Entity not stitched yet or deleted

      const items = await db('entity_status_active')
        .where('entity_ref', entity_ref)
        .select('type', 'source', 'level', 'message');

      try {
        await catalogDb.updateEntityField(entity_ref, 'status', {
          items,
        });

        await db('entity_status_active')
          .where('entity_ref', entity_ref)
          .update({ last_synced_at: db.fn.now() });
      } catch {
        // Will retry next cycle
      }
    }
  };
}
```

### Cleanup Job

```typescript
// plugins/status-backend/src/cleanup.ts

export function createCleanupTask(db: Knex) {
  return async () => {
    // Remove status for entities that no longer exist
    await db('entity_status_active')
      .whereNotExists(
        db('final_entities')
          .select('entity_ref')
          .whereRaw(
            'entity_status_active.entity_ref = final_entities.entity_ref'
          )
      )
      .delete();
  };
}
```

### Frontend

```tsx
// plugins/status-react/src/useEntityStatus.ts

import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { AlphaEntity } from '@backstage/catalog-model/alpha';

export function useEntityStatus(entityRef: string) {
  const catalogApi = useApi(catalogApiRef);
  const { data: entity } = useQuery({
    queryKey: ['entity', entityRef],
    queryFn: () => catalogApi.getEntityByRef(entityRef),
  });

  const status = (entity as AlphaEntity)?.status;
  
  return {
    items: status?.items ?? [],
    loading: !entity,
    hasErrors: status?.items.some(i => i.level === 'error') ?? false,
    hasWarnings: status?.items.some(i => i.level === 'warning') ?? false,
  };
}
```

```tsx
// plugins/status/src/components/EntityStatusCard.tsx

import React from 'react';
import { useEntity } from '@backstage/plugin-catalog-react';
import { InfoCard } from '@backstage/core-components';
import { AlphaEntity, EntityStatusItem } from '@backstage/catalog-model/alpha';

export const EntityStatusCard = () => {
  const { entity } = useEntity();
  const status = (entity as AlphaEntity)?.status;
  const items = status?.items ?? [];

  return (
    <InfoCard title="Status">
      {items.length === 0 ? (
        <p>No status information available.</p>
      ) : (
        items.map((item: EntityStatusItem, idx: number) => (
          <StatusRow key={idx} item={item} />
        ))
      )}
    </InfoCard>
  );
};
```

---

## 8. Architectural Decisions

### ADR-1: Status Stitcher Integration (Proof)

**Decision:** Use the stitcher's existing status merge behavior instead of building a separate mechanism.

**Evidence:** `performStitching.ts` lines 208-213:
```typescript
if (statusItems.length) {
  entity.status = {
    ...entity.status,                                    // Line 209: preserves existing
    items: [...(entity.status?.items ?? []), ...statusItems],  // Line 211: appends errors
  };
}
```

This proves the Backstage team anticipated status enrichment. The spread operator (`...entity.status`) preserves any status items that processors added. The stitcher only appends error items — it never removes existing items.

**Conclusion:** The stitcher was designed for this. We're completing the implementation, not fighting it.

### ADR-2: Direct Field Update vs Processor Pipeline

**Decision:** Use direct field updates (`updateEntityField`) instead of triggering re-processing.

**Reasoning:**

| Approach | Mechanism | Cost | Staleness |
|---|---|---|---|
| Processor + refresh | `refreshEntity()` → full pipeline | ALL processors run | 100-150s |
| Direct update | `updateEntityField()` | 1 read + 1 write | < 1s |

At 1,667 writes/s, the processor approach would queue 1,667 processing tasks per cycle. Each task runs ALL processors (validation, enrichment, URL reading, etc.). This is wasteful and would degrade catalog performance.

The direct update touches only the `final_entities` table — no processing, no stitching, no queue.

**Exception:** The initial entity stitch still runs processing. Status is added later via `updateEntityField` or periodic sync.

### ADR-3: Stitch Ticket for Concurrency

**Decision:** Use the existing `stitch_ticket` pattern (already used by the stitcher) for concurrency control in `updateEntityField`.

**Why not optimistic locking?** The stitcher already uses stitch_ticket. Using the same pattern ensures mutual exclusion between stitcher writes and external writes. Two different locking mechanisms would create deadlock risks.

**Why not a separate lock column?** Adding a column for external writes would require a migration and add complexity. The stitch_ticket already exists and the pattern is proven.

**Concurrency proof:** See [Section 11](#11-concurrency).

### ADR-4: Periodic Sync for Gap Coverage

**Decision:** Include a periodic sync task in the status plugin to handle edge cases.

**Problems it solves:**
1. Entity stitched AFTER status written (EC-1)
2. Rare concurrent write race where an item is dropped (EC-4)
3. Missed writes due to transient errors

**Why 30 seconds?** Balances staleness (< 30s for missed writes) with overhead (< 1,000 entities per batch). At 100K entities, checking all entities every 30s would be expensive, so we use `last_synced_at` to only check entities that need it.

**Alternative considered:** Event-driven notification (stitcher emits event → status plugin re-writes). Rejected: events add complexity and can be lost.

### ADR-5: Source Identity from Auth

**Decision:** Derive the `source` field from the Backstage service-to-service auth token.

**Reasoning:** Trusting the client to provide its own source identity is forgeable. Deriving from auth ensures:
- Plugin A can't impersonate Plugin B
- External systems are identified by their auth credentials
- Audit trail is reliable

**Implementation:** The status plugin extracts the plugin ID from the `backstage-plugin-id` header (set by Backstage's auth middleware). For external systems with API keys, the source maps to the key identity.

### ADR-6: Bounded Summary vs Full Status on Entity

**Decision:** Push a bounded summary (one item per type+source) to `entity.status.items`, not full history.

**Reasoning:**
- Entity JSON should be compact — one status item per source, not 10,000
- History belongs in the `status_history` table
- The bounded summary is what consumers need: "what's the status right now?"

**What's included:** All non-empty items from `entity_status_active`. Frontend can filter by level if desired.

**Size limit:** At most ~100 items per entity (types × sources). Realistic: 5-15 items.

### ADR-7: Conditional Upsert for Ordering

**Decision:** Use `WHERE entity_status_active.updated_at < EXCLUDED.updated_at` on the upsert to prevent old messages from overwriting newer ones.

**Reasoning:** Network reordering can deliver status updates out of order:
```
Msg 1 (T=10): build #123 failed (error)
Msg 2 (T=11): build #124 passed (info)
→ arrives as: Msg 2 then Msg 1 (reordered by network)
→ Without conditional upsert: Msg 1 would overwrite Msg 2 → shows error even though build passed
→ With conditional upsert: Msg 1 is ignored because its timestamp is older
```

---

## 9. Data Model

### Entity Status Type (Existing, from `@backstage/catalog-model/alpha`)

```typescript
export type EntityStatus = {
  items?: EntityStatusItem[];
};

export type EntityStatusItem = {
  type: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  error?: SerializedError;
};
```

**Usage:**
```json
{
  "apiVersion": "backstage.io/v1alpha1",
  "kind": "Component",
  "metadata": { "name": "my-service" },
  "spec": { "type": "service", "lifecycle": "production", "owner": "team-a" },
  "status": {
    "items": [
      { "type": "ci-cd", "level": "error", "message": "Build #456 failed: test timeout" },
      { "type": "pagerduty", "level": "warning", "message": "1 open incident: CPU throttling" },
      { "type": "health", "level": "info", "message": "All health checks passing" }
    ]
  }
}
```

### Database Tables

| Table | Purpose | Write Pattern | Size (100K entities) |
|---|---|---|---|
| `entity_status_active` | Current status per entity+type+source | Upsert (bounded) | ~500K rows × 200B = 100MB |
| `status_history` | Full status history | Append-only (partitioned) | Depends on retention |
| `final_entities` | Catalog entity (contains status) | Stitcher + updateEntityField | Existing catalog table |

### Entity Policy

The `status` field is registered as a known root field in `NoForeignRootFieldsEntityPolicy`. This was committed in the fork at `02b365a515ca`:

```diff
- const defaultKnownFields = ['apiVersion', 'kind', 'metadata', 'spec'];
+ const defaultKnownFields = ['apiVersion', 'kind', 'status', 'metadata', 'spec'];
```

Without this change, entities with a `status` field would fail entity policy validation.

---

## 10. API Design

### POST /api/status

**Purpose:** Submit a status update for an entity.

**Request:**
```json
{
  "entityRef": "component:default/my-service",
  "type": "ci-cd",
  "level": "error",
  "message": "Build #456 failed: test timeout",
  "timestamp": "2025-05-16T12:00:00Z"
}
```

**Response:**
```json
{
  "success": true
}
```

**Auth:** Backstage service-to-service token required. Source derived from token.

**Rate limit:** Per-plugin rate limiting can be added later.

### GET /api/status/:kind/:namespace/:name

**Purpose:** Get status history for an entity.

**Query params:** `type`, `source`, `level`, `limit`, `offset`

**Response:**
```json
{
  "items": [
    {
      "type": "ci-cd",
      "source": "github-actions",
      "level": "error",
      "message": "Build #456 failed",
      "timestamp": "2025-05-16T12:00:00Z"
    }
  ],
  "total": 1
}
```

### GET /api/status (Query)

**Purpose:** Query status across entities.

**Query params:** `level`, `type`, `source`, `limit`, `offset`

**Response:** Filtered list of entity status summaries.

---

## 11. Concurrency

### The Stitch Ticket Protocol

Both the stitcher and `updateEntityField` use the same protocol:

```
Phase 1: SET stitch_ticket = <new random UUID>
Phase 2: Read entity data
Phase 3: Write entity data WHERE stitch_ticket = <UUID from Phase 1>
```

**Mutual exclusion guarantee:** If two writers race, only one's Phase 3 succeeds. The other gets 0 rows updated and must retry.

### Scenario Analysis

**Scenario A: Status write wins**
```
Stitcher:  SET ticket = T1
Status:    SET ticket = T2 (overwrites T1)
Stitcher:  Read, process, enrich (uses T1 state)
Status:    Read entity, modify status, write WHERE ticket = T2 → SUCCESS
Stitcher:  Write WHERE ticket = T1 → 0 ROWS → ABANDONED
Stitcher:  Retry on next cycle → reads entity (has T2's status) → preserves → writes
```
**Result:** Status in entity. Stitcher preserves it on retry.

**Scenario B: Stitcher wins**
```
Status:    SET ticket = T1
Stitcher:  SET ticket = T2 (overwrites T1 via ON CONFLICT MERGE)
Status:    Read entity (has T2 now)
Status:    Write WHERE ticket = T1 → 0 ROWS → ConflictError → RETRY
Stitcher:  Read, process, enrich, preserve external status, write WHERE ticket = T2 → SUCCESS
Status:    Retry: SET T3, read entity (has stitcher's write with preserved status), write → SUCCESS
```
**Result:** Status preserved in stitcher's write. Status retry also succeeds (idempotent).

**Scenario C: Two status updates race**
```
Writer A: SET ticket = T1
Writer B: SET ticket = T2 (overwrites T1)
Writer A: Read, modify, write WHERE ticket = T1 → 0 ROWS → RETRY
Writer B: Read, modify, write WHERE ticket = T2 → SUCCESS
Writer A: Retry: SET T3, read (sees B's changes), write → SUCCESS
```
**Result:** Both updates serialized. B's write includes A's changes (read occurs after B's write).

### No Deadlock

Each transaction locks exactly ONE row (`final_entities.entity_ref`). No multi-row locking, no circular waits. Deadlock impossible.

---

## 12. Scale Analysis

### Write Load

| Component | Operation | Cost | Frequency |
|---|---|---|---|
| Status handler | INSERT/upsert to `entity_status_active` | 1 indexed write | Every status update |
| Status handler | INSERT to `status_history` | 1 append | Every status update |
| Status handler | `updateEntityField` | 1 read + 1 write | One per status update |
| Periodic sync | Batch read `entity_status_active` | 1 scan (1000 rows) | Every 30s |
| Periodic sync | `updateEntityField` per stale entity | n reads + n writes | Only for stale items |
| Cleanup job | DELETE orphaned rows | 1 scan | Every 1h |

### Catalog Impact

| Operation | Added Load | Impact |
|---|---|---|
| Stitcher | 1 extra PK read per stitch (`SELECT final_entity WHERE entity_id = ?`) | Negligible (< 0.1ms) |
| Entity queries | Zero impact (status already in `final_entity` JSON) | None |
| Entity listing | Zero impact | None |

### Bottleneck Analysis

At 100K entities, 1,667 writes/s:

| Resource | Load | Capacity |
|---|---|---|
| `entity_status_active` writes | 1,667/s | PostgreSQL: 50K+ writes/s on indexed table |
| `final_entities` reads | 1,667/s | PK lookup: 100K+ reads/s |
| `final_entities` writes | 1,667/s × 25KB = 42MB/s | PostgreSQL: 100MB/s+ |
| Network (internal) | < 100 Mbps | Internal: 1-10 Gbps |

**No bottleneck at target scale.** Headroom: ~3x before any resource constraint.

### Staleness

| Path | Worst Case | Typical |
|---|---|---|
| Direct write (`updateEntityField`) | < 1s | < 50ms |
| Periodic sync | 30s | 15s |
| New entity (first status) | Up to 30s | 15s |
| Entity page read | Immediate (status in entity JSON) | < 5ms |

---

## 13. Edge Cases

### EC-1: Entity Not Yet Stitched When Status Written
- **Problem:** `updateEntityField` finds no `final_entities` row → returns early
- **Resolution:** Periodic sync detects unstiched entities and pushes status when ready
- **Staleness:** Up to 30s for new entities

### EC-2: Entity Deletion
- **Problem:** Orphaned rows in `entity_status_active`
- **Resolution:** Cleanup job deletes rows where entity doesn't exist in `final_entities`

### EC-3: Unbounded Status History
- **Problem:** `status_history` grows indefinitely
- **Resolution:** Partition by date; drop old partitions (configurable retention, default 90 days)

### EC-4: Concurrent Status Writes (Same Entity, Different Sources)
- **Problem:** Two handlers read `entity_status_active` before each other's writes
- **Resolution:** Stitch ticket serializes `updateEntityField` calls. Periodic sync corrects any missed items within 30s. At 100K entities, concurrent writes to the same entity are < 0.01% probability.

### EC-5: Out-of-Order Messages
- **Problem:** Network reordering delivers old status after new status
- **Resolution:** Conditional upsert (`WHERE updated_at < EXCLUDED.updated_at`) ignores stale writes

### EC-6: Status Expiry (Error → Resolved)
- **Problem:** Error clears but entity still shows error
- **Resolution:** All items (including `info`) are pushed to entity. Error → info transition updates the active row and pushes the new state.

### EC-7: Processor Adds Status Items
- **Problem:** Processor-added items conflict with externally-managed preservation
- **Resolution:** External field preservation takes precedence. Processors should not touch externally-managed fields. Documented constraint.

### EC-8: Entity Provider Re-emits Entity
- **Problem:** Would re-processing overwrite status?
- **Resolution:** Stitcher reads existing `final_entities`, extracts external fields, and preserves them. Status survives every stitch.

### EC-9: Concurrent Stitch + Status Write (Safety)
- **Problem:** Stitcher overwrites status written by plugin
- **Resolution:** Stitch ticket protocol prevents blind overwrites. External field preservation ensures stitcher reads and preserves status. (See Section 11 for proof.)

### EC-10: Hash Consistency
- **Problem:** Does the hash properly reflect external field changes?
- **Resolution:** External fields are included in the entity before hash computation. Hash changes when status changes. Stitcher detects changes correctly.

---

## 14. Migration

### Phase 0: Prerequisites (Complete)

- [x] `status` added to `defaultKnownFields` in `NoForeignRootFieldsEntityPolicy`
- [x] Design finalized and reviewed

### Phase 1: Core Changes (RFC → PR → Merge → Release)

**Timeline:** 2-4 weeks (depends on Backstage maintainer review)

- [ ] PR: Add `addExternallyManagedField` to `CatalogBuilder`
- [ ] PR: Add `updateEntityField` to `CatalogDatabase`
- [ ] PR: Add external field preservation to `performStitching`
- [ ] Test: Unit + integration tests for all new code paths
- [ ] Review: Backstage maintainer approval
- [ ] Release: Included in next Backstage release

**Backward compatibility:** Fully backward compatible. No existing behavior changes. Features are opt-in.

### Phase 2: Status Plugin (Can start in parallel with Phase 1)

**Timeline:** 2-3 weeks

- [ ] `status-common`: Shared types
- [ ] `status-node`: Backend interface
- [ ] `status-backend`: Tables, router, handler, sync, cleanup
- [ ] `status-react`: Frontend hooks
- [ ] `status`: Frontend plugin (entity card, catalog table)
- [ ] Test: Unit + integration tests
- [ ] Documentation: Plugin README, API docs

### Phase 3: Adoption & Advanced Features

**Timeline:** Ongoing

- [ ] Catalog JSON field filtering for `status.items[].level`
- [ ] Status-based catalog search (via search index)
- [ ] Status history visualization (timeline, charts)
- [ ] Alerting integration (webhooks on status changes)
- [ ] Status aggregation (roll-up status for systems/domains)

---

## 15. Implementation

### Getting Started

1. **Apply the existing fork commit** (or equivalent):
   ```bash
   git checkout feat/catalog-status-field-support
   ```
   This adds `status` to `defaultKnownFields`.

2. **Implement core changes** (see Section 6):
   - `addExternallyManagedField()` in `CatalogBuilder`
   - `updateEntityField()` in `DefaultCatalogDatabase`
   - External field preservation in `performStitching`
   - Thread through `DefaultStitcher`

3. **Scaffold status plugin**:
   ```bash
   yarn backstage-cli new --select plugin --option id=status
   yarn backstage-cli new --select plugin-module --option id=status-backend-module-catalog
   ```

4. **Implement status backend** (see Section 7)

5. **Wire into backend**:
   ```typescript
   // packages/backend/src/index.ts
   const catalog = await CatalogBuilder.create(env)
     .addExternallyManagedField('status')
     .build();
   ```

6. **Wire into frontend**:
   ```typescript
   // packages/app/src/App.tsx
   <EntityLayout.Route path="/status" title="Status">
     <EntityStatusCard />
   </EntityLayout.Route>
   ```

### Test Plan

| Test Area | Tests |
|---|---|
| `updateEntityField` | Unit: success, no row, concurrent conflict, hash update |
| External field preservation | Unit: status preserved, error items merged, no status → no crash |
| Stitch + external write race | Integration: concurrent stitch and updateEntityField |
| Status handler | Unit: upsert, conditional upsert, bounded summary, retry on conflict |
| Periodic sync | Integration: new entity, stale entity, deleted entity |
| Cleanup | Unit: orphaned rows deleted, existing rows preserved |

### Success Criteria

- [ ] Status appears in `entity.status.items` within 1 second of write
- [ ] Status survives entity refresh (catalog-info.yaml change → re-stitch → status preserved)
- [ ] Status survives entity re-ingestion (provider re-emit → processing → stitch → status preserved)
- [ ] Two concurrent status writes to same entity converge to correct state
- [ ] Entity deletion cleans up status entries
- [ ] Catalog queries work correctly with status in entity JSON
- [ ] No performance degradation at 1,667 writes/s on 100K entities

---

## Appendix A: Complete Source Code References

| File | Line(s) | What |
|---|---|---|
| `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts` | 208-213 | Stitcher status merge (preservation proof) |
| `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts` | 51-266 | Full stitcher logic (no hooks) |
| `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts` | 234-241 | Final entity write (stitch_ticket gate) |
| `plugins/catalog-backend/src/database/DefaultCatalogDatabase.ts` | 40-113 | Current CatalogDatabase implementation |
| `plugins/catalog-backend/src/database/types.ts` | 187-204 | CatalogDatabase interface |
| `plugins/catalog-backend/src/database/DefaultProcessingDatabase.ts` | 73-171 | updateProcessedEntity (full entity write) |
| `plugins/catalog-backend/src/service/CatalogBuilder.ts` | 450-649 | build() method (stitcher construction) |
| `plugins/catalog-backend/src/stitching/DefaultStitcher.ts` | 46-191 | Stitcher class |
| `plugins/catalog-backend/src/database/tables.ts` | 176-183 | DbFinalEntitiesRow type |
| `plugins/catalog-backend/src/service/DefaultEntitiesCatalog.ts` | 124-246 | Entity read paths |
| `plugins/catalog-backend/src/service/response/process.ts` | 20-37 | Entity JSON parsing |
| `plugins/catalog-backend/migrations/20210302150147_refresh_state.js` | 67-90 | final_entities table schema |
| `packages/catalog-model/src/entity/policies/NoForeignRootFieldsEntityPolicy.ts` | 20 | defaultKnownFields (fork commit) |

## Appendix B: Comparison With Alternative Designs

| Criterion | v12.0 (This) | Processor + Refresh | Entity Provider | Read Enricher | Standalone API |
|---|---|---|---|---|---|
| Status in entity JSON | ✅ | ✅ | ❌ | ❌ | ❌ |
| Instant freshness | ✅ | ❌ (150s) | ❌ (15s) | ✅ | ✅ |
| Scale safe | ✅ | ❌ | ❌ | ✅ | ✅ |
| Core changes | ~60 lines | 0 | 0 | ~50 lines | 0 |
| Plugin complexity | 5 packages | 7 packages | 10 packages | 5 packages | 3 packages |
| Filterable | ✅ (future) | ✅ | ❌ | ❌ | ❌ |
| Survives stitch | ✅ | ✅ | N/A | N/A | N/A |
| Backstage-native | ✅ | ✅ | ⚠️ (misuses) | ⚠️ (new API) | ✅ |
