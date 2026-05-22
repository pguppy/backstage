---
name: backstage-app-wiring
description: "Use when installing, configuring, or understanding how Backstage apps wire together. Covers: feature discovery (auto-install), manual plugin installation via createApp, backend wiring via backend.add(), extension tree, configuring extensions via app-config.yaml, and the full plugin installation lifecycle. Also covers how frontend and backend features compose into a running app."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, app, wiring, feature-discovery, createApp, backend, installation]
    related_skills: [backstage-plugin-blueprint, backstage-core-services, backstage-frontend-services, backstage-app-config]
---

# Backstage App Wiring

## How Plugins Get Installed

Backstage has two complementary wiring systems: the **frontend app** (`createApp`) and the **backend instance** (`createSpecializedBackend`). Plugins are independent NPM packages that get discovered and composed at startup.

---

## Frontend Wiring

### Feature Discovery (Recommended — Default)

Just `yarn add` the plugin. No code changes needed.

```bash
yarn --cwd packages/app add @backstage/plugin-catalog
```

Enabled by default in `app-config.yaml`:

```yaml
app:
  packages: all            # Auto-discover all @backstage/plugin-* deps
```

Filter with include/exclude:

```yaml
app:
  packages:
    include:
      - '@backstage/plugin-catalog'
      - '@backstage/plugin-scaffolder'
    # OR
    exclude:
      - '@backstage/plugin-deprecated-feature'
```

**How it works:** The `@backstage/cli` scans your app's `node_modules` for packages with `backstage.role: frontend-plugin`. Each discovered plugin's default export (`createFrontendPlugin` instance) gets added to the app extension tree. Duplicate plugins are deduplicated automatically — safe to manually install AND feature-discover the same plugin.

### Manual Installation

When feature discovery is disabled or you need explicit ordering:

```tsx
// packages/app/src/App.tsx
import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';

const app = createApp({
  features: [catalogPlugin],
});

export default app.createRoot();
```

Manual + auto-discovery coexist safely — the app deduplicates by plugin ID.

### 3rd-Party Plugins (Old Frontend System)

Old-system plugins (using `createPlugin` from `@backstage/core-plugin-api`) need conversion:

```tsx
import { convertLegacyApp } from '@backstage/core-compat-api';
// See docs/frontend-system/building-apps/06-plugin-conversion.md
```

---

## Backend Wiring

### The Backend Instance

```ts
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// Add plugins:
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend'));

// Add modules that extend plugins:
backend.add(import('@backstage/plugin-catalog-backend-module-github'));

// Add custom service factories:
backend.add(myCustomServiceFactory());

backend.start();
```

### What `createBackend()` Provides

Creates a `Backend` instance pre-loaded with ALL core service factories (24+ services):

`auditor`, `auth`, `cache`, `rootConfig`, `database`, `discovery`, `httpAuth`, `httpRouter`, `lifecycle`, `logger`, `permissions`, `permissionsRegistry`, `rootHealth`, `rootHttpRouter`, `rootLifecycle`, `rootLogger`, `scheduler`, `userInfo`, `urlReader`, `events`, `actionsRegistry`, `actions`, `metrics`, `tracing`, `instanceMetadata`

Every plugin runs in this container with full access to all services.

### `backend.add()` — Three Types of Features

| Feature Type | What It Is | Example |
|---|---|---|
| **Plugin** | `createBackendPlugin` instance | `import('@backstage/plugin-catalog-backend')` |
| **Module** | `createBackendModule` instance | `import('@backstage/plugin-catalog-backend-module-github')` |
| **Service Factory** | `createServiceFactory` instance | Custom service replacement |

All `.add()` calls are dynamic imports — lazy-loaded for fast startup.

### Initialization Order

```
1. All service factories instantiated (root-scoped singletons)
2. All modules' registerInit() called
3. All plugins' registerInit() called (extension points fully populated)
4. HTTP server starts
5. Backend signals "started" — requests begin processing
```

**Critical:** Modules init BEFORE plugins. Plugin extension points are guaranteed populated when plugin init runs.

