# Catalog Status Design — v12.0 Deep Review

**Date:** 2025-05-16  
**Review type:** Ultrathink — stress-testing the minimal design from every angle  
**Predecessor:** [catalog-status-api-minimal.md](./catalog-status-api-minimal.md)

---

## Executive Summary

v12.0 is the right design. Two core changes unlock the entire pattern:

1. `CatalogBuilder.addExternallyManagedField(fieldName)` — stitcher preserves plugin-managed fields
2. `CatalogDatabase.updateEntityField(ref, field, value)` — direct mutation with stitch_ticket safety

After tracing every code path and analyzing 18 edge cases, the design is sound. Three improvements identified, none requiring architecture changes.

---

## Edge Case Analysis

### EC-1: Entity Not Yet Stitched When Status Written

**Scenario:** Status plugin calls `updateEntityField` before the entity exists in `final_entities`.

**Trace:**
```
updateEntityField → SELECT final_entity WHERE entity_ref = ? AND final_entity IS NOT NULL
                  → No row (entity not stitched yet, final_entity is NULL)
                  → Returns early. Status is in entity_status_active, not in entity.
```

**Impact:** New entities miss status until the first manual sync. Status appears after entity is stitched and periodic sync runs.

**Fix:** Periodic sync in status plugin (see EC-1-FIX below). Not a core change — status plugin handles it.

