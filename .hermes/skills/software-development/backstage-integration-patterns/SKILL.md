---
name: backstage-integration-patterns
description: "Use when building complete Backstage features that span multiple subsystems. 5 cross-system recipes: entity page extension, backend plugin with DB+tasks+API, auth+permissions for protected endpoints, scaffolder template to catalog entity, and events to signals to notifications pipeline."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, integration, patterns, recipes, cross-system, end-to-end]
related_skills: [backstage-plugin-blueprint, backstage-core-services, backstage-frontend-services, backstage-catalog-system, backstage-scaffolder-system, backstage-auth-permissions, backstage-search-system, backstage-messaging, backstage-backend-api]
---

# Backstage Cross-System Integration Patterns

## Overview

This skill bridges individual subsystem knowledge into complete features. 5 essential patterns every Backstage developer needs.

## Recipe 1: Complete Entity Page Extension

**Systems:** Frontend APIs + BUI + Catalog Blueprints  
**Goal:** Add a custom tab to entity pages (like TechDocs)

```tsx
// plugins/my-plugin/src/components/MyEntityContent.tsx
import { useEntity } from '@backstage/plugin-catalog-react';
import { Text, Flex } from '@backstage/ui';

export const MyEntityContent = () => {
  const { entity } = useEntity();
  return (
    <Flex direction="column" gap="4" p="4">
      <Text variant="title-medium">Custom Data for {entity.metadata.name}</Text>
      <Text variant="body-medium" color="secondary">Kind: {entity.kind}</Text>
    </Flex>
  );
};

// plugins/my-plugin/src/alpha/entityContents.tsx
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
export const myContent = EntityContentBlueprint.make({
  name: 'my-content',
  params: { path: '/my-content', title: 'My Content', group: 'custom', loader: () => import('../components/MyEntityContent').then(m => <m.MyEntityContent />) },
});

// plugins/my-plugin/src/alpha/plugin.tsx
export default createFrontendPlugin({ pluginId: 'my-plugin', extensions: [myContent] });

// App installation:
import myPlugin from '@internal/plugin-my-plugin/alpha';
const app = createApp({ features: [myPlugin] });
```

Configurable via `app-config.yaml`:
```yaml
app:
  extensions:
    - entity-content:my-plugin/my-content:
        config: { title: Custom Data, icon: dashboard }
```

## Recipe 2: Backend Plugin with DB + Tasks + API

**Systems:** Core Services (database, scheduler, httpRouter, logger, lifecycle, rootConfig)  
**Goal:** Store data, run periodic tasks, expose REST API

```ts
// plugins/my-plugin-backend/src/plugin.ts
import { createBackendPlugin, coreServices, resolvePackagePath } from '@backstage/backend-plugin-api';
import { Router } from 'express';

export const myPlugin = createBackendPlugin({
  pluginId: 'my-plugin',
  register(env) {
    env.registerInit({
      deps: {
        database: coreServices.database, scheduler: coreServices.scheduler,
        httpRouter: coreServices.httpRouter, logger: coreServices.logger,
        lifecycle: coreServices.lifecycle, config: coreServices.rootConfig,
        httpAuth: coreServices.httpAuth,
      },
      async init({ database, scheduler, httpRouter, logger, lifecycle, config, httpAuth }) {
        // 1. Database + migrations
        const client = await database.getClient();
        if (!database.migrations?.skip) {
          await client.migrate.latest({ directory: resolvePackagePath('@internal/plugin-my-plugin-backend', 'migrations') });
        }

        // 2. Scheduled task
        await scheduler.scheduleTask({
          id: 'cleanup', frequency: { hours: 1 }, timeout: { minutes: 5 }, scope: 'global',
          fn: async () => { await client('my_table').where('expires_at', '<', new Date()).del(); logger.info('Cleanup done'); },
        });

        // 3. REST API
        const router = Router();
        router.get('/data', async (_req, res) => { res.json(await client('my_table').select('*')); });
        router.post('/data', async (req, res) => {
          const creds = await httpAuth.credentials(req, { allow: ['user'] });
          const [row] = await client('my_table').insert({ data: JSON.stringify(req.body), created_by: creds.principal.userEntityRef }).returning('*');
          res.status(201).json(row);
        });
        httpRouter.use(router);

        // 4. Cleanup
        lifecycle.addShutdownHook(async () => { await client.destroy(); });
      },
    });
  },
});
```

