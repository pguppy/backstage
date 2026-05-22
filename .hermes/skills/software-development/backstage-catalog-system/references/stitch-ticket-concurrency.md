# Stitch-Ticket Concurrency Model

## Overview

The `final_entities` table has a `stitch_ticket` column that gates concurrent writes. Both the stitcher and external field writers use this pattern for mutual exclusion.

## Table Schema

```ts
type DbFinalEntitiesRow = {
  entity_id: string;        // PK
  hash: string;             // SHA-1 of final_entity
  stitch_ticket: string;    // UUID — concurrency gate
  final_entity?: string;    // JSON entity
  last_updated_at?: string | Date;
  entity_ref: string;
};
```

## Stitcher Flow

From `performStitching.ts`:

1. **Set ticket** (lines 77-98): INSERT/merge stitch_ticket into `final_entities`
   ```ts
   await knex('final_entities')
     .insert({ entity_id, hash: '', entity_ref, stitch_ticket: stitchTicket })
     .onConflict('entity_id')
     .merge(['stitch_ticket']);
   ```

2. **Process** (lines 101-213): Read from `refresh_state`, compute enrichments, build final entity

3. **Preserve external fields** (proposed new step): Read existing `final_entities`, extract externally-managed fields, merge into entity

4. **Hash comparison** (lines 216-219): Compare with previous hash. Skip if unchanged.

5. **Write with ticket gate** (lines 234-241):
   ```ts
   const updated = await knex('final_entities')
     .update({ final_entity: JSON.stringify(entity), hash, last_updated_at })
     .where('entity_id', entityId)
     .where('stitch_ticket', stitchTicket);
   // If 0 rows → ticket was overwritten → abandon
   ```

## External Field Writer Flow (updateEntityField)

1. **Set ticket:**
   ```ts
   const ticket = uuid();
   await knex('final_entities')
     .where('entity_ref', entityRef)
     .update({ stitch_ticket: ticket });
   ```

2. **Read entity:**
   ```ts
   const row = await knex('final_entities')
     .select('entity_id', 'final_entity')
     .where('entity_ref', entityRef)
     .whereNotNull('final_entity')
     .first();
   ```

3. **Mutate + Write with ticket gate:**
   ```ts
   const entity = JSON.parse(row.final_entity);
   entity[field] = value;
   const hash = generateStableHash(entity);
   
   const updated = await knex('final_entities')
     .where('entity_id', row.entity_id)
     .where('stitch_ticket', ticket)
     .update({ final_entity: JSON.stringify(entity), hash, last_updated_at });
   
   if (updated === 0) throw new ConflictError(...); // Retry
   ```

## Race Scenario: Status Writer Wins

```
T1: StatusWriter.setTicket("A")
T2: Stitcher.mergeTicket("B")   → overwrites "A"
T3: StatusWriter reads entity    → ticket is "B" now, but read succeeds
T4: StatusWriter mutates entity
T5: StatusWriter.UPDATE WHERE ticket="A" → 0 rows → ConflictError → RETRY
T6: StatusWriter.RETRY: setTicket("C"), read, mutate, write → success
T7: Stitcher finishes processing, tries UPDATE WHERE ticket="B" → 0 rows → abandoned
T8: Stitcher will re-run later, reads entity (has "C"'s status), preserves it via external field
```

## Race Scenario: Stitcher Wins

```
T1: Stitcher.setTicket("B")
T2: StatusWriter.setTicket("A")  → overwrites "B"
T3: Stitcher reads refresh_state, processes
T4: Stitcher reads final_entities (external field preservation — sees whatever status is there)
T5: Stitcher.UPDATE WHERE ticket="B" → 0 rows → abandoned
T6: StatusWriter reads entity, mutates, writes → success
T7: Stitcher re-runs, reads entity (has StatusWriter's status), preserves it
```

## Why This Converges

Both flows converge because:

1. **Mutual exclusion:** Only one writer can have its ticket match at write time
2. **Stitcher preserves external fields:** The stitcher reads existing `final_entities` and merges externally-managed fields before writing — so even if the stitcher "wins" a later race, it preserves the external field values
3. **Retry loop:** The loser retries — eventually both writes succeed
4. **No data loss:** The stitcher always reads latest external fields from `final_entities` before computing its hash

## Ordering Guarantee

The stitch_ticket provides **atomic write gating**, not ordering. Two rapid status updates:

```
T1: Status A writes → sets ticket, writes → success
T2: Status B writes → sets ticket, writes → success (wins ticket race)
T3: Status A retries → sets ticket, reads entity (has B's status), writes → success (no-op if same)
```

Last writer wins, which is correct for status (latest status is authoritative).

## Key Design Decision

**Set ticket BEFORE reading, not after.** If we read first and set ticket later:

```
T1: Read entity (stitch_ticket = X)
T2: Stitcher sets ticket to Y, processes, writes → success
T3: We set ticket to Z, write based on stale T1 read → overwrites stitcher's work
```

The stitcher's processing (relations, enrichment, errors) is lost. Setting ticket FIRST ensures that if the stitcher subsequently overwrites our ticket, our write will fail and we'll retry with fresh data.

## Injection Point in performStitching.ts

After line 213 (error status items merged), before line 216 (hash computed):

```ts
// After line 213:
if (options.externallyManagedFields?.length) {
  const existingRow = await knex('final_entities')
    .select('final_entity')
    .where('entity_id', entityId)
    .first();
  
  if (existingRow?.final_entity) {
    const existing = JSON.parse(existingRow.final_entity);
    
    // Status-specific merge: external items + stitcher error items
    if (options.externallyManagedFields.includes('status')) {
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
// Before line 216:
const hash = generateStableHash(entity);
```

The hash includes external fields → change detection works correctly.
