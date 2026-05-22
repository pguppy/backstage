# Backstage Catalog Status API

## Design Addendum — v6.1 (Critical Fixes + Response Interceptor Analysis)

**Date:** June 2026

---

## Fix 1: Service Ref Scope Mismatch → Extension Point

**Problem:** v6.0 proposed a `StatusNotifierService` with `scope: 'plugin'` used by both `status-backend` (publishes) and `status-backend-module-catalog` (subscribes). But the module has `pluginId: 'catalog'`, not `'status'`. Backstage's dependency injection enforces scope isolation — a catalog-scoped module cannot depend on a status-scoped service. The notifier would never be injected.

**Fix:** Use an **extension point** instead of a service ref. Extension points are the standard Backstage pattern for cross-plugin communication:

```ts
// In plugins/status-node — extension point DEFINITION (no scope constraint)
export interface StatusNotificationBus {
  subscribe(handler: (entityRef: string, items: EntityStatusItem[]) => void): () => void;
}

export const statusNotificationBusExtensionPoint =
  createExtensionPoint<StatusNotificationBus>({ id: 'status.notificationBus' });

// In plugins/status-backend — extension point REGISTRATION
const bus = new DefaultStatusNotificationBus();
env.registerExtensionPoint(statusNotificationBusExtensionPoint, bus);

// Pass bus to StatusHandler:
const handler = new StatusHandler(db, source, bus, providerConnection);

// In plugins/status-backend-module-catalog — extension point CONSUMPTION
deps: {
  bus: statusNotificationBusExtensionPoint,  // ← Works cross-plugin!
}
async init({ bus, ... }) {
  bus.subscribe(async (entityRef, items) => {
    await connection.applyMutation({ entity with status });
  });
}
```

**Why this works:** Extension points have no scope constraint. The status plugin REGISTERS the implementation. The catalog module DEPENDS on the extension point. The module's `init()` runs after the plugin's `registerExtensionPoint()`. This is the standard Backstage pattern for cross-plugin dependencies (e.g., catalog modules depend on `catalogProcessingExtensionPoint` from `@backstage/plugin-catalog-node`).

## Fix 2: Synchronous Notification Blocks Write Transaction

**Problem:** v6.0's notifier calls all handlers synchronously inside `notifyChange()`. If a subscriber (`applyMutation()`) takes time or throws, the StatusHandler's database transaction is held open, potentially causing write failures or latency spikes.

**Fix:** Fire-and-forget with async dispatch:

```ts
class DefaultStatusNotificationBus implements StatusNotificationBus {
  private handlers = new Set<StatusChangeHandler>();
  private logger: LoggerService;

  subscribe(handler: StatusChangeHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  // Called by StatusHandler — returns immediately
  publish(entityRef: string, items: EntityStatusItem[]): void {
    // Fire and forget — don't block the write transaction
    setImmediate(() => {
      for (const handler of this.handlers) {
        handler(entityRef, items).catch(err => {
          this.logger.warn(
            `Notification handler failed for ${entityRef}: ${err.message}`,
          );
        });
      }
    });
  }
}
```

**Why this works:**
- `setImmediate` defers execution to the next event loop tick, after the current transaction commits
- Errors in subscribers are caught and logged — they don't propagate to the StatusHandler
- If a notification is lost (subscriber crashes before processing), the 5-minute catch-up poll recovers it
- The StatusHandler's transaction completes in microseconds regardless of subscriber performance

## Fix 3: Document No-Subscriber Behavior

If `status-backend-module-catalog` isn't installed, notifications fire with zero subscribers. Status exists in the API (real-time) but never appears in entity JSON. The entity page falls back to the status detail API. This is a deliberate operational choice — install the module if you want inline status, skip it if you only need the API.

---

## Deep Analysis: Response Interceptor — An Alternative to Catalog Processing

While fixing the above issues, I examined whether the entity provider pattern could be eliminated entirely. The answer is: yes, with a response interceptor approach.

### The Idea

Instead of pushing status INTO entities (which requires catalog processing and creates staleness), pull status AT READ TIME by intercepting the catalog's entity responses:

```
GET /api/catalog/entities/by-name/:kind/:namespace/:name
  → Catalog DB returns entity (no status)
    → Response interceptor fires
      → Queries entity_status_active (instant)
        → Merges status into entity JSON
          → Returns enriched entity to client
```

**Status is always fresh.** Zero processing overhead. Zero coupling to catalog processing interval. Zero polling. The tradeoff: a monkey-patch on `res.json()` in Express.

### Implementation

```ts
// In status-backend-module-catalog init():
httpRouter.use((req, res, next) => {
  // Only intercept entity read endpoints
  if (!isEntityReadPath(req.path)) return next();

  const originalJson = res.json.bind(res);
  res.json = async (body: any) => {
    // Restore original to avoid infinite recursion
    res.json = originalJson;

    if (body && isEntity(body)) {
      try {
        const enriched = await enrichWithStatus(db, body);
        return originalJson(enriched);
      } catch {
        // Enrichment failed — return original entity (degraded)
        return originalJson(body);
      }
    }
    return originalJson(body);
  };
  next();
});
```

### Comparison

| | Entity Provider + Notifier | Response Interceptor |
|---|---|---|
| Staleness | 10s p95 (processing interval) | 0s (read time) |
| Processing load | ~100 mutations/s on catalog | Zero |
| Status in entity JSON | Yes (stored) | Yes (enriched at response) |
| Catalog API filter by status | Works (stored in entity) | Doesn't work (enriched post-query) |
| Core changes required | None | None |
| Fragility | Low | Medium (monkey-patches res.json) |
| Implementation complexity | Medium | Low |

### Why It's Not the Recommended Approach (Today)

1. **Monkey-patching `res.json` is fragile.** If the catalog backend changes how it sends responses, the interceptor breaks.

2. **Catalog API filtering by status won't work.** `GET /entities?filter=status.items.level=error` filters before enrichment. Status would need to be in the stored entity for filtering.

3. **Two-package coupling.** The catalog module needs to know about the catalog's HTTP response format, which is an implementation detail.

### Future: If Backstage Added an Official Read Enricher Hook

A single core contribution would make this pattern clean and supported:

```ts
// Proposed Backstage core API:
catalogBuilder.addEntityReadEnricher(async (entity) => {
  const status = await fetchStatus(entity);
  return { ...entity, status };
});
```

This would give instant freshness, zero processing, and clean API — for ALL plugins. Until then, the entity provider + extension point notifier is the correct approach.

---

## V6.1 Summary of Changes from V6.0

| Issue | v6.0 | v6.1 |
|---|---|---|
| Cross-plugin communication | Service ref (broken — scope mismatch) | Extension point (correct) |
| Notification timing | Synchronous (blocks transaction) | Async with setImmediate (fire-and-forget) |
| No-subscriber behavior | Undefined | Documented: API-only mode |
| Response interceptor | Not considered | Analyzed, deferred as future direction |