### Migration Example

```ts
// migrations/20240101_init.ts
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('my_table', table => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.jsonb('data').notNullable();
    table.string('created_by').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('expires_at');
  });
}
export async function down(knex: Knex): Promise<void> { await knex.schema.dropTable('my_table'); }
```

## Recipe 3: Auth + Permissions for Protected Endpoint

**Systems:** Auth (httpAuth, auth, userInfo) + Permissions

```ts
// 1. Define permissions (in -common)
import { createPermission } from '@backstage/plugin-permission-common';
export const myReadPerm = createPermission({ name: 'myData.read', attributes: { action: 'read' } });
export const myWritePerm = createPermission({ name: 'myData.write', attributes: { action: 'create' } });

// 2. Register (in backend init)
permissionsRegistry.addResourceType({ resourceType: 'my-data', permissions: [myReadPerm, myWritePerm] });

// 3. Protected route handler
router.get('/secure-data', async (req, res) => {
  const creds = await httpAuth.credentials(req, { allow: ['user'] });
  const [d] = await permissions.authorize([{ permission: myReadPerm }], { credentials: creds });
  if (d.result !== AuthorizeResult.ALLOW) throw new NotAllowedError();
  const info = await userInfo.getUserInfo(creds);
  res.json(await getDataForOwner(info.ownershipEntityRefs));
});

router.post('/secure-data', async (req, res) => {
  const creds = await httpAuth.credentials(req, { allow: ['user'] });
  const [d] = await permissions.authorize([{ permission: myWritePerm }], { credentials: creds });
  if (d.result !== AuthorizeResult.ALLOW) throw new NotAllowedError();
  await createData(req.body);
  res.status(201).json({ success: true });
});
```

## Recipe 4: Scaffolder Template → Catalog Entity

**Systems:** Scaffolder + Catalog + GitHub Integration

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: create-microservice
spec:
  owner: platform-team
  type: service
  parameters:
    - title: Service Details
      required: [name, owner]
      properties:
        name: { title: Name, type: string }
        owner: { title: Owner, type: string, ui:field: OwnerPicker }
        repoUrl: { title: Repository URL, type: string, ui:field: RepoUrlPicker, ui:options: { allowedHosts: [github.com] } }
  steps:
    - id: fetch
      action: fetch:template
      input: { url: ./template, values: { name: ${{ parameters.name }}, owner: ${{ parameters.owner }} } }
    - id: publish
      action: publish:github
      input: { repoUrl: ${{ parameters.repoUrl }}, defaultBranch: main }
    - id: register
      action: catalog:register
      input: { repoContentsUrl: ${{ steps['publish'].output.repoContentsUrl }}, catalogInfoPath: /catalog-info.yaml }
```

Template `catalog-info.yaml` (Nunjucks):
```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${{ values.name }}
  annotations:
    github.com/project-slug: ${{ values.repoUrl | parseRepoUrl | pick('owner', 'repo') | join('/') }}
spec:
  type: service
  lifecycle: experimental
  owner: ${{ values.owner }}
```

### Recipe 6: Fast Writes to Entity Fields (Externally-Managed Fields)

**Problem:** You need to update an entity field from external events (CI/CD status, health checks, incident alerts) at high frequency. The catalog processing pipeline has 100-150s latency. Processors require full pipeline traversal per update. Entity providers cannot overlay existing entities.

**Primary Solution: Externally-Managed Fields (v12.0)**

Requires two small core contributions to `@backstage/plugin-catalog-backend` (~60 lines total):

1. `CatalogBuilder.addExternallyManagedField(fieldName)` — tells the stitcher to preserve this field from existing `final_entities` row
2. `CatalogDatabase.updateEntityField(entityRef, fieldName, value)` — direct write using stitch_ticket concurrency

```
Event → status_table (upsert, <1ms)
         │
         ▼
  catalogDb.updateEntityField(ref, 'status', boundedSummary)
         │
         ▼
  final_entities.final_entity ← status field updated directly
  Stitcher preserves field on re-stitch (reads existing final_entities)