---

## Extension Tree (How Frontend Renders)

The frontend app builds a single extension tree at startup:

```
app (root)
├── app/nav (sidebar)
│   ├── nav-item:catalog          ← catalog's NavItemBlueprint
│   └── nav-item:scaffolder       ← scaffolder's NavItemBlueprint
├── app/routes
│   ├── page:catalog              ← catalog's PageBlueprint
│   └── page:scaffolder           ← scaffolder's PageBlueprint
├── apis
│   ├── api:catalog               ← catalog's ApiBlueprint (catalogApiRef)
│   └── api:scaffolder            ← scaffolder's ApiBlueprint
└── entity-page:catalog/:kind/:namespace/:name
    ├── entity-content:catalog/overview
    ├── entity-content:techdocs/docs   ← techdocs EntityContentBlueprint
    └── entity-content:kubernetes      ← kubernetes EntityContentBlueprint
```

Each extension attaches to its parent via `attachTo`, sharing data through extension data refs. The tree is immutable at runtime.

---

## Configuring Extensions

Extensions can be configured via `app-config.yaml` without code changes:

```yaml
app:
  extensions:
    # Disable an extension
    - entity-content:catalog/overview:
        disabled: true

    # Override extension config
    - page:catalog:
        config:
          path: /services     # Change default route

    # Add extension-specific config
    - entity-content:techdocs/docs:
        config:
          techdocs:
            defaultPreview: true
```

---

## Multi-Instance Backends

Backstage supports splitting plugins across multiple backend instances for scaling:

```ts
// Instance 1: Catalog + Search
const catalogBackend = createBackend();
catalogBackend.add(import('@backstage/plugin-catalog-backend'));
catalogBackend.add(import('@backstage/plugin-search-backend'));

// Instance 2: Scaffolder + TechDocs
const scaffolderBackend = createBackend();
scaffolderBackend.add(import('@backstage/plugin-scaffolder-backend'));
scaffolderBackend.add(import('@backstage/plugin-techdocs-backend'));
```

Each instance has its own HTTP server, database, and lifecycle. They communicate via the `discovery` service (external URLs).

---

## Full Installation Checklist

### For a Frontend Plugin

```bash
# 1. Add dependency
yarn --cwd packages/app add @backstage/plugin-<name>

# 2. Done — feature discovery handles the rest
# If NOT using feature discovery:
```

```tsx
// packages/app/src/App.tsx
import myPlugin from '@backstage/plugin-<name>/alpha';
const app = createApp({ features: [myPlugin] });
```

### For a Backend Plugin

```bash
# 1. Add dependency
yarn --cwd packages/backend add @backstage/plugin-<name>-backend

# 2. Wire in code
```

```ts
// packages/backend/src/index.ts
backend.add(import('@backstage/plugin-<name>-backend'));
```

### For a Backend Module (extending another plugin)

```bash
yarn --cwd packages/backend add @backstage/plugin-catalog-backend-module-<name>
```

```ts
// packages/backend/src/index.ts
backend.add(import('@backstage/plugin-catalog-backend-module-<name>'));
```

---

## Common Pitfalls

1. **Forgetting `backend.add()`** — Adding the NPM dependency isn't enough for backend. Must also add via `backend.add()`.

2. **Feature discovery not enabled** — Check `app.packages: all` in `app-config.yaml`.

3. **Importing from wrong path** — New frontend plugins export from `/alpha`: `import plugin from '@backstage/plugin-<name>/alpha'`.

4. **Old system plugin without compat** — Old-system plugins need `@backstage/core-compat-api` wrapping.

5. **Duplicate plugin IDs** — Two plugins with same `pluginId` = error at startup.

6. **Missing package.json role** — Feature discovery only finds packages with `backstage.role: frontend-plugin`.

7. **Module install without target plugin** — Backend modules require their target plugin in the same backend instance.

8. **Multi-instance: shared database** — Splitting backends requires configuring the same database for catalog and other shared-state plugins.