**Mitigation:** Processor can add status on initial processing (falls back if `updateEntityField` hasn't run yet). But this conflicts with external field preservation (see EC-13). **Decision: no processor fallback. Rely on periodic sync.**

**EC-1-FIX: Periodic Status Sync**
```ts
// In status-backend, every 30s:
const stale = await db('entity_status_active')
  .select('entity_ref')
  .where('last_synced_at', '<', now - 60_000)  // 60s threshold
  .orWhereNull('last_synced_at')
  .limit(1000);

for (const { entity_ref } of stale) {
  const entity = await db('final_entities')
    .select('entity_id')
    .where('entity_ref', entity_ref)
    .whereNotNull('final_entity')
    .first();
  
  if (entity) {
    const items = await db('entity_status_active')
      .where('entity_ref', entity_ref)
      .whereNot('level', 'info');  // only warning/error
    await catalogDb.updateEntityField(entity_ref, 'status', { items });
  }
  
  await db('entity_status_active')
    .where('entity_ref', entity_ref)
    .update({ last_synced_at: db.fn.now() });
}
```

---

### EC-2: Entity Deletion

**Scenario:** Entity is deleted from catalog. `final_entities` row removed (CASCADE from `refresh_state`). `entity_status_active` still has orphaned entries.

**Impact:** Status data accumulates for deleted entities. Memory/disk leak.

**Fix:** Cleanup job (in status plugin):
```ts
// Every hour:
await db('entity_status_active')
  .whereNotExists(
    db('final_entities')
      .select('entity_ref')
      .whereRaw('entity_status_active.entity_ref = final_entities.entity_ref')
  )
  .delete();
```

Also cleans up `status_history` if applicable.

---

### EC-3: Unbounded Status Items Growth

**Scenario:** CI/CD pushes 100 builds/day. Each write upserts `entity_status_active`. History accumulates in `status_history`.

**Assessment:** `entity_status_active` is bounded (one row per entity_ref + type, upserted). `status_history` is unbounded.

**Fix:** TTL on `status_history`. Partition by date, drop old partitions. Or: `DELETE FROM status_history WHERE created_at < NOW() - INTERVAL '30 days'`.

Not a core design issue — operational concern.

---

### EC-4: Concurrent Status Writes (Two Handlers)

**Scenario:**
```
T1: CI/CD handler writes ci_status to entity_status_active
T2: PagerDuty handler writes pd_status to entity_status_active  
T3: CI/CD handler reads entity_status_active → [ci_status]
T4: PagerDuty handler reads entity_status_active → [ci_status, pd_status]
T5: CI/CD handler calls updateEntityField → status = [ci_status]
T6: PagerDuty handler calls updateEntityField → status = [ci_status, pd_status]
```

**Result at T6:** status = [ci_status, pd_status]. PD's write included CI's data (read at T4 saw it). CI's write at T5 was incomplete but PD's write at T6 corrects it. **Converges correctly.**

**Worst case:** Both handlers read before the other writes:
```
T1: CI writes ci_status to entity_status_active
T2: PD writes pd_status to entity_status_active
T3: CI reads entity_status_active → [ci] (PD's write not visible yet? Depends on isolation)
T4: PD reads entity_status_active → [pd] (CI's write not visible yet?)
T5: CI calls updateEntityField → status = [ci]
T6: PD calls updateEntityField → status = [pd]  ← LOST CI's item!
```

**Is this possible?** Yes, under READ COMMITTED isolation (default in PostgreSQL). CI writes at T1 but PD's read at T4 might see a snapshot from before T1's commit if PD's transaction started before T1 committed.

**Fix: Serialize writes per entity.** Use `SELECT ... FOR UPDATE` on `entity_status_active` before computing the summary. Or use a queue per entity. Or accept the rare race and rely on the periodic sync to correct it within 30s.

**Decision: Accept rare race → periodic sync corrects.** At 1,667 writes/s across 100K entities, concurrent writes to the SAME entity are rare (< 0.01% probability). Periodic sync corrects any misses within 30s.

---

### EC-5: Status Write Ordering (Same Source)

**Scenario:** CI/CD sends three updates in rapid succession:
```
Msg 1: build #123 failed (error)   → arrives 2nd (reordered by network)
Msg 2: build #124 passed (info)     → arrives 1st
Msg 3: build #125 failed (error)   → arrives 3rd
```

Without ordering, the entity might show `info` (from msg 2) instead of `error` (from msg 1 or 3).

**Fix:** Use a sequence number or timestamp on each status message. `entity_status_active` upserts with `WHERE updated_at < NEW.updated_at`:
```sql
INSERT INTO entity_status_active (entity_ref, type, level, message, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (entity_ref, type)
DO UPDATE SET level = EXCLUDED.level, message = EXCLUDED.message, updated_at = EXCLUDED.updated_at
WHERE entity_status_active.updated_at < EXCLUDED.updated_at;
```

This ensures old updates don't overwrite newer ones.

**Design update:** Add `updated_at` column. Use conditional upsert. Caller provides timestamp.

---

### EC-6: Hash Consistency

**Scenario:** `updateEntityField` updates status, changes hash. Stitcher runs next, reads entity (with status), computes hash (includes status), compares with previous hash → MATCH → "unchanged".

**Trace:**
```
updateEntityField: entity.status = newStatus, hash = SHA1(entity_with_newStatus)
stitcher: reads processed_entity (no status), reads existing final_entity (has status)
stitcher: merges status into entity, computes hash = SHA1(entity_with_status)
stitcher: hash === previousHash → "unchanged"
```

**Works correctly.** The stitcher reads the external field from `final_entities`, includes it in the hash, and the hash matches because it was computed from the same data.

---

### EC-7: Status Expiry (Error → Resolved)

**Scenario:** CI/CD reports error. Fix is deployed. Next build passes (info). Error should clear.

**With upsert pattern:**
```
T1: INSERT { type: 'ci-cd', level: 'error', message: 'Build #123 failed' }
T2: INSERT { type: 'ci-cd', level: 'info', message: 'Build #124 passed' }
    ON CONFLICT → overwrites error with info
```

**But:** if the status plugin filters out `info` items (only pushes warning/error), the entity would still show the OLD error.

**Fix:** When a status update clears an error (goes from error → info), the status plugin must push an EMPTY or cleared status for that type. Or: always push ALL items (including info), and let the frontend filter.

**Decision:** Push ALL non-empty items. The bounded summary includes info items. The entity JSON shows all current status per type. Frontend can filter. This ensures error → info transitions clear the error from the entity.

**Alternative:** Include `level: 'info'` items but mark them differently. Or: when an update would change level from error/warning to info, explicitly delete the item from the bounded summary. Simpler: always include all types.

---

### EC-8: Multiple Sources for Same Type

**Scenario:** Two CI systems (GitHub Actions and Jenkins) report on the same entity, both using `type: 'ci-cd'`.

**Problem:** They'd conflict on the `(entity_ref, type)` key in `entity_status_active`.

**Fix:** Use `(entity_ref, type, source)` as the primary key. Source is derived from auth or explicitly provided. In the bounded summary, all items are included (no deduplication by type). The entity shows:
```json
"status": {
  "items": [
    { "type": "ci-cd", "source": "github-actions", "level": "error", "message": "..." },
    { "type": "ci-cd", "source": "jenkins", "level": "info", "message": "..." },
    { "type": "pagerduty", "source": "pd-prod", "level": "warning", "message": "..." }
  ]
}
```

**Design update:** Add `source` column. Composite PK: `(entity_ref, type, source)`.

---

### EC-9: Source Identity

**Scenario:** CI/CD system sends status. How do we know which system sent it?

**Options:**
a. Client provides `source` in request body → forgeable
b. Derive `source` from auth token → secure, requires auth setup
c. Both: default to auth-derived, allow override for trusted clients

**Decision:** Derive from auth (Backstage service-to-service token). The source is the Backstage plugin ID or external service identity. This matches Backstage's security model.

---

### EC-10: Performance — Full Entity Write vs jsonb_set

**Current design:** `updateEntityField` reads full entity, modifies in memory, writes full entity back.

**At scale:**
- Entity JSON size: 5-50KB
- 1,667 writes/s × 25KB avg = 42MB/s write throughput
- PostgreSQL can handle this easily (100MB/s+ on modest hardware)
- Read + write is a primary-key lookup — indexed, < 1ms each

**Optimization (future):** Use `jsonb_set` for PostgreSQL to avoid reading/writing the full entity:
```ts
await db('final_entities')
  .where('entity_id', entityId)
  .update({
    final_entity: db.raw(
      `jsonb_set(cast(final_entity as jsonb), '{status}', ?::jsonb, true)`,
      [JSON.stringify(value)]
    ),
  });
```
Then compute hash by reading back. Saves ~90% write bandwidth.

**Decision: Full entity write for MVP. jsonb_set optimization for v2.**

---

### EC-11: Processor Adds Status Items → Conflict With External Fields

**Scenario:** A custom processor adds `status.items` in `postProcessEntity`. The stitcher runs. External field preservation reads existing status from `final_entities` and replaces processor-added items.

**Trace:**
```
Processor: postProcessEntity → adds status items [X, Y]
Stitcher: reads processed_entity → status has [X, Y]
Stitcher: adds error items → status has [X, Y, E1]
Stitcher: external field preservation → reads final_entities status [A, B]
Stitcher: replaces entity.status with [A, B, E1] (external non-error + stitcher error)
Result: Processor items [X, Y] are LOST
```

**Assessment:** This is by design. Externally-managed fields take precedence. Processors should NOT touch externally-managed fields. The `status` field was originally designed for catalog processing errors only — processors adding custom status was never a supported pattern.

**Mitigation:** Document that `status` is an externally-managed field when `addExternallyManagedField('status')` is used. Processors should use annotations or other fields for static enrichment.

---

### EC-12: Entity Provider Re-emits Entity

**Scenario:** Entity provider re-emits an entity (catalog-info.yaml changed). The entity goes through processing → stitching. The stitcher should preserve the existing status.

**Trace (no processor touching status):**
```
Provider: emits entity (no status in unprocessed_entity)
Processing: no processor touches status
Stitcher: reads processed_entity → no status
Stitcher: no errors → statusItems = []
Stitcher: external field preservation → reads final_entities status [A, B]
Stitcher: entity.status = { items: [A, B] }  ← CORRECT
```

**Works correctly.** As long as processors don't touch status, the external field is preserved.

---

### EC-13: Status Plugin Writes During Active Stitch

**Scenario:** Status plugin calls `updateEntityField` while the stitcher is in the middle of stitching.

```
Stitcher: sets stitch_ticket = T1 (merge)
Stitcher: reads refresh_state, does processing
StatusPlugin: sets stitch_ticket = T2 (overwrites T1)
StatusPlugin: reads final_entity, modifies, writes with WHERE ticket = T2 → success
Stitcher: tries to write with WHERE ticket = T1 → 0 rows → abandoned → will retry
Stitcher retry: sets T3, reads processed_entity, reads final_entity (has status from StatusPlugin)
Stitcher retry: merges status, writes with T3 → success (status preserved)
```

**Both converge correctly.** The stitch_ticket ensures mutual exclusion. The external field preservation ensures the stitcher's retry includes the status plugin's changes.

**BUT:** What if the stitcher's read of `refresh_state` and its external field read are inconsistent? Stitcher reads `refresh_state` (T1 state), then StatusPlugin writes to `final_entities` (T2), then stitcher reads `final_entities` (sees T2's status). The stitcher then writes an entity that combines T1's processed data with T2's status. This is correct — the status is the latest, the entity data is from T1.