```

**Plugin code (one line to push to entity):**
```ts
await catalogDatabase.updateEntityField(entityRef, 'status', { items: [...] });
// → Status in entity JSON. Instant. Filterable. Exportable.
```

**Stitcher injection point** (in `performStitching.ts`, after line 213, before hash at line 216):
```ts
if (options.externallyManagedFields?.includes('status')) {
  const existing = await knex('final_entities')
    .select('final_entity').where('entity_id', entityId).first();
  const externalItems = (existing.status?.items ?? [])
    .filter(i => i.type !== ENTITY_STATUS_CATALOG_PROCESSING_TYPE);
  entity.status = {
    items: [...externalItems, ...stitcherErrorItems],
  };
}
```

**Key rules:**
- Field is managed by plugin via `updateEntityField`, not by processors
- Stitcher preserves the field on every re-stitch (reads existing `final_entities`)
- Uses stitch_ticket for concurrency safety (same pattern stitcher already uses)
- Plugin owns its own tables for high-churn writes; bounded summary pushed to entity

**When to use:** Entity field already typed on `Entity`/`AlphaEntity`. High-frequency writes needed (up to 1,667+/s). Must be filterable/exportable in entity JSON.

**Alternative (if core changes not merged): Buffer Table Pattern**
Write to a plugin-owned buffer table. On entity fetch, the frontend queries the plugin API in parallel with the catalog API. Status NOT in entity JSON (not filterable by catalog, not exportable). See `backstage-catalog-system` skill for full analysis.

**When NOT to use:** Static data (entity providers or processors suffice). New subsystem without entity type (separate plugin, not a field on entities).

**Systems:** Events + Signals + Notifications

```ts
// 1. Publisher: emit event on data change
await events.publish({ topic: 'my-plugin.data-created', eventPayload: { id, entityRef }, metadata: { userEntityRef: creds.principal.userEntityRef } });

// 2. Signal subscriber: push to browser
events.subscribe({ id: 'forwarder', topics: ['my-plugin.data-created'], async onEvent(p) {
  await signals.publish({ recipients: { type: 'user', entityRef: p.metadata?.userEntityRef }, channel: 'my-plugin', message: { type: 'data-created', payload: p.eventPayload } });
}});

// 3. Notification subscriber: persist alert
events.subscribe({ id: 'notifier', topics: ['my-plugin.data-created'], async onEvent(p) {
  await notifications.send({ recipients: { type: 'entity', entityRef: owner }, payload: { title: 'Data Created', description: `Item ${id} created.`, link: '/catalog/...', severity: 'info' } });
}});

// 4. Frontend: react to signals
const { lastSignal } = useSignal('my-plugin');
useEffect(() => { if (lastSignal?.type === 'data-created') refetch(); }, [lastSignal]);
```

## Common Anti-Patterns

1. **Tight coupling** — Never import one plugin directly into another. Use extension points/blueprints.
2. **Missing error handling** — Wrap async ops in try/catch. Use `ForwardedError`.
3. **Not cleaning up** — Always `lifecycle.addShutdownHook()` for DB, intervals, subscriptions.
4. **Hardcoded entity refs** — Use `parseEntityRef`/`stringifyEntityRef`.
5. **Skipping permission checks** — Every write endpoint needs `permissions.authorize()`.
6. **Token reuse** — Fresh `auth.getPluginRequestToken()` per request.

## Verification Checklist

- [ ] Uses extension points/blueprints, not direct imports
- [ ] Shutdown hooks registered for cleanup
- [ ] Database migrations run in init
- [ ] Write endpoints check permissions
- [ ] Service calls use fresh tokens
- [ ] Events have lightweight payloads
- [ ] Notifications include navigation links
- [ ] Frontend reacts to signals
