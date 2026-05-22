---
name: backstage-plugin-blueprint
description: "Use when creating a COMPLETE Backstage plugin from scratch — frontend + backend + client + common packages, end to end. This is the canonical blueprint that ties together all Backstage plugin concepts: scaffolding, extension points, service initialization, API routing, API consumption, database setup, permissions, and testing. Use this as the definitive reference before creating any new plugin."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, plugin, blueprint, end-to-end, scaffolding, frontend, backend, extension-points, services]
    related_skills: [backstage-core-services, backstage-frontend-services, backstage-backend-api, backstage-client-api, backstage-catalog-system, backstage-cli, backstage-testing, backstage-auth-permissions, backstage-app-config, backstage-app-wiring, backstage-ui-components, backstage-ui-styling]
---

# Backstage Plugin Blueprint — Complete End-to-End Reference

## Quick Start: Minimal Plugin in 30 Lines

```tsx
// plugins/my-plugin/src/alpha/plugin.tsx
import { createFrontendPlugin, PageBlueprint, NavItemBlueprint } from '@backstage/frontend-plugin-api';
import { rootRouteRef } from '../routes';

const myPage = PageBlueprint.make({
  params: { routeRef: rootRouteRef, path: '/my-plugin',
    loader: () => import('./MyPage').then(m => <m.MyPage />) },
});
const myNavItem = NavItemBlueprint.make({
  params: { routeRef: rootRouteRef, title: 'My Plugin', icon: MyIcon },
});

export default createFrontendPlugin({
  pluginId: 'my-plugin',
  extensions: [myPage, myNavItem],
  routes: { root: rootRouteRef },
});
```