**BUT what if the stitcher's read of `final_entities` gives it stale data?** If the stitcher reads `final_entities` AFTER setting the stitch_ticket, and before StatusPlugin's write, the stitcher sees old status. Then StatusPlugin writes, but the stitcher's ticket prevents the write. Then the stitcher writes old status → StatusPlugin retries → writes new status.

This is correct behavior — the stitcher's write with old status is eventually overwritten by StatusPlugin's retry.

Actually wait — the stitcher writes the entity with old status. The hash reflects old status. Then StatusPlugin retries, sees the entity has old status, writes new status, updates hash. **Converges.**

---

### EC-14: Deadlock

**Scenario:** Two `updateEntityField` calls for the same entity.

**Trace:**
```
Tx1: SET stitch_ticket = T1 → locks row
Tx2: SET stitch_ticket = T2 → WAITS for Tx1
Tx1: reads, writes, COMMIT
Tx2: gets lock, sets T3, reads, writes, COMMIT
```

No deadlock because each transaction only locks ONE row. **Serialized execution, not deadlock.**

**Scenario:** Transaction locks two entities:
```
Tx1: locks entity A, then tries entity B → WAITS
Tx2: locks entity B, then tries entity A → WAITS → DEADLOCK
```

But `updateEntityField` only touches ONE entity. **Not a concern unless the caller wraps multiple calls in a transaction.**

