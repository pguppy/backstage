# Backstage Catalog Status API — Final Design Specification (v2.0)

**Version:** 2.0  
**Date:** 2025-05-16  
**Status:** Ready for Implementation  
**Changes from v1.0:** EventsService ingestion, pluggable translators, catalog module pattern  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Core Changes to Backstage Catalog](#3-core-changes)
4. [Catalog Module: `catalog-backend-module-status`](#4-catalog-module)
5. [Extension Point: `StatusEventTranslator`](#5-extension-point)
6. [Frontend Plugin: `catalog-plugin-status`](#6-frontend-plugin)
7. [Architectural Decisions](#7-architectural-decisions)
8. [Data Model](#8-data-model)
9. [Event Flow](#9-event-flow)
10. [Concurrency & Correctness](#10-concurrency)
11. [Scale Analysis](#11-scale-analysis)
12. [Edge Case Analysis](#12-edge-cases)
13. [Package Structure](#13-package-structure)
14. [Migration & Rollout](#14-migration)
15. [Implementation Guide](#15-implementation)
16. [Appendix: Why All Previous Approaches Failed](#16-appendix)

---

## 1. Executive Summary

### What We're Building

A **Catalog Status system** that adds live operational status (CI/CD, PagerDuty, health checks) to Backstage catalog entities. Status is stored **inline in the entity JSON**, making it filterable, searchable, and exportable through the existing catalog API.

### How It Works

```
External System → POST /api/events/http/catalog.status
  → EventsService (existing Backstage infra)
    → catalog-backend-module-status subscribes
      → StatusEventTranslators transform events
        → StatusWriter writes to tables + updateEntityField()
          → entity.status appears in catalog API
```

Three components:

| Component | What It Is | Where It Lives |
|---|---|---|
| Core changes (2 APIs, ~60 lines) | `addExternallyManagedField` + `updateEntityField` | Catalog backend core |
| `catalog-backend-module-status` | Event subscriber + translators + writer | Catalog backend module |
| `catalog-plugin-status` | Frontend UI (EntityStatusCard) | Frontend plugin |

### Why This Design

- **No custom HTTP API** — uses Backstage's built-in EventsService with HTTP ingress
- **No cross-plugin calls** — module runs inside catalog backend process
- **Pluggable** — translators are registered via extension points, like CatalogProcessors
- **Minimal** — 2 core changes (~60 lines) + 1 module + 1 frontend plugin
- **Scale safe** — direct DB writes, no processing pipeline overhead

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                     External Systems                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐        │
│  │ CI/CD    │  │PagerDuty │  │Health Chk│  │  Custom    │        │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘        │
│       │              │              │              │               │
│       └──────────────┴──────────────┴──────────────┘               │
│                          │  POST /api/events/http/catalog.status   │
└──────────────────────────┼────────────────────────────────────────┘
                           │
┌──────────────────────────┼────────────────────────────────────────┐
│              Backstage Events Backend (EXISTING)                    │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │  HttpPostIngressEventPublisher                             │     │
│  │  - Receives HTTP POST at /api/events/http/:topic          │     │
│  │  - Validates, publishes to EventsService                   │     │
│  └──────────────────────┬───────────────────────────────────┘     │
│                         │ EventsService.publish(topic, payload)    │
└─────────────────────────┼─────────────────────────────────────────┘
                          │
┌─────────────────────────┼─────────────────────────────────────────┐
│           Catalog Backend Process                                  │
│                                                                     │
│  ┌──────────────────────┴─────────────────────────────────────┐   │
│  │          catalog-backend-module-status                       │   │
│  │                                                              │   │
│  │  ┌──────────────────────────────────────────────────────┐  │   │
│  │  │  EventsService.subscribe({                            │  │   │
│  │  │    topics: ['catalog.status'],                        │  │   │
│  │  │    onEvent: dispatchToTranslators                     │  │   │
│  │  │  })                                                   │  │   │
│  │  └──────────────────────┬───────────────────────────────┘  │   │
│  │                         │                                    │   │
│  │  ┌──────────────────────▼───────────────────────────────┐  │   │
│  │  │  StatusEventTranslators (extension point)              │  │   │
│  │  │  ┌─────────────────────────────────────────────────┐  │  │   │
│  │  │  │ GitHubActionsStatusTranslator                    │  │  │   │
│  │  │  │ PagerDutyStatusTranslator                        │  │  │   │
│  │  │  │ HealthCheckStatusTranslator                      │  │  │   │
│  │  │  │ CustomStatusTranslator (user-defined)            │  │  │   │
│  │  │  └─────────────────────────────────────────────────┘  │  │   │
│  │  └──────────────────────┬───────────────────────────────┘  │   │
│  │                         │ EntityStatusItem[]                 │   │
│  │  ┌──────────────────────▼───────────────────────────────┐  │   │
│  │  │  StatusWriter                                          │  │   │
│  │  │  ┌─────────────────┐  ┌──────────────────────────┐   │  │   │
│  │  │  │entity_status_    │  │ updateEntityField()       │   │  │   │
│  │  │  │active (upsert)   │  │ → final_entities          │   │  │   │
│  │  │  └─────────────────┘  └──────────────────────────┘   │  │   │
│  │  └──────────────────────────────────────────────────────┘  │   │
│  │                                                              │   │
│  │  ┌──────────────────────────────────────────────────────┐  │   │
│  │  │  Scheduled Tasks                                       │  │   │
│  │  │  - Periodic Sync (30s): push stale status to catalog  │  │   │
│  │  │  - Cleanup (1h): remove orphaned status entries       │  │   │
│  │  └──────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Catalog Backend Core (EXISTING + 2 NEW APIs)                 │   │
│  │  ┌─────────────────────────────────────────────────────────┐ │   │
│  │  │  CatalogBuilder.addExternallyManagedField('status')      │ │   │
│  │  │  CatalogDatabase.updateEntityField(ref, field, value)    │ │   │
│  │  │  Stitcher: preserve external fields during stitching     │ │   │
│  │  └─────────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  final_entities table                                          │   │
│  │  entity.status.items → [ci_status, pd_status, health_status]  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                          │
                          │ GET /api/catalog/entities/...
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Frontend                                                            │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  catalog-plugin-status                                         │   │
│  │  - EntityStatusCard (reads entity.status from catalog API)     │   │
│  │  - StatusTable (catalog table column)                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
WRITE PATH:
  External System → POST /api/events/http/catalog.status
    → EventsService → module subscriber
    → Translator.getEntityRef(payload) → entityRef
    → Translator.translate(payload) → EntityStatusItem[]
    → StatusWriter:
        → entity_status_active (upsert, conditional on timestamp)
        → status_history (append)
        → updateEntityField(entityRef, 'status', boundedSummary)
  
  Latency: <50ms (event bus + 2 DB writes + 1 catalog write)
  All in-process. No HTTP between components.

READ PATH:
  Frontend → catalogApi.getEntityByRef()
    → DefaultEntitiesCatalog.entitiesBatch()
    → SELECT final_entity FROM final_entities
    → entity.status.items already in JSON
  
  Latency: <5ms (standard catalog read)

STITCH PATH (entity refresh):
  Entity provider emits → processing → stitcher:
    → Reads refresh_state.processed_entity
    → Adds error status items (if any)
    → Preserves externally-managed status from final_entities
    → Writes complete entity with preserved status
  
  Status survives every stitch. Always.
```

---

## 3. Core Changes

### 3.1 Externally Managed Field Preservation

**Where:** `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`

**Injection:** After line 213, before line 216 (hash computation).

```typescript
// After stitcher enrichments (lines 171-213), before hash (line 216):

// Preserve externally-managed fields from existing final_entity
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
  }
}

// Then: const hash = generateStableHash(entity);  // (unchanged)
```

**Merge strategy:** External items (CI/CD, PagerDuty, health) preserved as-is. Stitcher error items (processing errors) freshly recomputed per stitch. No duplicates.

**Proof of correctness:** The stitcher already merges status at lines 208-213. Our code runs after that merge, preserving non-error items from the stored entity. The `ENTITY_STATUS_CATALOG_PROCESSING_TYPE` filter prevents duplicate error items.

### 3.2 Field Update API

**Where:** `plugins/catalog-backend/src/database/DefaultCatalogDatabase.ts`

```typescript
async updateEntityField(
  entityRef: string,
  field: string,
  value: unknown,
): Promise<void> {
  const db = this.options.database;
  
  // Phase 1: Acquire stitch ticket (concurrency gate)
  const stitchTicket = uuid();
  await db<DbFinalEntitiesRow>('final_entities')
    .where('entity_ref', entityRef)
    .update({ stitch_ticket: stitchTicket });
  
  // Phase 2: Read current entity (only if stitched)
  const row = await db<DbFinalEntitiesRow>('final_entities')
    .select('entity_id', 'final_entity')
    .where('entity_ref', entityRef)
    .whereNotNull('final_entity')
    .first();
  
  if (!row) {
    return; // Entity not yet stitched — periodic sync will pick it up
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

**Interface addition** (`database/types.ts`):
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

### 3.3 CatalogBuilder Registration

**Where:** `plugins/catalog-backend/src/service/CatalogBuilder.ts`

```typescript
private externallyManagedFields: string[] = [];

/**
 * Registers a field as externally managed.
 * The stitcher will preserve this field from the existing final_entity
 * instead of overwriting it during stitching.
 */
addExternallyManagedField(field: string): CatalogBuilder {
  this.externallyManagedFields.push(field);
  return this;
}

// In build():
const stitcher = DefaultStitcher.fromConfig(config, {
  knex: dbClient,
  logger,
  externallyManagedFields: this.externallyManagedFields,
});
```

### 3.4 Stitcher Threading

**Where:** `plugins/catalog-backend/src/stitching/DefaultStitcher.ts`

```typescript
// Constructor: accept externallyManagedFields
// #stitchOne(): pass to performStitching
```

**Total core changes: ~60 lines across 5 files.**

---

## 4. Catalog Module

### 4.1 Module Entry Point

**Package:** `plugins/catalog-backend-module-status`  
**File:** `src/module.ts`

```typescript
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { eventsServiceRef } from '@backstage/plugin-events-node';
import { statusTranslationExtensionPoint } from './extension';
import { StatusWriter } from './StatusWriter';
import { GenericStatusTranslator } from './translators/GenericStatusTranslator';
import { applyMigrations } from './migrations';

/**
 * Catalog backend module for entity operational status.
 *
 * @public
 */
export const catalogModuleStatus = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'status',
  register(env) {
    env.registerInit({
      deps: {
        events: eventsServiceRef,
        database: coreServices.database,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        config: coreServices.rootConfig,
        translators: statusTranslationExtensionPoint,
      },
      async init({ events, database, logger, scheduler, config, translators }) {
        const db = await database.getClient();

        // Run migrations (entity_status_active, status_history)
        await applyMigrations(db);

        // Create status writer
        const statusWriter = new StatusWriter(db, logger);

        // Register built-in translators if configured
        const enabledTranslators = config.getOptionalStringArray(
          'catalog.status.translators'
        ) ?? ['generic'];
        
        for (const name of enabledTranslators) {
          if (name === 'generic') {
            translators.addTranslator(new GenericStatusTranslator());
          }
          // Additional built-in translators registered here
        }

        // Subscribe to status events
        const topics = config.getOptionalStringArray(
          'catalog.status.topics'
        ) ?? ['catalog.status'];

        events.subscribe({
          id: 'catalog-status',
          topics,
          async onEvent({ topic, eventPayload }) {
            const allTranslators = translators.getTranslators();
            
            for (const translator of allTranslators) {
              if (!translator.supportsTopic(topic)) continue;
              
              const entityRef = translator.getEntityRef(eventPayload);
              if (!entityRef) continue;
              
              const items = translator.translate(eventPayload);
              if (!items || items.length === 0) continue;
              
              try {
                await statusWriter.processStatusUpdate(entityRef, items);
              } catch (error) {
                if (error.name === 'ConflictError') {
                  // Retry once on stitch conflict
                  await statusWriter.processStatusUpdate(entityRef, items);
                } else {
                  logger.error(`Status update failed for ${entityRef}`, error);
                }
              }
              
              break; // First matching translator handles the event
            }
          },
        });

        // Periodic sync: push stale status to catalog
        scheduler.scheduleTask({
          id: 'catalog-status-sync',
          frequency: { seconds: 30 },
          timeout: { minutes: 1 },
          fn: () => statusWriter.syncStaleEntities(),
        });

        // Cleanup: remove status for deleted entities
        scheduler.scheduleTask({
          id: 'catalog-status-cleanup',
          frequency: { hours: 1 },
          timeout: { minutes: 5 },
          fn: () => statusWriter.cleanupOrphaned(),
        });

        logger.info('Catalog status module initialized');
      },
    });
  },
});
```

### 4.2 StatusWriter

```typescript
// src/StatusWriter.ts

import { Knex } from 'knex';
import { LoggerService } from '@backstage/backend-plugin-api';
import { EntityStatusItem } from '@backstage/catalog-model/alpha';
import { generateStableHash } from './hash';
import { v4 as uuid } from 'uuid';

export class StatusWriter {
  constructor(
    private readonly db: Knex,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Process a status update for an entity.
   * Called by the event subscriber when a translator produces items.
   */
  async processStatusUpdate(
    entityRef: string,
    items: EntityStatusItem[],
  ): Promise<void> {
    const now = new Date();

    // 1. Upsert each item into entity_status_active
    for (const item of items) {
      await this.db('entity_status_active')
        .insert({
          entity_ref: entityRef,
          type: item.type,
          source: this.deriveSource(item),
          level: item.level,
          message: item.message,
          updated_at: now,
        })
        .onConflict(['entity_ref', 'type', 'source'])
        .merge()
        .where('entity_status_active.updated_at', '<',
          this.db.raw('EXCLUDED.updated_at'));
    }

    // 2. Append to history
    const historyRows = items.map(item => ({
      entity_ref: entityRef,
      type: item.type,
      source: this.deriveSource(item),
      level: item.level,
      message: item.message,
    }));
    await this.db.batchInsert('status_history', historyRows, 50);

    // 3. Compute bounded summary
    const activeItems = await this.db('entity_status_active')
      .where('entity_ref', entityRef)
      .select('type', 'level', 'message');

    // 4. Push to catalog entity
    const stitchTicket = uuid();
    await this.db('final_entities')
      .where('entity_ref', entityRef)
      .update({ stitch_ticket: stitchTicket });

    const row = await this.db('final_entities')
      .select('entity_id', 'final_entity')
      .where('entity_ref', entityRef)
      .whereNotNull('final_entity')
      .first();

    if (!row) {
      // Entity not yet stitched — periodic sync will handle it
      return;
    }

    const entity = JSON.parse(row.final_entity);
    entity.status = {
      items: activeItems.map(i => ({
        type: i.type,
        level: i.level,
        message: i.message,
      })),
    };
    const hash = generateStableHash(entity);

    const updated = await this.db('final_entities')
      .where('entity_id', row.entity_id)
      .where('stitch_ticket', stitchTicket)
      .update({
        final_entity: JSON.stringify(entity),
        hash,
        last_updated_at: this.db.fn.now(),
      });

    if (updated === 0) {
      throw { name: 'ConflictError', message: `Concurrent modification of ${entityRef}` };
    }

    // 5. Mark as synced
    await this.db('entity_status_active')
      .where('entity_ref', entityRef)
      .update({ last_synced_at: this.db.fn.now() });
  }

  /**
   * Periodic sync: push status for entities whose active status has changed
   * but whose entity field might be stale (e.g., missed writes, new entities).
   */
  async syncStaleEntities(): Promise<void> {
    const stale = await this.db('entity_status_active')
      .select('entity_ref')
      .where('last_synced_at', '<',
        this.db.raw("NOW() - INTERVAL '60 seconds'"))
      .orWhereNull('last_synced_at')
      .limit(1000);

    for (const { entity_ref } of stale) {
      const entity = await this.db('final_entities')
        .select('entity_id')
        .where('entity_ref', entity_ref)
        .whereNotNull('final_entity')
        .first();

      if (!entity) continue;

      const items = await this.db('entity_status_active')
        .where('entity_ref', entity_ref)
        .select('type', 'level', 'message');

      try {
        // Same updateEntityField logic as processStatusUpdate
        const stitchTicket = uuid();
        await this.db('final_entities')
          .where('entity_ref', entity_ref)
          .update({ stitch_ticket: stitchTicket });

        const row = await this.db('final_entities')
          .select('entity_id', 'final_entity')
          .where('entity_ref', entity_ref)
          .whereNotNull('final_entity')
          .first();

        if (!row) continue;

        const entityData = JSON.parse(row.final_entity);
        entityData.status = {
          items: items.map(i => ({
            type: i.type,
            level: i.level,
            message: i.message,
          })),
        };
        const hash = generateStableHash(entityData);

        await this.db('final_entities')
          .where('entity_id', row.entity_id)
          .where('stitch_ticket', stitchTicket)
          .update({
            final_entity: JSON.stringify(entityData),
            hash,
            last_updated_at: this.db.fn.now(),
          });

        await this.db('entity_status_active')
          .where('entity_ref', entity_ref)
          .update({ last_synced_at: this.db.fn.now() });
      } catch {
        // Will retry next cycle
      }
    }
  }

  /**
   * Remove status entries for entities that no longer exist.
   */
  async cleanupOrphaned(): Promise<void> {
    await this.db('entity_status_active')
      .whereNotExists(
        this.db('final_entities')
          .select('entity_ref')
          .whereRaw(
            'entity_status_active.entity_ref = final_entities.entity_ref'
          )
      )
      .delete();
  }

  private deriveSource(item: EntityStatusItem): string {
    // Source is embedded in the item by the translator
    // For items without explicit source, use the type as source
    return (item as any).source ?? item.type;
  }
}
```

### 4.3 Database Tables

```sql
-- Active status (bounded — one row per entity+type+source)
CREATE TABLE entity_status_active (
  entity_ref     TEXT NOT NULL,
  type           TEXT NOT NULL,
  source         TEXT NOT NULL,
  level          TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  message        TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ,
  
  PRIMARY KEY (entity_ref, type, source)
);

CREATE INDEX idx_status_active_ref ON entity_status_active(entity_ref);

-- Status history (append-only, partitioned by month)
CREATE TABLE status_history (
  id         BIGSERIAL,
  entity_ref TEXT NOT NULL,
  type       TEXT NOT NULL,
  source     TEXT NOT NULL,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_history_ref_time ON status_history(entity_ref, created_at DESC);
```

### 4.4 Hash Utility

```typescript
// src/hash.ts
import { Entity } from '@backstage/catalog-model';
import { createHash } from 'crypto';
import stableStringify from 'fast-json-stable-stringify';

export function generateStableHash(entity: Entity): string {
  return createHash('sha1')
    .update(stableStringify({ ...entity }))
    .digest('hex');
}
```

(This replicates the catalog's own hash function. Import from catalog-backend if/when exported.)

---

## 5. Extension Point

### 5.1 Interface

**File:** `plugins/catalog-backend-module-status/src/StatusEventTranslator.ts`

```typescript
import { EntityStatusItem } from '@backstage/catalog-model/alpha';

/**
 * Translates events into entity status items.
 *
 * @public
 */
export interface StatusEventTranslator {
  /**
   * Returns the event topic this translator handles.
   */
  supportsTopic(): string;

  /**
   * Extracts the entity ref from the event payload.
   * Returns null if this event is not relevant to this translator.
   */
  getEntityRef(eventPayload: unknown): string | null;

  /**
   * Translates the event payload into status items.
   * The returned items must include a `source` property
   * (accessible via indexing or a subtype).
   */
  translate(eventPayload: unknown): EntityStatusItem[] | null;
}
```

### 5.2 Extension Point

**File:** `plugins/catalog-backend-module-status/src/extension.ts`

```typescript
import { createExtensionPoint } from '@backstage/backend-plugin-api';
import { StatusEventTranslator } from './StatusEventTranslator';

/**
 * Extension point for registering status event translators.
 *
 * @public
 */
export interface StatusTranslationExtensionPoint {
  addTranslator(translator: StatusEventTranslator): void;
  getTranslators(): StatusEventTranslator[];
}

/**
 * @public
 */
export const statusTranslationExtensionPoint =
  createExtensionPoint<StatusTranslationExtensionPoint>({
    id: 'catalog.status-translator',
  });
```

### 5.3 Built-in Translator: Generic

```typescript
// src/translators/GenericStatusTranslator.ts

import { StatusEventTranslator } from '../StatusEventTranslator';
import { EntityStatusItem } from '@backstage/catalog-model/alpha';

interface GenericStatusPayload {
  entityRef: string;
  type: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  source?: string;
}

/**
 * Translates generic status events with explicit entityRef, type, level, message.
 * This is the simplest translator — it expects the event payload to already
 * be in the right format.
 */
export class GenericStatusTranslator implements StatusEventTranslator {
  supportsTopic(): string {
    return 'catalog.status';
  }

  getEntityRef(payload: unknown): string | null {
    const p = payload as GenericStatusPayload;
    return p?.entityRef ?? null;
  }

  translate(payload: unknown): EntityStatusItem[] | null {
    const p = payload as GenericStatusPayload;
    if (!p?.type || !p?.level || !p?.message) return null;

    return [{
      type: p.type,
      level: p.level,
      message: p.message,
    }];
  }
}
```

### 5.4 Example: Custom Translator

Users can create custom translators for specific systems:

```typescript
// user's catalog-backend-module-status-github/src/GitHubActionsTranslator.ts

import { StatusEventTranslator } from '@backstage/plugin-catalog-backend-module-status';
import { EntityStatusItem } from '@backstage/catalog-model/alpha';

interface GitHubActionsPayload {
  repository: string;
  workflow: string;
  status: 'success' | 'failure' | 'cancelled';
  conclusion: string;
}

export class GitHubActionsTranslator implements StatusEventTranslator {
  supportsTopic(): string {
    return 'github.actions';
  }

  getEntityRef(payload: unknown): string | null {
    const p = payload as GitHubActionsPayload;
    // Map repo name to entity ref — requires lookup or naming convention
    const repoToEntityMap = new Map([
      ['my-org/my-service', 'component:default/my-service'],
    ]);
    return repoToEntityMap.get(p.repository) ?? null;
  }

  translate(payload: unknown): EntityStatusItem[] | null {
    const p = payload as GitHubActionsPayload;
    
    const level = p.conclusion === 'success' ? 'info'
      : p.conclusion === 'failure' ? 'error'
      : 'warning';

    return [{
      type: 'ci-cd',
      level,
      message: `${p.workflow}: ${p.conclusion} (${p.status})`,
    }];
  }
}
```

### 5.5 Registering Custom Translators

```typescript
// user's package/src/module.ts

import { createBackendModule } from '@backstage/backend-plugin-api';
import { statusTranslationExtensionPoint } from '@backstage/plugin-catalog-backend-module-status';
import { GitHubActionsTranslator } from './GitHubActionsTranslator';

export const myStatusModule = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'status-github',
  register(env) {
    env.registerInit({
      deps: {
        translators: statusTranslationExtensionPoint,
      },
      init({ translators }) {
        translators.addTranslator(new GitHubActionsTranslator());
      },
    });
  },
});
```

Then in `packages/backend/src/index.ts`:
```typescript
backend.add(import('@backstage/plugin-catalog-backend-module-status'));
backend.add(import('./path/to/myStatusModule'));  // custom translators
```

---

## 6. Frontend Plugin

### 6.1 Package: `catalog-plugin-status`

**Status reads from the catalog API** — entity.status is already in the entity JSON.

```tsx
// plugins/catalog-plugin-status/src/components/EntityStatusCard.tsx

import React from 'react';
import { useEntity } from '@backstage/plugin-catalog-react';
import { InfoCard, StatusOK, StatusError, StatusWarning } from '@backstage/core-components';
import { AlphaEntity, EntityStatusItem } from '@backstage/catalog-model/alpha';
import { Grid, Typography, Tooltip } from '@material-ui/core';

const levelIcon = {
  error: <StatusError />,
  warning: <StatusWarning />,
  info: <StatusOK />,
};

export const EntityStatusCard = () => {
  const { entity } = useEntity();
  const status = (entity as AlphaEntity)?.status;
  const items = (status?.items ?? []) as EntityStatusItem[];

  return (
    <InfoCard title="Status" deepLink={{
      link: `/catalog/${entity.metadata.namespace}/${entity.kind}/${entity.metadata.name}/status`,
    }}>
      {items.length === 0 ? (
        <Typography variant="body2" color="textSecondary">
          No status information available.
        </Typography>
      ) : (
        <Grid container direction="column" spacing={1}>
          {items.map((item, idx) => (
            <Grid item key={idx}>
              <Tooltip title={item.message}>
                <Grid container alignItems="center" spacing={1}>
                  <Grid item>{levelIcon[item.level]}</Grid>
                  <Grid item>
                    <Typography variant="body2">
                      <strong>{item.type}</strong>: {item.message}
                    </Typography>
                  </Grid>
                </Grid>
              </Tooltip>
            </Grid>
          ))}
        </Grid>
      )}
    </InfoCard>
  );
};
```

### 6.2 Frontend Plugin Registration

```typescript
// plugins/catalog-plugin-status/src/plugin.ts

import { createFrontendPlugin } from '@backstage/frontend-plugin-api';
import { createEntityCardExtension } from '@backstage/plugin-catalog-react/alpha';

export const catalogStatusPlugin = createFrontendPlugin({
  id: 'catalog-status',
  extensions: [
    createEntityCardExtension({
      name: 'status',
      title: 'Status',
      component: () => import('./components/EntityStatusCard').then(m => m.EntityStatusCard),
    }),
  ],
});
```

---

## 7. Architectural Decisions

### ADR-1: EventsService for Ingestion

**Decision:** Use Backstage's built-in EventsService instead of a custom HTTP API.

**Rationale:**
- Backstage already has HTTP event ingress (`POST /api/events/http/:topic`)
- No custom API to design, document, secure, and maintain
- Events are fire-and-forget with built-in observability
- Consistent with Backstage's event-driven architecture
- External systems use standard HTTP POST — no proprietary protocol

**Trade-off:** Events are async. The sender receives a 202 Accepted, not a synchronous response with the write result. Status converges eventually rather than being confirmed immediately.

### ADR-2: Pluggable Translators via Extension Point

**Decision:** Use a `StatusEventTranslator` interface registered via `statusTranslationExtensionPoint`.

**Rationale:**
- Follows the same pattern as `CatalogProcessor` and `ScaffolderAction`
- Users add custom translators without modifying the core module
- Third parties can publish translator packages
- The module stays small and focused

**Interface design:**
- `supportsTopic()` — declares which event topic this translator handles
- `getEntityRef()` — extracts entity identity from the event
- `translate()` — converts event payload to status items

Each translator is independent and composable. Multiple translators can handle different event types for the same entity.

### ADR-3: Catalog Module Pattern

**Decision:** Build as `catalog-backend-module-status`, not a separate plugin.

**Rationale:**
- No cross-plugin HTTP calls — everything runs in-process
- Direct access to catalog database (same Knex instance)
- Module has access to all catalog internals
- Lower latency (function calls vs HTTP requests)
- Simpler deployment (no separate backend service)
- Follows Backstage convention (`catalog-backend-module-github`, etc.)

**What "no separate plugin" means:**
- No `plugins/status-backend` with its own HTTP router
- No `plugins/status-node` with a service interface
- No REST calls between status and catalog
- `updateEntityField` is a direct function call on the catalog database

**What remains separate:**
- Frontend plugin (`catalog-plugin-status`) — reads from catalog API (standard)
- This is unavoidable — frontend and backend are different processes

### ADR-4: Status in Entity JSON (Same as v1.0)

**Decision:** Status must be inline in `entity.status.items`, not a separate API.

**Proof:** The stitcher already merges status items at lines 208-213 of `performStitching.ts`. The `AlphaEntity` type already defines `status?: EntityStatus`. The fork commit already adds `status` to `defaultKnownFields`.

### ADR-5: Stitch Ticket Concurrency (Same as v1.0)

**Decision:** Use the stitcher's own `stitch_ticket` pattern for `updateEntityField` concurrency.

### ADR-6: Conditional Upsert for Ordering (Same as v1.0)

**Decision:** `WHERE updated_at < EXCLUDED.updated_at` prevents stale messages from overwriting newer ones.

### ADR-7: Periodic Sync for Gap Coverage (Same as v1.0)

**Decision:** 30-second sync handles new entities, missed writes, and rare races.

---

## 8. Data Model

### Entity Status (Existing, `@backstage/catalog-model/alpha`)

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

### Database Tables

| Table | Purpose | Write Pattern | PK |
|---|---|---|---|
| `entity_status_active` | Current status snapshot | Upsert (conditional) | `(entity_ref, type, source)` |
| `status_history` | Full status audit log | Append-only, partitioned | `id` (auto) |
| `final_entities` | Catalog entity (contains status) | Stitcher + updateEntityField | `entity_id` |

### Entity Policy

`status` must be in `defaultKnownFields` (already committed in fork):
```typescript
const defaultKnownFields = ['apiVersion', 'kind', 'status', 'metadata', 'spec'];
```

---

## 9. Event Flow

### 9.1 Publishing Events (External Systems)

External systems POST to Backstage's HTTP event ingress:

```bash
curl -X POST https://backstage.example.com/api/events/http/catalog.status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "entityRef": "component:default/my-service",
    "type": "ci-cd",
    "level": "error",
    "message": "Build #456 failed: test timeout"
  }'
```

### 9.2 Event Topics

| Topic | Payload Shape | Handled By |
|---|---|---|
| `catalog.status` | `{ entityRef, type, level, message, source? }` | `GenericStatusTranslator` |
| `github.actions` | `{ repository, workflow, status, conclusion }` | `GitHubActionsTranslator` (custom) |
| `pagerduty.incident` | `{ service, incident, status, severity }` | `PagerDutyTranslator` (custom) |

### 9.3 Subscriber Flow

```
Event arrives at catalog.status topic
  → Module subscriber.onEvent({ topic, eventPayload })
    → Iterate translators:
      → Translator A: supportsTopic(topic)? ✓
      → Translator A: getEntityRef(payload)? → "component:default/svc"
      → Translator A: translate(payload)? → [{ type: 'ci-cd', level: 'error', ... }]
      → StatusWriter.processStatusUpdate(entityRef, items)
        → Upsert entity_status_active
        → Append status_history
        → Compute bounded summary
        → updateEntityField(entityRef, 'status', summary)
      → Break (first match wins)
```

---

## 10. Concurrency

### Stitch Ticket Protocol

Same as v1.0. Both `updateEntityField` and the stitcher use `stitch_ticket`:
1. Set `stitch_ticket` to a new random UUID
2. Read entity data
3. Write entity data `WHERE stitch_ticket = <UUID>`
4. If 0 rows updated → conflict → retry

**Convergence proof:** See v1.0 spec, Section 11. All 3 race scenarios converge correctly.

### In-Process Advantage

Because the module runs inside the catalog backend, `updateEntityField` is a **direct function call**, not an HTTP request. This eliminates:
- Network latency (~1-5ms per HTTP round-trip)
- Serialization/deserialization overhead
- Connection pooling concerns
- Timeout handling
- Retry logic for transient network errors

The only concurrency concern is the stitch_ticket race, which is already solved.

---

## 11. Scale Analysis

| Operation | Latency | Notes |
|---|---|---|
| Event receipt (HTTP → EventsService) | < 5ms | In-process pub/sub |
| Translator dispatch | < 1ms | In-process function calls |
| `entity_status_active` upsert | < 2ms | Indexed write |
| `status_history` append | < 1ms | Append-only |
| `updateEntityField` (read + write) | < 5ms | PK lookups + write |
| **Total event → entity** | **< 15ms** | All in-process |

| Resource | Load (1,667 writes/s) | Capacity |
|---|---|---|
| `entity_status_active` writes | 1,667/s | 50K+/s |
| `final_entities` reads | 1,667/s | 100K+/s |
| `final_entities` writes | 1,667/s × ~25KB = 42MB/s | 100MB/s+ |
| Event bus throughput | 1,667 events/s | 10K+/s |

**No bottleneck at target scale.** ~3x headroom before any constraint.

### Comparison: Module vs Separate Plugin

| Metric | Module (this design) | Separate Plugin |
|---|---|---|
| Event → entity latency | <15ms | ~20-50ms (HTTP overhead) |
| `updateEntityField` call | Direct function call | HTTP POST to catalog API |
| Failure surface | Process crash only | Process crash + network + timeout |
| Retry logic | Application-level | HTTP retry + application-level |
| Deployment | 1 process | 2 processes |

---

## 12. Edge Cases

All edge cases from v1.0 deep review remain valid. Key ones:

| # | Edge Case | Resolution |
|---|---|---|
| EC-1 | Entity not yet stitched | Periodic sync (30s) pushes status when ready |
| EC-2 | Entity deletion | Cleanup job (1h) removes orphaned status |
| EC-4 | Concurrent writes | Stitch ticket serializes; periodic sync corrects |
| EC-5 | Out-of-order messages | Conditional upsert (`WHERE updated_at < EXCLUDED.updated_at`) |
| EC-8 | Provider re-emits entity | Stitcher preserves status via external field preservation |
| EC-9 | Stitch + status write race | Stitch ticket protocol + external field preservation |

**New edge case for EventsService: Event delivery failure**

The EventsService is fire-and-forget. If the module crashes mid-processing, the event is lost.

**Mitigation:** External systems should use the periodic sync as a fallback. The status API (via catalog) reflects the current state from `entity_status_active`. If an event is lost, the periodic sync corrects within 30s.

**For critical status:** External systems can POST to `/api/events/http/catalog.status` and separately check the entity status via the catalog API to confirm delivery.

---

## 13. Package Structure

```
plugins/
├── catalog-backend-module-status/        # THE module
│   ├── package.json
│   ├── src/
│   │   ├── module.ts                     # createBackendModule entry
│   │   ├── extension.ts                  # Extension point definition
│   │   ├── StatusWriter.ts               # Write logic (tables + updateEntityField)
│   │   ├── StatusEventTranslator.ts      # Interface
│   │   ├── hash.ts                        # generateStableHash (replicated)
│   │   ├── translators/
│   │   │   └── GenericStatusTranslator.ts # Built-in translator
│   │   ├── sync.ts                        # Periodic sync logic
│   │   ├── cleanup.ts                     # Orphan cleanup logic
│   │   └── migrations/
│   │       └── 001_create_status_tables.ts
│   └── CHANGELOG.md
│
├── catalog-backend-module-status-github/  # Optional: GitHub translator
│   └── src/
│       ├── module.ts
│       └── GitHubActionsTranslator.ts
│
├── catalog-backend-module-status-pagerduty/  # Optional: PagerDuty translator
│   └── src/
│       ├── module.ts
│       └── PagerDutyTranslator.ts
│
└── catalog-plugin-status/                 # Frontend plugin
    └── src/
        ├── plugin.ts
        └── components/
            └── EntityStatusCard.tsx
```

### Dependency Graph

```
catalog-plugin-status
└── @backstage/plugin-catalog-react (reads entity.status via catalogApi)

catalog-backend-module-status
├── @backstage/backend-plugin-api (createBackendModule)
├── @backstage/plugin-events-node (eventsServiceRef)
├── @backstage/catalog-model/alpha (EntityStatus types)
└── (imports from catalog-backend: none — standalone module)

catalog-backend-module-status-github
├── @backstage/backend-plugin-api
└── @backstage/plugin-catalog-backend-module-status (extension point)
```

---

## 14. Migration

### Phase 0: Prerequisites (Complete)

- [x] `status` in `defaultKnownFields` (fork commit)
- [x] Design finalized and reviewed

### Phase 1: Core Changes

- [ ] PR: `addExternallyManagedField` + `updateEntityField` + stitcher preservation
- [ ] Test: Unit + integration tests
- [ ] Release: Ships in Backstage core

### Phase 2: Status Module

- [ ] `catalog-backend-module-status`: module, writer, tables, generic translator
- [ ] `catalog-plugin-status`: frontend entity card
- [ ] Test: Integration tests with EventsService
- [ ] Docs: Module README, translator API docs

### Phase 3: Ecosystem Translations

- [ ] `catalog-backend-module-status-github`: GitHub Actions translator
- [ ] `catalog-backend-module-status-pagerduty`: PagerDuty translator
- [ ] Custom translators by users

---

## 15. Implementation Guide

### Step 1: Core Changes

Apply the 2 core changes (Section 3) to the catalog backend:
1. `performStitching.ts` — external field preservation (~15 lines)
2. `DefaultCatalogDatabase.ts` — `updateEntityField` (~35 lines)
3. `CatalogBuilder.ts` — `addExternallyManagedField` (~10 lines)
4. `DefaultStitcher.ts` — thread `externallyManagedFields` (~8 lines)

### Step 2: Scaffold the Module

```bash
yarn backstage-cli new --select plugin-module \
  --option id=status \
  --option targetPlugin=catalog
```

### Step 3: Implement the Module

1. Create database migration (`001_create_status_tables.ts`)
2. Implement `StatusWriter` (Section 4.2)
3. Implement `GenericStatusTranslator` (Section 5.3)
4. Create extension point (Section 5.2)
5. Wire `createBackendModule` (Section 4.1)

### Step 4: Scaffold the Frontend

```bash
yarn backstage-cli new --select plugin \
  --option id=catalog-status
```

### Step 5: Wire Into Backend

```typescript
// packages/backend/src/index.ts

import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// Core catalog
backend.add(import('@backstage/plugin-catalog-backend'));

// Status module
backend.add(import('@backstage/plugin-catalog-backend-module-status'));

// Events backend (required for HTTP ingress)
backend.add(import('@backstage/plugin-events-backend'));

backend.start();
```

### Step 6: Configure Catalog

```typescript
// In catalog setup (or app-config):
catalog:
  externallyManagedFields: ['status']  // Or via code: builder.addExternallyManagedField('status')
```

### Step 7: Test

```bash
# Start Backstage
yarn dev

# Send a test status event
curl -X POST http://localhost:7007/api/events/http/catalog.status \
  -H "Content-Type: application/json" \
  -d '{"entityRef":"component:default/example","type":"health","level":"info","message":"All systems operational"}'

# Verify: entity now has status
curl http://localhost:7007/api/catalog/entities/by-name/component/default/example | jq '.status'
```

---

## 16. Appendix

### Why All Previous Approaches Failed

| Version | Approach | Fatal Flaw | Source Code Proof |
|---|---|---|---|
| v3.2 | Processor + refresh queue | `refreshEntity()` floods processing | Full pipeline per update |
| v4.0-v6.0 | Entity Provider | Provider ownership conflict | `replaceUnprocessedEntities()` PK is `provider_id + entity_ref` |
| v7.0-v9.0 | Provider + extension point | Cross-plugin scope issue | Extension points are plugin-scoped |
| v10.0 | Standalone API | Status not in entity JSON | Violates core requirement |
| v11.0 | Read Enricher | Status not stored | Can't filter, search, export |

**Key insight:** The stitcher at lines 208-213 of `performStitching.ts` already merges status items. Working WITH this behavior (not around it) is the only correct approach.

### Comparison: All Approaches

| Criterion | v2.0 (This) | v1.0 | v11.0 (Read Enricher) | v10.0 (Standalone) |
|---|---|---|---|---|
| Status in entity JSON | ✅ | ✅ | ❌ | ❌ |
| Ingestion mechanism | EventsService | Custom HTTP API | EventsService | Custom HTTP API |
| Pluggable translators | ✅ | ❌ | ❌ | ❌ |
| In-process (no cross-plugin HTTP) | ✅ | N/A | N/A | ❌ |
| Core changes | ~60 lines | ~60 lines | ~50 lines | 0 |
| Scale safe | ✅ | ✅ | ✅ | ✅ |
| Backstage-native | ✅ | ✅ | ⚠️ | ✅ |
