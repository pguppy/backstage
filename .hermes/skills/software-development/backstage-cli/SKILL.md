---
name: backstage-cli
description: "Use when running Backstage CLI commands: yarn new (scaffolding), yarn start, yarn test, yarn tsc, yarn lint, yarn prettier, yarn build:api-reports, yarn storybook, yarn backstage-cli translations export/import, and all other development commands. Covers the complete package role system and what each command does."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, cli, commands, yarn, scaffolding, testing, linting, building, translations]
    related_skills: [backstage-plugin-blueprint, backstage-core-services, backstage-testing, backstage-app-config]
---

# Backstage CLI — Complete Command Reference

## Overview

The Backstage CLI (`backstage-cli`) is the primary tool for developing Backstage plugins and apps. All commands run from the monorepo root via `yarn`. The CLI auto-discovers installed `@backstage/cli-module-*` packages for extensibility.

## Package Role System

Every package declares a `backstage.role` in `package.json`. This determines how it builds and what tools apply:

| Role | Platform | Output | Description |
|---|---|---|---|
| `frontend` | web | bundle | Frontend app (bundled with webpack/vite) |
| `backend` | node | bundle | Backend app (bundled Node.js) |
| `cli` | node | cjs | CLI package (CommonJS) |
| `web-library` | web | types, esm | Shared frontend library |
| `node-library` | node | types, cjs | Shared backend library |
| `common-library` | common | types, esm, cjs | Isomorphic library |
| `frontend-plugin` | web | types, esm | Frontend plugin package |
| `frontend-plugin-module` | web | types, esm | Frontend plugin module |
| `backend-plugin` | node | types, cjs | Backend plugin package |
| `backend-plugin-module` | node | types, cjs | Backend plugin module |

## Scaffolding (`yarn new`) — Correct Template IDs

Creates new packages. The `--select` parameter uses these EXACT template names (verified CLI v0.32.1):

| Package Type | `--select` Value | Creates | Role in package.json |
|---|---|---|---|
| Common library | `plugin-common-library` | `plugins/<id>-common/` | `common-library` |
| Node library | `plugin-node-library` | `plugins/<id>-node/` | `node-library` |
| Backend plugin | `backend-plugin` | `plugins/<id>-backend/` | `backend-plugin` |
| Web library (React) | `plugin-web-library` | `plugins/<id>-react/` | `web-library` |
| Frontend plugin | `frontend-plugin` | `plugins/<id>/` | `frontend-plugin` |
| Backend module | `backend-plugin-module` | `plugins/<target>-backend-module-<name>/` | `backend-plugin-module` |

**Usage:**
```bash
# Use pluginId (NOT the deprecated 'id' parameter):
echo "" | yarn backstage-cli new --select plugin-common-library --option pluginId=my-feature

# For backend modules, also pass moduleId:
echo "" | yarn backstage-cli new --select backend-plugin-module --option pluginId=catalog --option moduleId=status
```

**Pitfalls:**
- If `yarn` is not in PATH, use `node .yarn/releases/yarn-4.8.1.cjs` instead (auto-detected from `.yarnrc.yml`).
- The CLI prompts for a CODEOWNERS owner interactively. Pipe `echo ""` to skip.
- The `--option id=<name>` parameter is deprecated — use `--option pluginId=<name>`.
- Backend plugins generate a `src/services/TodoListService/` demo — delete it after scaffolding.
- Frontend plugins generate `src/components/ExampleComponent/` and `ExampleFetchComponent/` — delete them.
- The simpler names (`plugin-common`, `plugin-node`, `plugin-web`) produce "Template not found" errors.

**Generated files for a frontend plugin:**
```
plugins/<pluginId>/
  src/
    index.ts          ← default export re-export
    plugin.tsx        ← createFrontendPlugin definition (new system) or createPlugin (legacy)
    routes.ts         ← route refs
    setupTests.ts
    components/
      ExampleComponent/      ← DELETE (demo code)
      ExampleFetchComponent/ ← DELETE (demo code)
  package.json        ← role: frontend-plugin
  .eslintrc.js
  dev/index.tsx        ← isolated dev server entry
  README.md
```

**Generated files for a backend plugin:**
```
plugins/<pluginId>-backend/
  src/
    index.ts          ← default export re-export
    plugin.ts         ← createBackendPlugin definition
    router.ts         ← Express router setup
  package.json        ← role: backend-plugin
  migrations/         ← Knex migration directory
```

## Development Server

```bash
yarn start                    # Start frontend (:3000) + backend (:7007)
yarn start:docker             # Start with Docker (Postgres, OpenSearch, Redis)
yarn start:legacy             # Start legacy frontend + backend
yarn start:microsite          # Start documentation microsite
PORT=8080 yarn start          # Custom port

# Start a single plugin in isolation:
yarn workspace @backstage/plugin-catalog start
yarn workspace @backstage/plugin-catalog start --check  # With type checking + linting
```

## Type Checking

```bash
yarn tsc                      # TypeScript type checking (incremental, skips lib checks)
yarn tsc --watch              # Watch mode
yarn tsc:full                 # Full type checking (no skipLibCheck, no incremental)
                              # Used in CI — slower but thorough
```

Run from project root only. TypeScript configured via root `tsconfig.json`.

## Testing