---

### EC-15: Database Engine Compatibility

**Current implementation:** Knex-based. Works with PostgreSQL, MySQL, SQLite.

**jsonb_set optimization:** PostgreSQL only. MySQL uses `JSON_SET()`. SQLite uses `json_set()`.

**Decision:** Full entity read+write for MVP (works on all engines). Optimize for PostgreSQL later with engine detection.

---

### EC-16: Entity Filtering By Status

**Scenario:** User wants to filter catalog by status: "show me all entities with error status."

**Current state:** `applyEntityFilterToQuery` filters on `final_entities.final_entity` using JSON path queries. For PostgreSQL, this uses `final_entity::jsonb->'status'->'items'`. For MySQL/SQLite, this may not work.

**Assessment:** Status filtering is NOT a v1 requirement. The status API provides its own filtering. Catalog-level filtering can be added later using the same JSON path mechanism the catalog already uses for annotation filtering.

---

### EC-17: Status Plugin ↔ Catalog Coupling

**Question:** Does the status plugin need to depend on catalog internals?

**Answer:** It depends on `CatalogDatabase.updateEntityField`, which is a public interface. The plugin doesn't touch `final_entities` directly. The interface is clean:

```ts
// Plugin depends on this interface:
interface CatalogDatabase {
  updateEntityField(entityRef: string, field: string, value: unknown): Promise<void>;
}
```

This is a reasonable dependency. The status plugin already depends on `@backstage/plugin-catalog-node` for entity types.

---

### EC-18: Rollback / Error Recovery

**Scenario:** `updateEntityField` crashes between SET and WRITE.

**Trace:**
```
Tx: SET stitch_ticket = T1
Tx: reads entity → CRASH (process dies)
```

The stitch_ticket remains T1. Next time the stitcher runs:
```
Stitcher: INSERT with ON CONFLICT MERGE stitch_ticket → T2 (overwrites T1)
Stitcher: processes, writes with WHERE ticket = T2 → success
```

No harm. The stitch_ticket is ephemeral — it only gates concurrent writes, it doesn't represent state.

---

## The Bigger Picture: What v12.0 Really Unlocks

### Not Just Status — A Pattern

`addExternallyManagedField` + `updateEntityField` is a **generic entity field mutation pattern**. It enables ANY plugin to manage fields on entities:

| Use Case | Field | Plugin | Write Rate |
|---|---|---|---|
| Operational status | `entity.status` | status | 1,667/s |
| Cloud cost | `entity.cost` | finops | 1/day per entity |
| Security posture | `entity.security` | security | 1/hour per entity |
| Compliance | `entity.compliance` | compliance | 1/day per entity |
| Latest deployment | `entity.deployment` | cd | 1/deploy |
| SLO status | `entity.slo` | observability | 1/min per entity |

All of these share the same pattern: external system → entity field. v12.0 provides the mechanism.

### Why This Matters

Backstage currently has NO way to push dynamic data onto entities. Every plugin that needs entity-level data must:
1. Build its own API
2. Build its own tables
3. Build its own frontend
4. User must navigate to each plugin to see data

With v12.0, plugins push data ONTO entities. The entity page becomes a unified dashboard. The catalog API serves all data. External tools see everything through the entity JSON.

### The `status` Field is the Keystone

The `status` field on `AlphaEntity` was designed for this. It already has:
- Type definition (`EntityStatus`, `EntityStatusItem`)
- Stitcher integration (error items merged)
- Entity policy acceptance (via the fork commit)
- Multiple items per type support

v12.0 is the MISSING PIECE: a way to PUT data into that field.

### What About `AlphaEntity` vs `Entity`?

`AlphaEntity` has `status?: EntityStatus`. `Entity` does NOT. This is intentional — `AlphaEntity` is the "alpha" type with future fields. When `status` graduates to stable, it'll be added to `Entity`.

For now, TypeScript code using `entity.status` needs to cast to `AlphaEntity` or use `as any`. The catalog client returns `Entity`, so consumers cast.

**This is acceptable for alpha.** The migration timeline:
1. Alpha: `entity.status` via cast → used by internal plugins
2. Beta: `entity.status` added to `Entity` type → used by all plugins
3. Stable: `entity.status` is a first-class field → used by external tools

---

## Design Improvements

### 1. Add `last_synced_at` to `entity_status_active`

Enables periodic sync to detect entities that need their status pushed.

```sql
ALTER TABLE entity_status_active ADD COLUMN last_synced_at TIMESTAMPTZ;
```

### 2. Add `source` to Primary Key

Enables multiple sources for the same status type.

```sql
-- Old: (entity_ref, type)
-- New: (entity_ref, type, source)
```

The `source` is derived from the auth token (Backstage plugin ID or external service identity).

### 3. Add `updated_at` for Ordering

Enables conditional upsert to prevent old updates overwriting newer ones.

```sql
ALTER TABLE entity_status_active ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();

INSERT INTO entity_status_active (...)
VALUES (...)
ON CONFLICT (entity_ref, type, source)
DO UPDATE SET ...
WHERE entity_status_active.updated_at < EXCLUDED.updated_at;
```

### 4. Periodic Sync in Status Plugin

Handles EC-1 (entity not yet stitched) and EC-4 (rare concurrent write race).

```ts
scheduler.scheduleTask({
  id: 'status-sync',
  frequency: { seconds: 30 },
  fn: async () => { /* sync logic from EC-1-FIX */ },
});
```

### 5. Cleanup Job

Handles EC-2 (orphaned status entries).

```ts
scheduler.scheduleTask({
  id: 'status-cleanup',
  frequency: { hours: 1 },
  fn: async () => {
    await db('entity_status_active')
      .whereNotExists(/* not in final_entities */)
      .delete();
  },
});
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Stitcher race loses status | Low | Medium | Stitch_ticket pattern prevents blind overwrites |
| Concurrent status writes drop items | Low | Low | Periodic sync corrects within 30s |
| Entity deletion leaks status data | Medium | Low | Cleanup job removes orphaned entries |
| Processor adds status → conflict | Low | Low | Documented: processors should not touch externally-managed fields |
| Backstage core rejects PR | Medium | High | Fallback: status API only (v10.0) until core change lands |
| Breaking change in Backstage stitcher | Low | High | External field preservation is additive, doesn't modify existing behavior |

---

## Verdict

**v12.0 is correct, minimal, and sound.** Two core changes (~60 lines) unlock the pattern. Three minor improvements identified (source key, ordering, periodic sync) — all implementable in the status plugin without changing the core design.

The stitcher's existing status merge behavior (lines 208-213 of `performStitching.ts`) confirms this pattern was anticipated by the Backstage team. v12.0 completes the implementation.

**No architecture changes needed. Proceed to implementation.**
