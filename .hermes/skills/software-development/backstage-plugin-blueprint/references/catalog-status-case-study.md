# Catalog Status API — Implementation Case Study

Full implementation of a 6-package Backstage plugin (v3.2 spec). This file captures the concrete patterns, gotchas, and architectural decisions.

## Package Architecture

```
plugins/
  status-common/           common-library    Types, StatusUpdate, StatusKey, 3 permissions
  status-node/             node-library      BoundStatusHandler, StatusSource, extension point
  status-backend/          backend-plugin    5 DB tables, 6 routes, StatusHandler, CoalescingHandler
  status-backend-module-catalog/  backend-plugin-module  EntityStatusProcessor, PostgresRefreshQueue
  status-react/            web-library       StatusClient, StatusApiClient, statusApiRef, useStatusApi
  status/                  frontend-plugin   ApiBlueprint + PageBlueprint + StatusPage dashboard
```

## Cross-Package Import Pattern

The key lesson: **sibling plugins must not import from each other directly.**

### Problem
`status-backend` needed `PostgresRefreshQueue` from `status-backend-module-catalog`. Direct relative import (`../../status-backend-module-catalog/src/PostgresRefreshQueue`) breaks when packages are published independently.

### Solution: Interface Adapter
Created `StatusRefreshQueue` interface in `status-backend`:
```ts
// plugins/status-backend/src/StatusRefreshQueue.ts
export interface StatusRefreshQueue {
  enqueue(entityRef: string): Promise<void>;
}
```
The module's `PostgresRefreshQueue` implicitly implements this interface via structural typing. The backend router takes `StatusRefreshQueue` as an optional dependency, injected at wiring time.

## `workspace:^` Rule

**`workspace:^` is ONLY for `@backstage/*` and `@internal/*` packages.** External npm packages use normal semver.

❌ `"uuid": "workspace:^"` → "Workspace not found"
✅ `"uuid": "^11.0.0"`

Same for `express`, `express-promise-router`, `knex`.

## Module `package.json` Requirements

```json
{
  "backstage": {
    "role": "backend-plugin-module",
    "pluginId": "catalog",           // REQUIRED — target plugin
    "pluginPackage": "@backstage/plugin-catalog-backend"  // REQUIRED — target package
  }
}
```

Omitting either causes the framework to fail at scoping plugin-scoped services.

## Database Migration Pattern (PostgreSQL)

5 tables in one migration file. Composite primary keys. CHECK constraints. Partial indexes for WHERE clauses:

```sql
-- Partial unique index: at most one incomplete entry per entity_ref
CREATE UNIQUE INDEX idx_esrq_entity_ref_incomplete
  ON entity_status_refresh_queue (entity_ref)
  WHERE completed_at IS NULL;
```

## Stale Boundary Checker Pattern

The module schedules a 5-minute task that:
1. Finds heartbeat rows crossing fresh→stale (`last_seen_at < NOW() - INTERVAL '5 minutes'`)
2. Finds rows crossing stale→fresh
3. Enqueues affected entity refs into the refresh queue
4. The catalog's normal processing cycle picks them up via EntityStatusProcessor

## Lockfile Management for New Packages

1. Create packages with `package.json` files
2. Run `node .yarn/releases/yarn-4.X.Y.cjs install --mode update-lockfile` to register them
3. Verify with `node_modules/.bin/tsc --noEmit`

The `--mode update-lockfile` skips the Link step, which is safe when you just need the lockfile updated for tsc/grep purposes.

## Partitioned Table Maintenance (PostgreSQL)

For append-only time-series tables, use a daily cron task to create future-month partitions and drop expired ones:

```ts
scheduler.scheduleTask({
  id: 'partition-maintenance',
  frequency: { cron: '0 3 * * *' }, // 3 AM daily
  timeout: { seconds: 120 },
  fn: async () => {
    await db.raw(`
      DO $$
      DECLARE
        current_month date := date_trunc('month', NOW());
        next_month date := date_trunc('month', NOW() + INTERVAL '1 month');
        partition_name text;
      BEGIN
        -- Create current + next month partitions
        partition_name := 'my_table_' || to_char(current_month, 'YYYY_MM');
        BEGIN
          EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF my_table
             FOR VALUES FROM (%L) TO (%L)',
            partition_name, current_month, current_month + INTERVAL '1 month'
          );
        EXCEPTION WHEN duplicate_table THEN NULL;
        END;
        -- Drop partitions older than 90 days
        FOR partition_name IN
          SELECT tablename FROM pg_tables
          WHERE tablename LIKE 'my_table_%'
            AND tablename < 'my_table_' || to_char(NOW() - INTERVAL '90 days', 'YYYY_MM')
        LOOP
          EXECUTE format('DROP TABLE IF EXISTS %I', partition_name);
        END LOOP;
      END $$;
    `);
  },
});
```

The initial migration must include a DEFAULT partition to catch rows that don't match any range partition:
```sql
CREATE TABLE my_table_default PARTITION OF my_table DEFAULT;
```

## Yarn Invocation

In this monorepo, Yarn is NOT on PATH. Use:
```bash
node .yarn/releases/yarn-4.8.1.cjs <command>
```

For tsc:
```bash
node_modules/.bin/tsc --noEmit
```

## Old Frontend System Integration

When adding a new-system plugin to an old-system app:
1. Export the page component from `src/index.ts` alongside the default plugin export
2. Import it in `packages/app/src/App.tsx`
3. Add a `<Route>` in the FlatRoutes

```ts
// plugins/status/src/index.ts
export { default } from './alpha';
export { StatusPage } from './alpha/components/StatusPage';

// packages/app/src/App.tsx
import { StatusPage } from '@backstage/plugin-status';
// ...
<Route path="/status" element={<StatusPage />} />
```

### Entity Page Integration (Old System)

To display content on entity detail pages in the old frontend system, export a component that uses `useEntity()` from `@backstage/plugin-catalog-react` and add it to `packages/app/src/components/catalog/EntityPage.tsx`:

```tsx
// In your plugin:
import { useEntity } from '@backstage/plugin-catalog-react';
import type { AlphaEntity } from '@backstage/catalog-model/alpha';

export function EntityStatusContent() {
  const { entity } = useEntity();
  const statusItems = (entity as AlphaEntity).status?.items;
  // ... render status from entity.status.items (zero-fetch, inline data)
}

// In packages/app/src/components/catalog/EntityPage.tsx:
import { EntityStatusContent } from '@backstage/plugin-status';

const overviewContent = (
  <Grid container spacing={3}>
    <Grid item xs={12}>
      <EntityStatusContent />
    </Grid>
    {/* ... other cards */}
  </Grid>
);
```

This pattern works because catalog processors (like `EntityStatusProcessor.postProcessEntity`) merge data into the entity during processing, making it available on entity pages without any additional API calls.
