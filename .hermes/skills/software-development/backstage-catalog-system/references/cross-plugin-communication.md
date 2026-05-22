# Cross-Plugin Communication in Backstage

## The Critical Distinction: Extension Point vs Service Ref

When plugin A needs to communicate with a module registered under plugin B, the mechanism matters.

### Service Ref (WRONG for cross-plugin)

```ts
// Defined in plugin-a-node
export const myServiceRef = createServiceRef<MyService>({
  id: 'plugin-a.myService',
  scope: 'plugin',  // ← plugin-scoped = CANNOT cross boundaries
});
```

A `scope: 'plugin'` service is injected by Backstage's DI container ONLY into dependencies within the SAME plugin family. A module with `pluginId: 'catalog'` cannot depend on a service scoped to `pluginId: 'status'`. The DI container rejects the injection at startup.

### Extension Point (CORRECT for cross-plugin)

```ts
// Defined in plugin-a-node — no scope constraint
export interface MyBus {
  publish(data: unknown): void;
  subscribe(handler: (data: unknown) => void): () => void;
}

export const myBusExtensionPoint = createExtensionPoint<MyBus>({
  id: 'plugin-a.bus',
});

// Registered by plugin-a-backend (pluginId: 'plugin-a')
const bus = new MyBusImpl();
env.registerExtensionPoint(myBusExtensionPoint, bus);

// Consumed by plugin-b-backend-module (pluginId: 'plugin-b')
env.registerInit({
  deps: { bus: myBusExtensionPoint },
  async init({ bus }) {
    bus.subscribe((data) => { /* handles cross-plugin event */ });
  },
});
```

Extension points have no scope constraint. The consuming module declares a dependency on the extension point. Backstage resolves it at startup — the module's `init()` runs after the plugin's `registerExtensionPoint()`.

## The Notification Bus Pattern

For in-process, cross-plugin event propagation:

```ts
class DefaultBus implements MyBus {
  private handlers = new Set<...>();

  publish(data: unknown): void {
    // Fire-and-forget — does NOT block caller
    // Use setImmediate to defer to next event loop tick
    setImmediate(() => {
      for (const handler of this.handlers) {
        handler(data).catch(err => this.logger.warn(`Handler failed: ${err.message}`));
      }
    });
  }

  subscribe(handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
```

**Key properties:**

1. **Fire-and-forget publish**: `publish()` returns immediately. Does not block the caller's transaction or request. Subscribers run on the next event loop tick via `setImmediate`.

2. **Error isolation**: Subscriber errors are caught and logged. A failing subscriber does not crash the publisher. The publisher doesn't even know the subscriber failed.

3. **Catch-up poll for recovery**: Lost notifications (subscriber crash, process restart, `setImmediate` callback loss) are recovered by a periodic catch-up poll. The bus handles >99.9% of propagation; the poll is insurance.

4. **In-process, zero serialization**: No HTTP, no JSON, no network. Subscribers receive the same object references. Zero latency overhead beyond `setImmediate`.

## Pitfall: Synchronous Notification in Write Transactions

If `publish()` awaits all subscribers synchronously inside a database transaction:

```ts
// WRONG — blocks transaction
async publish(data: unknown): Promise<void> {
  for (const handler of this.handlers) {
    await handler(data); // ← holds write lock until ALL subscribers finish
  }
}
```

A slow subscriber (e.g., `applyMutation()` taking 100ms) holds the database transaction open for 100ms. This cascades: every status write is delayed by subscriber processing time.

**Fix**: Use `setImmediate` to fire subscribers AFTER the transaction commits. Lost notifications are recovered by the catch-up poll.