> **Need a backend?** → Jump to [Phase 3](#phase-3-create-the-backend-plugin--backend)  
> **Need permissions?** → Jump to [Phase 2](#phase-2-define-types-and-permissions--common)  
> **Need to extend an existing plugin?** → Jump to [Phase 5](#cross-plugin-communication-patterns)  
> **Need cross-plugin communication?** → Jump to [Cross-Plugin](#cross-plugin-communication-patterns)  
> **Migrating from old system?** → Jump to [Migration Appendix](#migration-old--new-system)

---

## The Plugin Package Family

Every complete Backstage plugin follows this package structure:

```
plugins/
  <pluginId>/                          ← frontend-plugin    (ALWAYS)
  <pluginId>-backend/                  ← backend-plugin     (when you need backend APIs/DB)
  <pluginId>-backend-module-<name>/    ← backend-module     (to extend OTHER plugins)
  <pluginId>-react/                    ← web-library        (shared React components, API refs)
  <pluginId>-node/                     ← node-library       (extension points, backend types)
  <pluginId>-common/                   ← common-library     (isomorphic types, permissions)
```

**Simpler plugins** can skip `-react`, `-node`, and `-common` if they don't need to be extended or shared. Every plugin MUST have the `frontend-plugin` package at minimum.

## Quick Decision: What to Create

```
Does my plugin need a backend?
├── No  → Only create <pluginId>/            (frontend-plugin)
└── Yes → Create <pluginId>-backend/ too     (backend-plugin)

Does my plugin need to be EXTENDED by other plugins?
├── No  → Skip -react, -node, -common
└── Yes → Create -react (for shared components/API refs)
          Create -common (for shared types/permissions)
          Create -node (if backend extension points)

Am I extending an EXISTING plugin (e.g., catalog, scaffolder)?
└── Yes → Create <targetPlugin>-backend-module-<myModule>/

Am I adding a new FIELD to entities (e.g., custom metadata)?
└── Yes → Check if AlphaEntity or Entity already has the type
          └── Yes → Extend catalog via processor (not a separate plugin)
                    See `backstage-catalog-system` skill + `references/catalog-pipeline.md`
          └── No  → Create separate plugin with own storage. Link via annotation.
```

## Extension Blueprints Reference

Use blueprints instead of raw `createExtension`. Import from `@backstage/frontend-plugin-api`:

| Blueprint | Kind | Purpose |
|---|---|---|
| `PageBlueprint` | `page` | Registers a page at a route |
| `NavItemBlueprint` | `nav-item` | Sidebar navigation link |
| `ApiBlueprint` | `api` | Provides a Utility API implementation |
| `AppRootElementBlueprint` | `app-root-element` | Injects element into app root |
| `SubPageBlueprint` | `sub-page` | Nested sub-page within a parent |
| `PluginWrapperBlueprint` | `plugin-wrapper` | Wraps a plugin with layout |
| `AnalyticsImplementationBlueprint` | `analytics-implementation` | Analytics tracking |
| `PluginHeaderActionBlueprint` | `plugin-header-action` | Action button in plugin header |

**Catalog-specific blueprints** (from `@backstage/plugin-catalog-react/alpha`):

| Blueprint | Purpose |
|---|---|
| `EntityCardBlueprint` | Card on entity overview page |
| `EntityContentBlueprint` | Tab on entity page (e.g., TechDocs, Kubernetes) |
| `EntityContentLayoutBlueprint` | Custom layout for entity content tabs |
| `EntityHeaderBlueprint` | Custom header for entity page |
| `EntityContextMenuItemBlueprint` | Context menu item on entity page |
| `EntityIconLinkBlueprint` | Icon link in entity header |
| `CatalogFilterBlueprint` | Filter in catalog index page |

### Plugin Overrides (Customize Without Forking)

```tsx
import catalogPlugin from '@backstage/plugin-catalog';

const customizedCatalog = catalogPlugin.withOverrides({
  extensions: [
    catalogPlugin.getExtension('entity-content:catalog/overview').override({
      params: { icon: <MyIcon /> },
    }),
  ],
});

---

### Phase 0: Validate the Core First (4 Components)

Before building the full plugin with dashboards, signals, and history:

1. **Database table** — single table with upsert-safe primary key (include source + subject_key for multi-source support)
2. **Write API** — one POST endpoint, service-to-service auth, derive source from authenticated principal
3. **Catalog processor** — `postProcessEntity` merges data into entity during PROCESSING (not stitching — the stitcher is a fixed process that cannot be extended)
4. **Entity page** — reads entity field inline (zero new frontend code)

**Critical: Processing ≠ Stitching.** Backstage docs: "The stitching is currently a fixed process, that cannot be modified or extended." Processors run during PROCESSING, which feeds into stitching. Add processors via `catalogProcessingExtensionPoint.addProcessor()`, not by modifying the stitcher. The `postProcessEntity` hook is the PROCESSING step — the stitcher assembles whatever the processors produced.

Ship this. ~200 lines. Validate with real traffic. Only then add history, signals, dashboards, and bulk endpoints — each independently, based on proven need, not anticipated scale.

```bash
yarn new
# Select type based on your decision above

# For a complete plugin with backend:
yarn new  → frontend-plugin       → plugins/my-plugin/
yarn new  → backend-plugin        → plugins/my-plugin-backend/

# If you need shared types or API definitions:
yarn new  → common-library        → packages/my-plugin-common/

# If other plugins will consume your API client:
yarn new  → web-library           → packages/my-plugin-react/
```

---

## Phase 2: Define Types and Permissions (-common)

```ts
// packages/my-plugin-common/src/index.ts
import { createPermission } from '@backstage/plugin-permission-common';

export interface Item {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  createdAt: string;
}

export interface CreateItemBody {
  name: string;
}

// Permissions
export const itemReadPermission = createPermission({
  name: 'my-plugin.item.read',
  attributes: { action: 'read' },
});

export const itemCreatePermission = createPermission({
  name: 'my-plugin.item.create',
  attributes: { action: 'create' },
});

export const myPluginPermissions = [itemReadPermission, itemCreatePermission];
```

---

## Phase 3: Create the Backend Plugin (-backend)

### 3.1 Plugin Definition

```ts
// plugins/my-plugin-backend/src/plugin.ts
import { createBackendPlugin, coreServices } from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import { resolvePackagePath } from '@backstage/backend-plugin-api';

export default createBackendPlugin({
  pluginId: 'my-plugin',
  register(env) {
    // OPTIONAL: Register extension points IF other plugins will extend this one
    // env.registerExtensionPoint(myProcessingExtensionPoint, { ... });

    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        auth: coreServices.auth,
        discovery: coreServices.discovery,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        database: coreServices.database,
        lifecycle: coreServices.lifecycle,
      },
      async init(deps) {
        // 1. Run database migrations
        const client = await deps.database.getClient();
        if (!deps.database.migrations?.skip) {
          await client.migrate.latest({
            directory: resolvePackagePath(
              '@internal/plugin-my-plugin-backend', 'migrations',
            ),
          });
        }

        // 2. Register permissions
        deps.permissionsRegistry.addPermissions(myPluginPermissions);

        // 3. Create and mount router
        const router = await createRouter(deps);
        deps.httpRouter.use(router);

        // 4. Cleanup on shutdown
        deps.lifecycle.addShutdownHook(() => client.destroy());

        deps.logger.info('my-plugin backend initialized');
      },
    });
  },
});
```

### 3.2 Router (API Routes)

```ts
// plugins/my-plugin-backend/src/router.ts
import { Router } from 'express';
import {
  AuthService, HttpAuthService, LoggerService,
  PermissionsService, DiscoveryService,
} from '@backstage/backend-plugin-api';
import { NotAllowedError, NotFoundError, InputError } from '@backstage/errors';
import { itemReadPermission, itemCreatePermission } from '@internal/my-plugin-common';

interface RouterOptions {
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  auth: AuthService;
  discovery: DiscoveryService;
  logger: LoggerService;
  // database client if needed
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { httpAuth, permissions, auth, discovery, logger } = options;
  const router = Router();

  // PUBLIC: Health check
  router.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // PROTECTED: List items
  router.get('/items', async (req, res) => {
    const creds = await httpAuth.credentials(req);
    const [decision] = await permissions.authorize(
      [{ permission: itemReadPermission }],
      { credentials: creds },
    );
    if (decision.result !== 'ALLOW') throw new NotAllowedError();

    const items = await fetchItems(); // Your data logic
    res.json({ items });
  });

  // PROTECTED: Create item
  router.post('/items', async (req, res) => {
    const creds = await httpAuth.credentials(req);
    const [decision] = await permissions.authorize(
      [{ permission: itemCreatePermission }],
      { credentials: creds },
    );
    if (decision.result !== 'ALLOW') throw new NotAllowedError();

    const { name } = req.body;
    if (!name) throw new InputError('name is required');

    const item = await createItem({ name }); // Your data logic
    res.status(201).json(item);
  });

  // SERVICE-TO-SERVICE: Example calling another plugin
  router.get('/catalog-entities', async (_req, res) => {
    const baseUrl = await discovery.getBaseUrl('catalog');
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: await auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });
    const resp = await fetch(`${baseUrl}/entities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(await resp.json());
  });

  return router;
}
```

### 3.3 Database Migrations

```sql
-- plugins/my-plugin-backend/migrations/20240101000000_init.js
exports.up = async function up(knex) {
  await knex.schema.createTable('items', table => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name').notNullable();
    table.string('status').notNullable().defaultTo('active');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('items');
};
```

### 3.4 Config Schema

```ts
// plugins/my-plugin-backend/config.d.ts
export interface Config {
  myPlugin?: {
    /** Maximum items to return per page @default 50 */
    maxPageSize?: number;
  };
}
```

```json
// In package.json:
"configSchema": "config.d.ts"
```

### 3.5 Install in Backend

```ts
// packages/backend/src/index.ts
backend.add(import('@internal/plugin-my-plugin-backend'));
```

---

## Phase 4: Create the Frontend Plugin (frontend)

### 4.1 API Client (Manual — no generated OpenAPI needed for simple plugins)

```ts
// plugins/my-plugin/src/api/MyPluginClient.ts
import { ResponseError } from '@backstage/errors';
import type { Item, CreateItemBody } from '@internal/my-plugin-common';

interface ClientOptions {
  discoveryApi: { getBaseUrl(pluginId: string): Promise<string> };
  fetchApi: { fetch: typeof fetch };
}

export class MyPluginClient {
  constructor(private readonly options: ClientOptions) {}

  async getItems(): Promise<{ items: Item[] }> {
    const baseUrl = await this.options.discoveryApi.getBaseUrl('my-plugin');
    const res = await this.options.fetchApi.fetch(`${baseUrl}/items`);
    if (!res.ok) throw await ResponseError.fromResponse(res);
    return res.json();
  }

  async createItem(body: CreateItemBody): Promise<Item> {
    const baseUrl = await this.options.discoveryApi.getBaseUrl('my-plugin');
    const res = await this.options.fetchApi.fetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await ResponseError.fromResponse(res);
    return res.json();
  }
}
```

### 4.2 API Ref (in -react OR directly in the frontend plugin)

```ts
// plugins/my-plugin/src/api/ref.ts
import { createApiRef } from '@backstage/core-plugin-api';
import type { MyPluginClient } from './MyPluginClient';

export const myPluginApiRef = createApiRef<MyPluginClient>({
  id: 'plugin.my-plugin.service',
});
```

### 4.3 Provide API via ApiBlueprint

```ts
// plugins/my-plugin/src/alpha/apis.ts
import { discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import { ApiBlueprint } from '@backstage/frontend-plugin-api';
import { myPluginApiRef } from '../api/ref';
import { MyPluginClient } from '../api/MyPluginClient';

export default ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: myPluginApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: ({ discoveryApi, fetchApi }) =>
        new MyPluginClient({ discoveryApi, fetchApi }),
    }),
});
```

### 4.4 Routes

```ts
// plugins/my-plugin/src/routes.ts
import { createRouteRef } from '@backstage/frontend-plugin-api';
export const rootRouteRef = createRouteRef();
```

### 4.5 Plugin Definition

```ts
// plugins/my-plugin/src/alpha/plugin.tsx
import { createFrontendPlugin, PageBlueprint, NavItemBlueprint } from '@backstage/frontend-plugin-api';
import { rootRouteRef } from '../routes';
import apis from './apis';
import MyIcon from '@material-ui/icons/Extension';

const myPage = PageBlueprint.make({
  params: {
    routeRef: rootRouteRef,       // Omit routeRef for simple plugins that
    path: '/my-plugin',           //   don't need cross-plugin route links.
    loader: () => import('../components/MyPage').then(m => <m.MyPage />),
  },
});

const myNavItem = NavItemBlueprint.make({
  params: { routeRef: rootRouteRef, title: 'My Plugin', icon: MyIcon },
});

export default createFrontendPlugin({
  pluginId: 'my-plugin',
  title: 'My Plugin',
  icon: <MyIcon fontSize="inherit" />,
  info: {
    packageJson: () => import('../../package.json'), // REQUIRED for published plugins
  },
  routes: { root: rootRouteRef },
  extensions: [apis, myPage, myNavItem],
});
```

### 4.6 Page Component (with TanStack Query)

```tsx
// plugins/my-plugin/src/components/MyPage.tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@backstage/core-plugin-api';
import { myPluginApiRef } from '../api/ref';
import { Content, ContentHeader, Progress, ErrorDisplay } from '@backstage/core-components';

export function MyPage() {
  const api = useApi(myPluginApiRef);
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['my-plugin', 'items'],
    queryFn: () => api.getItems(),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => api.createItem({ name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['my-plugin', 'items'] }),
  });

  if (isLoading) return <Progress />;
  if (error) return <ErrorDisplay error={error} />;

  return (
    <Content>
      <ContentHeader title="My Plugin">
        <button onClick={() => createMutation.mutate('new-item')}>
          Create Item
        </button>
      </ContentHeader>
      <ul>
        {data?.items.map(item => (
          <li key={item.id}>{item.name} ({item.status})</li>
        ))}
      </ul>
    </Content>
  );
}
```

---

## Cross-Plugin Communication Patterns

Plugins communicate through shared libraries (`-react`, `-node`, `-common`) and extension inputs, never through direct imports of each other's plugin packages.

### Frontend-to-Frontend: Extension Inputs (Primary Pattern)

Extensions accept inputs from other plugins. The catalog entity page accepts `EntityContentBlueprint` extensions from TechDocs, Kubernetes, etc.:

```tsx
// Plugin-A: Define an extensible extension with inputs
import { createExtensionInput, coreExtensionData } from '@backstage/frontend-plugin-api';

const myPage = PageBlueprint.makeWithOverrides({
  inputs: {
    cards: createExtensionInput([
      coreExtensionData.reactElement,
      MyCardBlueprint.dataRefs.title,
    ]),
  },
  factory(originalFactory, { inputs }) {
    return originalFactory({
      path: '/my-page',
      loader: async () => {
        const cards = inputs.cards.map(c => ({
          element: c.get(coreExtensionData.reactElement),
          title: c.get(MyCardBlueprint.dataRefs.title),
        }));
        return <MyPage cards={cards} />;
      },
    });
  },
});

// Plugin-B: Attach to Plugin-A's input
import { MyCardBlueprint } from '@internal/plugin-a-react';
const myCard = MyCardBlueprint.make({
  params: { title: 'My Card', loader: () => import('./Card') },
});
```

### Frontend-to-Frontend: Custom Blueprints

Publish blueprints from `-react`. Other plugins import and use them:

```tsx
// In plugin-a-react:
export const MyWidgetBlueprint = createExtensionBlueprint({
  kind: 'my-widget',
  attachTo: { id: 'api:plugin-a/widgets', input: 'widgets' },
  output: [myWidgetDataRef],
  dataRefs: { widget: myWidgetDataRef },
  *factory(params) { yield myWidgetDataRef(params); },
});

// In plugin-b:
import { MyWidgetBlueprint } from '@internal/plugin-a-react';
const widget = MyWidgetBlueprint.make({ name: 'my-widget', params: { ... } });
```

### Frontend-to-Frontend: Utility APIs

Share data and services (not UI) via `createApiRef` + `ApiBlueprint`:

```tsx
// Define in -react:
export const myApiRef = createApiRef<MyApi>({ id: 'plugin.my-api' });
// Provide in plugin-a via ApiBlueprint:
const apiExt = ApiBlueprint.make({ params: { api: myApiRef, factory: () => new MyApiImpl() } });
// Consume in plugin-b:
const api = useApi(myApiRef);
```

### Frontend-to-Frontend: Routes

Cross-plugin navigation via route references:

```tsx
// Plugin-A provides:
routes: { catalogIndex: rootRouteRef }
// Plugin-B consumes:
externalRoutes: { catalog: catalogRouteRef }
// Generate link:
const catalogLink = useRouteRef(catalogRouteRef)();
```

### Backend-to-Backend: Extension Points (module → plugin)

Modules extend plugins via extension points (see Phase 6).

### Backend-to-Backend: Service Refs (plugin → plugin)

```ts
// Plugin-A-node exports:
export const myServiceRef = createServiceRef<MyService>({ id: 'plugin-a.myService' });
// Plugin-B consumes:
env.registerInit({
  deps: { myService: myServiceRef },
  async init({ myService }) { await myService.doSomething(); },
});
```

### Backend-to-Backend: REST API (discovery-based)

```ts
const baseUrl = await discovery.getBaseUrl('plugin-a');
const data = await fetch(`${baseUrl}/v1/data`).then(r => r.json());
```

---

## Decision Matrix: When to Create What

| Goal | Create | Key APIs |
|---|---|---|
| New page/UI | `frontend-plugin` (`x`) | `createFrontendPlugin` + `PageBlueprint` |
| New sidebar link | within `x` | `NavItemBlueprint` |
| New backend API + DB | `backend-plugin` (`x-backend`) | `createBackendPlugin` + `coreServices.database` |
| Add entity provider to catalog | `x-backend-module-<name>` targeting `catalog` | `catalogProcessingExtensionPoint` |
| Add scaffolder action | `x-backend-module-<name>` targeting `scaffolder` | `scaffolderActionsExtensionPoint` |
| Add search collator | `x-backend-module-<name>` targeting `search` | Search engine extension point |
| Add auth provider | `x-backend-module-<name>` targeting `auth` | Auth provider extension point |
| Share React components | `x-react` (web-library) | Export components, hooks, blueprints |
| Expose extension points | `x-node` (node-library) | `createExtensionPoint` |
| Share types/permissions | `x-common` (common-library) | Export types, `createPermission` |
| Add entity card to catalog | within any frontend-plugin | `EntityCardBlueprint` from catalog-react |
| Conditional feature loading | backend feature loader | `createBackendFeatureLoader` |
| Customize existing plugin | frontend override or backend module | `plugin.withOverrides()` or `createBackendModule` |

--- (if extending another plugin)

```ts
// plugins/my-plugin-backend-module-processor/src/module.ts
import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node/alpha';

export default createBackendModule({
  pluginId: 'catalog',
  moduleId: 'my-processor',
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        // Plugin-scoped: these receive the CATALOG's scoped instances
        database: coreServices.database,
      },
      async init({ catalog, logger, config, database }) {
        catalog.addProcessor(new MyProcessor());
        logger.info('My processor registered');

        // If adding HTTP handlers:
        // httpRouter.use(router);
        // Routes auto-prefixed: /api/catalog/modules/my-processor/...

        // If adding database tables:
        // Use prefix: my_plugin_backend_module_processor__<table>
        // Use prefixed migration table too:
        // await knex.migrate.latest({
        //   directory: migrationsDir,
        //   tableName: 'my_plugin_backend_module_processor__knex_migrations',
        // });
      },
    });
  },
});
```

**Module `package.json` — the `backstage` stanza MUST include `pluginId` and `pluginPackage`** for the framework to properly namespace plugin-scoped services:

```json
{
  "name": "@backstage/plugin-catalog-backend-module-my-processor",
  "backstage": {
    "role": "backend-plugin-module",
    "pluginId": "catalog",
    "pluginPackage": "@backstage/plugin-catalog-backend"
  },
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@backstage/backend-plugin-api": "workspace:^",
    "@backstage/plugin-catalog-node": "workspace:^",
    "knex": "^3.0.0"
  },
  "devDependencies": {
    "@backstage/cli": "workspace:^"
  }
}
```

Omitting `pluginId` or `pluginPackage` prevents the framework from scoping services (database, logger, config) to the target plugin, and the module will fail at initialization.

**Key module rules:**
- Depend on the `-node` library, NEVER the plugin package directly
- Plugin-scoped services are auto-namespaced to the TARGET plugin
- HTTP handlers go under `/modules/<module-id>/`
- Database tables must be prefixed: `<package>__<table>`
- If you need a per-instance unique worker ID (for job queue locking, etc.), use `uuid` (`workspace:^`) or `crypto.randomUUID()`

### Using the Scheduler in Modules

Modules that need background workers use `coreServices.scheduler` with `scheduleTask`:

```ts
import { v4 as uuidv4 } from 'uuid';

env.registerInit({
  deps: {
    scheduler: coreServices.scheduler,
    lifecycle: coreServices.lifecycle,
    database: coreServices.database,
    logger: coreServices.logger,
  },
  async init({ scheduler, lifecycle, database, logger }) {
    const db = await database.getClient();
    const workerId = uuidv4();

    // Fast polling worker (5-second interval)
    scheduler.scheduleTask({
      id: 'my-worker',
      frequency: { seconds: 5 },
      timeout: { seconds: 30 },
      fn: async () => {
        // Dequeue and process batch
        const batch = await myQueue.dequeue(100);
        if (batch.length === 0) return;

        for (const item of batch) {
          try {
            await processItem(item);
            await myQueue.complete([item.id]);
          } catch (error) {
            await myQueue.retry(item.id, error, item.attemptCount);
          }
        }
      },
    });

    // Slow periodic task (5-minute interval)
    scheduler.scheduleTask({
      id: 'my-periodic-check',
      frequency: { minutes: 5 },
      timeout: { seconds: 60 },
      fn: async () => {
        logger.debug('Running periodic check');
        // Scans for stale state, enqueues refreshes, etc.
      },
    });

    // Release locks on shutdown
    lifecycle.addShutdownHook(async () => {
      await db('my_queue_table')
        .where('locked_by', workerId)
        .update({ locked_at: null, locked_by: null });
    });
  },
});
```

**Scheduler rules:**
- Schedule IDs must be unique within the module (they're scoped to the plugin).
- Set conservative `timeout` values — tasks that exceed their timeout are killed.
- Always pair `scheduleTask` with `lifecycle.addShutdownHook()` to release any held locks or connections.
- For job queues, generate a per-process `workerId` (UUID) so multiple instances don't collide on locks.

---

## Phase 6: Register Extension Points (if YOUR plugin is extended)

```ts
// packages/my-plugin-node/src/extensions.ts
import { createExtensionPoint } from '@backstage/backend-plugin-api';

export interface MyProcessingExtensionPoint {
  addProcessor(processor: MyProcessor): void;
}

export const myProcessingExtensionPoint =
  createExtensionPoint<MyProcessingExtensionPoint>({
    id: 'my-plugin.processing',
  });
```

```ts
// In your plugin's register():
const processors: MyProcessor[] = [];

// Simple approach (most common):
env.registerExtensionPoint(myProcessingExtensionPoint, {
  addProcessor(processor) { processors.push(processor); },
});

// Factory approach (per-module error attribution):
env.registerExtensionPoint({
  extensionPoint: myProcessingExtensionPoint,
  factory: context => ({
    addProcessor(processor) {
      processors.push({ processor, context });
    },
  }),
});
// Later on failure:
// context.reportModuleStartupFailure({ error: new ForwardedError(...) });

env.registerInit({
  deps: { ... },
  async init({ ... }) {
    // processors array is fully populated here
    // All modules' init() complete BEFORE plugin's init()
    for (const entry of processors) {
      // Use each processor
    }
  },
});
```

**Extension point design rules:**
- Always additive: `addX()`, never `removeX()`
- Modules are uninstalled to disable behavior
- If only one implementation allowed: `setX()` with error on duplicate
- Naming: Interface=`CatalogProcessingExtensionPoint`, Ref=`catalogProcessingExtensionPoint`, ID=`catalog.processing`
- **Registration order:** `env.registerExtensionPoint()` BEFORE `env.registerInit()`. Module `registerInit` runs first, then plugin `registerInit`. By the time plugin init fires, all sources/processors/providers have been collected.

### Extension Point with Collection (Full Pattern)

```ts
// plugin.ts — the plugin that OWNS the extension point
export default createBackendPlugin({
  pluginId: 'my-plugin',
  register(env) {
    // Collect contributions from modules BEFORE plugin init
    const sources: MySource[] = [];

    // 1. Register extension point (collectors only)
    env.registerExtensionPoint(mySourceExtensionPoint, {
      addSource(source: MySource) { sources.push(source); },
    });

    // 2. Plugin init — all modules have already registered
    env.registerInit({
      deps: { database: coreServices.database, logger: coreServices.logger },
      async init({ database, logger }) {
        const db = await database.getClient();

        // 3. Connect all collected sources
        for (const source of sources) {
          const handler = new MyBoundHandler(db, source.name);
          try {
            await source.connect(handler);
            logger.info(`Source connected: ${source.name}`);
          } catch (error) {
            logger.error(`Failed to connect source: ${source.name}`, error);
          }
        }

        logger.info(`Initialized with ${sources.length} source(s)`);
      },
    });
  },
});
```

---

## Phase 7: Testing

### Backend Router Test

```ts
// plugins/my-plugin-backend/src/router.test.ts
import { mockServices } from '@backstage/backend-test-utils';

describe('createRouter', () => {
  it('returns items', async () => {
    const router = await createRouter({
      httpAuth: mockServices.httpAuth(),
      permissions: mockServices.permissions(),
      auth: mockServices.auth(),
      discovery: mockServices.discovery(),
      logger: mockServices.logger(),
    });

    const response = await request(router).get('/items');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('items');
  });
});
```

### Frontend Component Test

```tsx
// plugins/my-plugin/src/components/MyPage.test.tsx
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TestApiProvider } from '@backstage/test-utils';
import { myPluginApiRef } from '../api/ref';
import { MyPage } from './MyPage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

test('renders items', async () => {
  const mockApi = {
    getItems: jest.fn().mockResolvedValue({
      items: [{ id: '1', name: 'Test', status: 'active', createdAt: '' }],
    }),
    createItem: jest.fn(),
  };

  render(
    <TestApiProvider apis={[[myPluginApiRef, mockApi]]}>
      <QueryClientProvider client={queryClient}>
        <MyPage />
      </QueryClientProvider>
    </TestApiProvider>,
  );

  expect(await screen.findByText('Test')).toBeInTheDocument();
});
```

---

---

## Dynamic Frontend Plugins (Experimental)

> **Status: Experimental** — Subject to change. Applicable only to the new frontend system.

Dynamic frontend plugins use Webpack Module Federation to load plugin code at **runtime** rather than bundling at build time.

### Setup

```bash
yarn workspace app add @backstage/frontend-dynamic-plugins
```

### Package Role

```json
{ "backstage": { "role": "frontend-dynamic-plugin" } }
```

### Runtime Loading Config

```yaml
app:
  dynamicPlugins:
    frontend:
      my-dynamic-plugin:
        entryPoint: 'my-dynamic-plugin'
        resourceLocations:
          - https://plugins.example.com/my-plugin/1.0.0/remoteEntry.js
        mountPoints:
          - mountPoint: entity.page.catalog
            scope: entity
```

### When to Use

- **Dynamic:** Independent deployment cycle, third-party distribution, multi-tenant instances
- **Build-time (default):** You control deployment, want simpler debugging, need full extension access

### Limitations

No backend dynamic plugins yet. No built-in version negotiation. Dev workflow differs (separate host shell). No hot reload.

---

## Backend Feature Loader (Conditional Loading)

```ts
import { createBackendFeatureLoader, coreServices } from '@backstage/backend-plugin-api';

export default createBackendFeatureLoader({
  deps: { config: coreServices.rootConfig },
  *loader({ config }) {
    if (config.getOptionalBoolean('features.search')) {
      yield import('@backstage/plugin-search-backend');
      yield import('@backstage/plugin-search-backend-module-catalog');
    }
  },
});
```

Only root-scoped services allowed. Generator function yields features. Used when features should be conditionally enabled based on config.

---

## Full File Inventory (Complete Plugin)

```
plugins/
  my-plugin/                              frontend-plugin
    src/
      alpha.tsx                           barrel: re-exports ./alpha/plugin
      alpha/
        plugin.tsx                        createFrontendPlugin + extensions
        apis.ts                           ApiBlueprint providing myPluginApiRef
      api/
        MyPluginClient.ts                 Manual fetch client
        ref.ts                            createApiRef
      components/
        MyPage.tsx                        React component with TanStack Query
      routes.ts                           createRouteRef
      index.ts                            default export
    dev/
      index.ts                            Dev app for isolated development
    package.json                          role: frontend-plugin

  my-plugin-backend/                      backend-plugin
    src/
      plugin.ts                           createBackendPlugin + registerInit
      router.ts                           Express router with permissions
      index.ts                            default export
    migrations/
      20240101000000_init.js              Knex migration
    config.d.ts                           Config schema
    package.json                          role: backend-plugin, configSchema

packages/
  my-plugin-common/                       common-library (optional)
    src/
      index.ts                            Types, permissions
      permissions.ts                      createPermission definitions

  my-plugin-node/                         node-library (optional)
    src/
      extensions.ts                       Extension point interfaces + refs
```

---

## Wiring Checklist (Install in App)

```ts
// packages/backend/src/index.ts
backend.add(import('@internal/plugin-my-plugin-backend'));
```

```ts
// packages/app/src/App.tsx (only needed if NOT using feature discovery)
import myPlugin from '@internal/plugin-my-plugin';
const app = createApp({ features: [myPlugin] });
```

```yaml
# app-config.yaml (auth policy for health endpoint)
backend:
  auth:
    dangerouslyDisableDefaultAuthPolicy: false  # Keep default auth
```

---

## Migration: Old → New System

### Frontend Plugin

| Old System | New System |
|---|---|
| `createPlugin({ id: 'x', apis: [...] })` | `createFrontendPlugin({ pluginId: 'x', extensions: [apis, ...] })` |
| `createApiFactory({ api: ref, deps, factory })` | `ApiBlueprint.make({ params: defineParams => defineParams({ api: ref, deps, factory }) })` |
| `createRoutableExtension({ mountPoint, component })` | `PageBlueprint.make({ params: { routeRef, loader } })` |
| `createComponentExtension({ component })` | `EntityCardBlueprint.make({ params: { loader } })` |
| `EntitySwitch` + `EntityLayout.Route` | `EntityContentBlueprint.make()` — auto-attaches via `attachTo` |
| `useEntity()` from `@backstage/plugin-catalog-react` | `useAsyncEntity()` from same package |
| Routes: `createRouteRef()` in `plugin.ts` | `createRouteRef()` in `routes.ts`, passed to `routes` option |

### Backend Plugin

| Old System | New System |
|---|---|
| `createRouter(...): Promise<express.Router>` export | `createBackendPlugin({ pluginId, register(env) { env.registerInit({...}) } })` |
| Services from `@backstage/backend-common` | Services from `coreServices` in `@backstage/backend-plugin-api` |
| `getRootLogger()` | `coreServices.logger` (plugin-scoped) or `coreServices.rootLogger` |
| `loadBackendConfig()` | `coreServices.rootConfig` |
| `SingleHostDiscovery` / `UrlReaders` | `coreServices.discovery` / `coreServices.urlReader` |
| `DatabaseManager` | `coreServices.database` |
| `TaskScheduler` | `coreServices.scheduler` |
| Manual Express app creation | `coreServices.httpRouter.use(router)` — auto-prefixed at `/api/<pluginId>` |

### Backend Module

| Old System | New System |
|---|---|
| `createRouter` with plugin-specific wiring | `createBackendModule({ pluginId, moduleId, register })` |
| Manual extension points | `createExtensionPoint` + `env.registerExtensionPoint()` |

## Common Pitfalls
## Common Pitfalls

1. **Module depends directly on plugin package**
2. **Extension point with remove methods** — Design additive-only (`addProvider`). Users uninstall modules to remove behavior.
3. **Missing `info.packageJson` loader** — `packageJson: () => import('../package.json')` is REQUIRED for published frontend plugins.
4. **Extension ID conflicts** — Two extensions with same ID in one app = error.
5. **`config.d.ts` not in `package.json`** — Add `"configSchema": "config.d.ts"` to enable config type discovery.
6. **One module per package** — Each `-backend-module-*` exports exactly one module.
7. **`.make()` when extension needs inputs** — Use `.makeWithOverrides()` for extensible extensions.
8. **Missing `@visibility`** — Fields default to `backend`. Frontend needs `@visibility frontend`. Secrets need `@visibility secret`.
9. **No default export** — Every plugin/module package must `export default` its instance from `src/index.ts`.
10. **Module table name collisions** — Prefix: `<packageName>__<tableName>`, custom migration table names.
11. **No shutdown cleanup** — Use `lifecycle.addShutdownHook()` for DB connections and intervals.
12. **Storing tokens** — Always call `auth.getPluginRequestToken()` immediately before each request. Tokens expire.
13. **Calling `httpAuth.credentials()` for validation** — The credentials barrier already validated the token. Only call when you need the credentials object for permissions or user info.
14. **Throwing raw `Error`** — Throw `@backstage/errors` types (`InputError`, `NotFoundError`, `NotAllowedError`, etc.) for proper HTTP status codes.
15. **Duplicating middleware** — The framework handles CORS, logging, compression, error serialization, rate limiting, lifecycle gating, and auth validation. You write only route handlers + permission checks + auth policy exceptions.
16. **Mocking HTTP in tests** — Mock the ApiRef, not fetch or the HTTP layer.
17. **No `encodeURIComponent` for path params** — Manual URL construction needs encoding.
18. **Missing `Content-Type` for POST/PUT`** — `express.json()` needs the header.
19. **`workspace:^` for non-Backstage packages** — ONLY use `workspace:^` for `@backstage/*` and `@internal/*` packages. npm packages like `express`, `uuid`, `knex`, `lodash` must use semver ranges (`^4.17.1`, `^11.0.0`, `^3.0.0`). Using `workspace:^` on npm packages causes `Workspace not found` errors during `yarn install`.
20. **Extension point registration order** — Register extension points via `env.registerExtensionPoint()` BEFORE `env.registerInit()`. Module `registerInit` runs before plugin `registerInit`, so sources collected in `registerExtensionPoint` handlers are available during plugin init.
21. **Cross-plugin sibling imports** — Never import from a sibling plugin package via relative path (e.g., `../../status-backend-module-catalog/src/Foo`). Instead: (a) put shared types in a `-common` or `-node` library, (b) define a local interface adapter, or (c) use service refs via `createServiceRef`. Sibling relative imports cause circular dependency issues and don't survive package publishing.
22. **Yarn in managed monorepos** — Yarn 4+ managed through Corepack may not be on PATH. Use `node .yarn/releases/yarn-4.X.Y.cjs` to invoke Yarn reliably from any shell. For TypeScript checks, use `node_modules/.bin/tsc` directly instead of `yarn exec tsc` (which requires a populated node_modules state).

## Verification Checklist

- [ ] `yarn new` used to scaffold correct package types
- [ ] `package.json` has correct `backstage.role` for each package
- [ ] Backend plugin: `createBackendPlugin` with `registerInit` + service deps
- [ ] Backend router: Express `Router` with permission checks
- [ ] Database migrations created and run in `registerInit`
- [ ] Frontend plugin: `createFrontendPlugin` with `extensions: [apis, page, navItem]`
- [ ] `info.packageJson` loader in `createFrontendPlugin`
- [ ] `ApiBlueprint` provides API client using `discoveryApiRef` + `fetchApiRef`
- [ ] Page component uses TanStack Query (`useQuery`/`useMutation`)
- [ ] `httpRouter.addAuthPolicy()` for public routes BEFORE `httpRouter.use()`
- [ ] `permissionsRegistry.addPermissions()` registered permissions
- [ ] Permissions checked via `permissions.authorize()` in route handlers
- [ ] `lifecycle.addShutdownHook()` for DB cleanup
- [ ] Config schema in `config.d.ts` with `@visibility` annotations
- [ ] `configSchema` in `package.json` for config-using packages
- [ ] Default export from each package's `src/index.ts`
- [ ] Module depends on `-node`, not the plugin package
- [ ] Module DB tables prefixed: `<package>__<table>`
- [ ] Token fresh per service-to-service call (never stored)
- [ ] Tests mock ApiRef, not HTTP layer
- [ ] `yarn tsc` passes
- [ ] `CI=1 yarn test <path>` passes
- [ ] Changeset in `/.changeset/` for non-private packages

## References

- `references/catalog-status-case-study.md` — Complete implementation walkthrough of a 6-package plugin (Catalog Status API v3.2). Covers cross-package import patterns, workspace:^ gotchas, lockfile management, old/new frontend system integration, stale boundary checker pattern.
