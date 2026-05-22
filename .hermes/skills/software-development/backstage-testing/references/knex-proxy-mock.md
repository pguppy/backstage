# Mocking Knex with Proxy for Unit Tests

When you need to unit-test code that calls `db('table_name').where(...).orderByRaw(...).limit(...)` or similar chainable Knex query builders, and you can't (or don't want to) spin up a real `TestDatabases` instance, use a **dual-level Proxy**.

## Pattern

```ts
function mockKnex(tableData: Record<string, any[]>): Knex {
  function makeChainable(table: string): any {
    const self = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'then') {
            return (resolve: Function, _reject?: Function) => {
              resolve(tableData[table] ?? []);
            };
          }
          // .where, .orderByRaw, .limit, .select, etc. → return self for chaining
          return () => self;
        },
      },
    );
    return self;
  }

  // Outer proxy: db('table_name') → chainable query builder
  return new Proxy(function () {} as any, {
    apply(_target: any, _thisArg: any, args: [string]) {
      return makeChainable(args[0]);
    },
  }) as any as Knex;
}
```

### How it works

1. **Outer Proxy `apply` trap** — when `db('entity_status_active')` is called, the `apply` handler fires with the table name as the first argument. It creates and returns a chainable query builder for that table.

2. **Inner Proxy `get` trap** — when `.where(...)`, `.orderByRaw(...)`, `.limit(...)`, `.select(...)` are called on the builder, the `get` trap fires. It returns a function that returns `self` (the same proxy), making the builder infinitely chainable.

3. **`then` handler** — when `await` or `Promise.all` resolves the builder, JS accesses `.then`. The `get` trap intercepts this and returns a thenable function that synchronously resolves with the pre-configured rows for that table.

### Usage

```ts
const db = mockKnex({
  entity_status_active: [
    { status_type: 'ci-cd/jenkins', status_level: 'error', message: 'Build failed' },
  ],
  entity_status_heartbeat: [
    { source: 'jenkins', status_type: 'ci-cd/jenkins', subject_key: 'main', last_seen_at: '...' },
  ],
});

const processor = new EntityStatusProcessor(db);
const result = await processor.postProcessEntity(entity, noopEmit);
```

### Why this over TestDatabases

| Approach | When to use |
|----------|-------------|
| `TestDatabases` (real SQLite/Postgres) | Integration tests, migration tests, actual SQL logic |
| Dual-Proxy mock | Unit tests for processor logic, sorting, merging, capping — pure JS logic that happens to use Knex as a transport |

The proxy mock is 10-100x faster than spinning up a real database and lets you precisely control input data without writing INSERT statements.

## Pitfalls

1. **The mock doesn't execute SQL.** `orderByRaw`, `limit`, `where` are all no-ops — the mock always returns exactly the rows you seeded. If you're testing SQL behavior, use `TestDatabases`.

2. **`then` must be on the proxy, not inherited.** JS checks for `then` as an own property when resolving promises. The `get` trap must explicitly handle `prop === 'then'`.

3. **Multiple calls to the same table return the same data.** The mock is read-only; mutations (INSERT/UPDATE/DELETE) won't be reflected. For mutation tests, use `TestDatabases`.

4. **TypeScript cast is needed.** The proxy object doesn't satisfy the full `Knex` type, so `as any as Knex` is required at the return boundary.