```bash
CI=1 yarn test <path>               # Test specific file or directory
CI=1 yarn test plugins/catalog/     # Test catalog plugin only
yarn test --no-watch                # Test changed packages, disable watch mode
yarn test:all                       # Test ALL packages with coverage
yarn test:e2e                       # E2E tests with Playwright
```

**Always provide a path** — avoid running all tests. `CI=1` ensures consistent behavior. Tests use Jest with SWC transform.

## Linting

```bash
yarn lint                     # Lint packages changed since origin/master
yarn lint --fix               # Auto-fix lint issues
yarn lint:all                  # Lint ALL packages
yarn lint:docs                 # Lint markdown files (requires Vale)
yarn lint:type-deps            # Validate @types/* dependency placement
yarn lint:peer-deps            # Check peer dependency consistency
yarn lint:circular-deps        # Check for circular dependencies
```

Lint-staged runs automatically on pre-commit (via Husky) for staged files. ESLint config at root `.eslintrc.js`.

## Formatting

```bash
yarn prettier --write <paths>        # Format specific files
yarn prettier --write plugins/catalog/src/App.tsx
yarn prettier:check .                # Check formatting without writing
yarn prettier:fix .                  # Format everything (use sparingly)
```

**Run explicitly for changed file paths, not entire folders** — avoids reformatting unrelated files.

## Building

```bash
yarn build:all               # Build all packages
yarn build:backend           # Build example backend
yarn build:api-reports       # Generate API reports for ALL packages
yarn build:api-reports plugins/<plugin>  # Generate API report for specific plugin

# Storybook (component development):
yarn storybook               # Start Storybook on port 6006
yarn build-storybook         # Build static Storybook
```

**Never run `yarn build` or `yarn release`** — builds and releases are handled by CI workflows.

## Cleaning

```bash
yarn clean                   # Remove all output folders + CLI cache
```

## Translations (i18n)

```bash
# Export default English messages from all plugins:
cd packages/app
yarn backstage-cli translations export

# This creates:
#   translations/manifest.json
#   translations/messages/<pluginId>.en.json

# After translating .json files to target languages:
yarn backstage-cli translations import

# This generates:
#   src/translations/resources.ts (auto-wired translation resources)

# Custom file pattern:
yarn backstage-cli translations export --pattern '{lang}/{id}.json'
```

## Package Maintenance

```bash
yarn diff                     # Compare plugins against latest template — shows drift
yarn fix                      # Auto-fix publishable package issues
yarn fix --publish            # Fix and prepare for publishing
yarn new                      # Scaffold new plugin/package/module
```

## Dependency Management

```bash
yarn install                  # Install all dependencies (required before development)
yarn install --no-immutable   # Allow lockfile changes
```

Yarn 4.8.1 (Berry) with PnP disabled. Workspaces: `packages/*`, `plugins/*`. Patches in `/.patches/` applied via `resolutions` in root `package.json`.

## API Reports

```bash
yarn build:api-reports        # Generate API reports for ALL packages (required before PR)
yarn build:api-reports packages/<package>  # Specific package
yarn build:api-reports plugins/<plugin>    # Specific plugin
```

Uses API Extractor with TSDoc comments. Generates `.api.md` files per package. CI fails if reports are out of date.

## Storybook

```bash
yarn storybook                # Start on port 6006 — useful for core-components development
yarn build-storybook          # Build static Storybook to dist-storybook/
yarn build-storybook:chromatic  # Build with stats for Chromatic visual testing
```

## Other Commands

```bash
yarn techdocs-cli             # Run TechDocs CLI
yarn techdocs-cli:dev         # TechDocs CLI in dev mode
yarn snyk:test                # Snyk vulnerability scan
yarn mui-to-bui               # MUI → BUI migration analytics
yarn create-plugin            # Deprecated — use `yarn new` instead
yarn dev                      # Deprecated — use `yarn start` instead
```

## Scripts Per-Package

Every package has standard scripts:

```json
{
  "scripts": {
    "build": "backstage-cli package build",
    "clean": "backstage-cli package clean",
    "lint": "backstage-cli package lint",
    "prepack": "backstage-cli package prepack",
    "postpack": "backstage-cli package postpack",
    "start": "backstage-cli package start",
    "test": "backstage-cli package test"
  }
}
```

Run from workspace root: `yarn workspace <package-name> <script>`

## Common Pitfalls

1. **Running `yarn tsc` from a subdirectory** — Always run from project root. Uses root `tsconfig.json`.
2. **Forgetting `CI=1` for tests** — Without it, tests may behave differently (watch mode, snapshots).
3. **Running `yarn prettier --write .`** — Formats ALL files including unchanged ones. Always target specific paths.
4. **Skipping `yarn build:api-reports` before PR** — CI will fail. Must generate API reports for changed packages.
5. **Using `yarn build` or `yarn release`** — These are CI-only. Never run locally.
6. **Running `yarn install` without network** — Some dependencies need downloads. Use offline mirror if needed.
7. **Not running `yarn new` from project root** — Scaffolding must run from workspace root.

## Verification Checklist

- [ ] `yarn install` completed before any development
- [ ] `yarn tsc` passes after changes
- [ ] `CI=1 yarn test <path>` passes for changed packages
- [ ] `yarn lint --fix` applied to changed files
- [ ] `yarn prettier --write <paths>` for specific changed files
- [ ] `yarn build:api-reports` generated for changed packages
- [ ] Changeset created in `/.changeset/` for non-private packages
