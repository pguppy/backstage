---
name: backstage-feature-scaffolder
description: "Use when creating a NEW Backstage feature that spans multiple packages (frontend, backend, common, node, react, modules). PRIMARY workflow: scaffold.py (one command, zero cleanup, 33 working source files). Legacy: yarn new + cleanup. Load templates/clean-plugin/ for the template system."
version: 1.2.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, scaffolding, feature, plugin, code-generation, templates, automation]
    related_skills: [backstage-plugin-blueprint, backstage-cli, backstage-core-services, backstage-frontend-services, backstage-backend-api, backstage-client-api, backstage-app-wiring, backstage-testing, backstage-ui-components, backstage-catalog-system, backstage-integration-patterns, backstage-code-review]
---

# Backstage Feature Scaffolder

## Quick Start (Verified Workflow — ONE terminal call)

**Use `scaffold.py` instead of `yarn new`.** It produces a clean 5-package scaffold with zero demo code, zero template cruft, zero `dev/index` files, and all `package.json` fields correct from the start. One command replaces 5 `yarn new` calls + cleanup.

```bash
python3 .hermes/skills/software-development/backstage-feature-scaffolder/templates/clean-plugin/scaffold.py \
  --id <plugin-id> \
  --name "<Human Readable Name>" \
  --target /path/to/backstage
```

**What you get (33 source files, zero cleanup needed):**

```
plugins/<id>-common/          common-library: types, permissions, openapi.yaml
plugins/<id>-node/            node-library:   types, extension points
plugins/<id>-backend/         backend-plugin: router, plugin, generated stub
plugins/<id>-react/           web-library:    ApiRef, hooks, testUtils, generated stub
plugins/<id>/                 frontend-plugin: plugin, DefaultClient, routes
```

**What you DON'T get (unlike `yarn new`):**
- ❌ No `ExampleComponent` or `ExampleFetchComponent` to delete
- ❌ No `TodoListService` to delete
- ❌ No `dev/index.*` template files
- ❌ No missing `exports` or `typesVersions` in package.json
- ❌ No missing `peerDependencies` or `peerDependenciesMeta`

**The old `yarn new` approach still works** if you prefer it, but `scaffold.py` is 5x faster and produces cleaner output. See Phase 1 below for the `yarn new` commands.

### Phase 1: Scaffold packages (yarn new — 5 terminal calls)

```bash
cd /path/to/backstage
YARN="node .yarn/releases/yarn-4.8.1.cjs"
echo "" | $YARN backstage-cli new --select plugin-common-library --option pluginId=<id>
echo "" | $YARN backstage-cli new --select backend-plugin --option pluginId=<id>
echo "" | $YARN backstage-cli new --select plugin-node-library --option pluginId=<id>
echo "" | $YARN backstage-cli new --select plugin-web-library --option pluginId=<id>
echo "" | $YARN backstage-cli new --select frontend-plugin --option pluginId=<id>
```

**Cleanup required after `yarn new`:**
```bash
rm -rf plugins/<id>-backend/src/services
rm -rf plugins/<id>/src/components/Example*
rm -rf plugins/<id>-react/src/components/Example*
rm -f plugins/<id>/dev/index.tsx plugins/<id>-backend/dev/index.ts
```

### Phase 2: Write ALL files + patch ALL package.json (1-2 terminal calls)

**Use a Python `<< 'PYEOF'` heredoc via terminal — the reliable batch-writing approach.** See `references/tool-patterns.md` for the full pattern.

The Python heredoc writes every source file in one terminal call, avoiding "sibling subagent" warnings and template-literal escaping issues. Then use a second Python script to batch-update all `package.json` files with exports, typesVersions, and peerDeps.

**⚠️ PITFALL: `&` kills Python heredoc.** If any file content contains `&` (JSX `{a && b}`, bash snippets, text with ampersands), write that specific file with `write_file` instead. The shell's background-subprocess detector triggers on the raw `&` character even in single-quoted heredocs.

**Total tool calls:** ~10 for a complete 5-package scaffold (5 yarn new + 1-2 Python batch writes + 1 package.json update + 1 validation). With individual `write_file` calls: ~35.

### Phase 2.5: Verify Generated Stubs (MANDATORY — NEVER SKIP)

The scaffold produces generated file stubs. You MUST verify they exist before writing any implementation code. Without them, imports from `./schema/openapi/generated/` fail.

**Step 1: Verify stubs exist**
```bash
test -f plugins/<id>-backend/src/schema/openapi/generated/router.ts && echo "Router OK" || echo "MISSING"
test -f plugins/<id>-common/src/schema/openapi/generated/Api.client.ts && echo "Client OK" || echo "MISSING"
test -f plugins/<id>-backend/config.d.ts && echo "Config OK" || echo "MISSING"
test -f plugins/<id>-backend/src/schema/openapi.yaml && echo "Spec backend OK" || echo "MISSING"
test -f plugins/<id>-common/src/schema/openapi.yaml && echo "Spec common OK" || echo "MISSING"
```

**Step 2: Try yarn generate (optional; stubs work without it)**
```bash
cd plugins/<id>-backend && yarn generate
```
If this fails with `Cannot find module '@apidevtools/swagger-parser'`, the stubs are sufficient. The repo has a known dependency issue with this package.

**Step 3: Load and run D-1 from code-review**
Before writing implementation code, load `backstage-code-review` and run Dimension -1. This forces you to:
- Plan the hook-per-operationId mapping BEFORE writing
- Plan the test coverage BEFORE writing
- Verify the foundation is solid

```bash
skill_view(name='backstage-code-review')  # Scroll to D-1
```

**Gates (ALL must pass before writing implementation code):**
- [ ] Generated router stub exists on disk
- [ ] Generated client stub exists on disk
- [ ] config.d.ts + configSchema exist
- [ ] OpenAPI spec exists in both -backend and -common
- [ ] D-1 checklist completed (hook plan, test plan)
- [ ] **Zero forbidden patterns**: `grep -rn "process.env" plugins/<id>-*/src/` must return nothing (except comments). `grep -rn "= Router()" plugins/<id>-backend/src/ | grep -v generated` must return nothing. `grep -rn "try {" plugins/<id>-backend/src/router.ts` must return nothing — the httpRouter error handler auto-maps `@backstage/errors` types to HTTP codes.

**Package.json reference:** `references/package-json-template.md` shows the complete structure with field-by-field documentation.
**Code organization:** `references/single-responsibility.md` — single-responsibility principle for Backstage plugins. Read before writing any implementation code.
**Template cleanup:** `references/template-cleanup.md` — exact `rm` commands to purge scaffolded demo files. Run immediately after `yarn new`.

### Phase 3: Fill in real implementation

After scaffolding, the template produces a working health-check example. To build your real feature:

1. **Replace the OpenAPI spec** in both `-common/src/schema/openapi.yaml` and `-backend/src/schema/openapi.yaml`
2. **Update the generated files** to match (the stubs in `-backend/src/schema/openapi/generated/` and `-common/src/schema/openapi/generated/`)
3. **Replace the backend router** with your real route handlers
4. **Replace the ApiRef interface** in `-react/src/api.ts` with your real methods
5. **Add TanStack Query hooks** — one per API method, in `-react/src/hooks/`
6. **Delete the scaffold's `useHealth` hook** from `-react/src/hooks/useHealth.ts` — it's a placeholder for the health-check example. Your hooks replace it.
7. **Update or delete ExamplePage** — it imports from the old ApiRef. Either update it to use your new hooks, or delete it and update `plugin.ts` to point to your real page.
8. **Extract all views to separate files** — no inline component functions in page files. Each view (DailyView, UsersView, etc.) gets its own `.tsx` file in `components/`.

**⚠️ CRITICAL GATE: Run `backstage-code-review` before showing the user.** After implementing your feature, load and run all dimensions:
```bash
skill_view(name='backstage-code-review')
```
Fix all 🔴 items before declaring work complete. The code-review catches bugs (tab switching, API wiring), convention violations (route placement, monoliths), and consistency issues (missing hooks, scaffold leftovers) that structural checks miss.

**For test patterns:** when writing integration tests, hook tests, or component tests, load `backstage-testing` with `skill_view(name='backstage-testing')`. It covers `startTestBackend`, `TestApiProvider`, TanStack Query wrappers, and mock API patterns.

- `references/tool-patterns.md` — **READ FIRST.** Documents verified tool-calling patterns: what works, what doesn't, and why. Shell heredocs, execute_code sandbox, patch patterns, Backstage API version notes.
- `scripts/scaffold.sh` — batched template fill script (REFERENCE ONLY — shell heredocs break on TypeScript template literals with `${}`. Do not execute. Read for template content.)
- `scripts/scaffold.py` — Python reference with embedded templates (REFERENCE ONLY — execute_code sandbox cannot write to project files. Read for patterns.)
- `templates/` — individual template files for the `write_file` approach (the primary way to fill templates)

## When To Use This Skill

Use when creating ANY new Backstage feature that needs more than a single frontend page.

**Don't use for:** Single-file changes to existing plugins. Use the relevant skill directly.

## Prerequisites

Before running, load these skills to understand the patterns:
- `backstage-plugin-blueprint` — overall plugin structure
- `backstage-cli` — `yarn new` commands and options

## Package Type Decision Tree

A complete Backstage feature typically needs these packages:

```
┌─────────────────────────────────────────────────────────────┐
│                   Package Type Decision                       │
├──────────────┬──────────────────────────────────────────────┤
│ -common      │ Shared types, interfaces, permissions         │
│              │ Used by: ALL other packages                   │
│              │ Role: common-library                          │
│              │ Creates: plugins/<id>-common/                 │
├──────────────┼──────────────────────────────────────────────┤
│ -node        │ Backend interface + extension points          │
│              │ Used by: backend plugin, other backend plugins│
│              │ Role: node-library                            │
│              │ Creates: plugins/<id>-node/                   │
├──────────────┼──────────────────────────────────────────────┤
│ -backend     │ Backend implementation (router, DB, services) │
│              │ Used by: backend instance                     │
│              │ Role: backend-plugin                          │
│              │ Creates: plugins/<id>-backend/                │
├──────────────┼──────────────────────────────────────────────┤
│ -react       │ Frontend React hooks + components             │
│              │ Used by: frontend plugin                      │
│              │ Role: web-library                             │
│              │ Creates: plugins/<id>-react/                  │
├──────────────┼──────────────────────────────────────────────┤
│ <id>         │ Frontend plugin (pages, entity cards, etc.)   │
│              │ Used by: frontend app                         │
│              │ Role: frontend-plugin                         │
│              │ Creates: plugins/<id>/                        │
├──────────────┼──────────────────────────────────────────────┤
│ -backend-    │ Backend module (extends another plugin)       │
│ module-<name>│ Used by: target plugin's backend              │
│              │ Role: backend-plugin-module                   │
│              │ Creates: plugins/<target>-backend-module-<n>/ │
└──────────────┴──────────────────────────────────────────────┘
```

### Minimal Feature (3 packages)

For simple features that only need a frontend with a backend API:
- `plugins/<id>-common/` — shared types
- `plugins/<id>-backend/` — backend implementation
- `plugins/<id>/` — frontend plugin

### Standard Feature (5 packages — REQUIRED)

**The `-react` package is mandatory for ALL frontend plugins.** Components, hooks, and API definitions live in `-react`. The frontend plugin (`<id>/`) is a thin wrapper that imports from `-react`.

- `plugins/<id>-common/` — shared types + permissions (`common-library`)
- `plugins/<id>-node/` — backend interface + extension points (`node-library`)
- `plugins/<id>-backend/` — backend implementation (`backend-plugin`)
- `plugins/<id>-react/` — **REQUIRED** — React components, hooks, API client (`web-library`)
- `plugins/<id>/` — frontend plugin — thin wrapper importing from `-react` (`frontend-plugin`)

### Minimal Feature (4 packages)

For features that extend the catalog backend:
- `plugins/catalog-backend-module-<name>/` — module only

### Scoping Rules

| If your feature... | Add these packages |
|---|---|
| Has a backend API | `-backend` |
| Shares types between frontend & backend | `-common` |
| Has an extension point for other plugins | `-node` |
| Has reusable React components | `-react` |
| Has a UI page | `<id>` (frontend plugin) |
| Extends catalog/scaffolder/search | `-backend-module-<name>` |
| Needs a database table | Add migration in `-backend` or `-backend-module` |
| Has permissions | Types in `-common`, integration in `-backend` |

## OpenAPI-Driven API Pattern (MANDATORY)

**Every backend plugin MUST generate its router and client from an OpenAPI spec.** This is non-negotiable. The catalog plugin demonstrates the canonical approach. See `references/openapi-pattern.md` for the full analysis.

A manual Express router (raw `Router()`, inline handlers) is a code smell and will be rejected. The generated router provides typed handlers, automatic request validation, and OpenAPI spec serving at `/openapi.json` — all for free.

### Quick Reference

1. **`<id>-common/src/schema/openapi.yaml`** — OpenAPI 3.0 spec (source of truth)
2. **Add generate script to `<id>-backend/package.json`**:
   ```json
   "generate": "backstage-repo-tools package schema openapi generate --server --client-package plugins/<id>-common"
   ```
3. **Run `yarn generate`** → produces auto-generated typed router + typed `DefaultApiClient` (in common, not react)
4. **Verify generated files exist** before proceeding:
   ```bash
   [ -f plugins/<id>-backend/src/schema/openapi/generated/router.ts ] || echo "MISSING!"
   [ -f plugins/<id>-common/src/schema/openapi/generated/Api.client.ts ] || echo "MISSING!"
   ```
5. **Backend**: `createOpenApiRouter({ operationId: handler, ... })` — typed handlers
6. **React `api.ts`**: `createApiRef<T>()` wraps the generated `DefaultApiClient`
7. **React `ApiFactory`**: `createApiFactory({ api: myApiRef, deps: { discoveryApi, fetchApi }, factory: ... })`

### Key Rules

- `operationId` in the spec becomes the generated function name (camelCase)
- The generated router + client files go in `generated/` — NEVER edit them manually
- `createApiRef` wraps the generated client, not the other way around
- The OpenAPI spec lives in `-common` because both frontend and backend consume it
- If `yarn generate` fails due to missing deps, create stub generated files matching the catalog patterns so the directory structure is correct, then document the missing dep

## Code Organization Principle — Single Responsibility

**No file over ~200 lines. No inline functions in components. No business logic in route handlers.**

Violation signals (reject before showing user):
- Router file >200 lines → extract aggregation/time-series/logic into separate service files
- Component file >200 lines → extract inline sub-views into separate component files
- Route handler doing NDJSON parsing, aggregation, OR GitHub API calls inline → extract into a service class
- 3+ functions defined inline in a component → each should be a separate file

### Required backend structure:
```
plugins/<id>-backend/src/
├── service/
│   ├── <Name>Service.ts        ← External API client (GitHub, etc.)
│   └── <Name>Aggregator.ts     ← Pure data transformation logic
├── router.ts                   ← Thin router (createOpenApiRouter or createRouter)
├── plugin.ts                   ← Plugin wiring
└── index.ts
```

### Required frontend structure:
```
plugins/<id>/src/components/
├── DashboardPage.tsx            ← Thin orchestrator (imports views, no inline functions)
├── SomeView.tsx                 ← One view per file
├── AnotherView.tsx              ← One view per file
└── index.ts                     ← Barrel export
```

See `references/single-responsibility.md` for the full rationale and anti-patterns.

## Scaffolding Process

### Correct `yarn new` Template IDs

The CLI's `--select` parameter uses these EXACT template names (verified May 2025, Backstage CLI v0.32.1):

| Package Type | `--select` Value | Creates |
|---|---|---|
| Common library | `plugin-common-library` | `plugins/<id>-common/` |
| Node library | `plugin-node-library` | `plugins/<id>-node/` |
| Backend plugin | `backend-plugin` | `plugins/<id>-backend/` |
| Web library (React) | `plugin-web-library` | `plugins/<id>-react/` |
| Frontend plugin | `frontend-plugin` | `plugins/<id>/` |
| Backend module | `backend-plugin-module` | `plugins/<target>-backend-module-<name>/` |

**NOTE:** These are the ACTUAL template names from `node_modules/@backstage/cli/templates/`. The simpler names (`plugin-common`, `plugin-node`, `plugin-web`) do NOT work — they produce "Template 'plugin-common' not found" errors.

### Pitfalls

1. **`execute_code` sandbox cannot write to project files.** The sandbox runs in `/var/folders/.../hermes_sandbox_*/`. `write_file` calls inside `execute_code` write to the sandbox, not the project. Use the agent's direct `write_file`, `terminal`, and `patch` tools instead.
2. **Shell heredocs break on TypeScript template literals.** The `scaffold.sh` script uses heredocs (`cat > file << 'EOF'`). TypeScript files containing `${}` template literals will be corrupted by bash variable expansion in unquoted heredocs. Even quoted heredocs (`<< 'EOF'`) have issues with mixed quoting. **Use `write_file` for all `.ts`/`.tsx` files.**
3. **`write_file` "sibling subagent" conflicts.** If `execute_code` wrote the same file earlier, `write_file` will warn about sibling subagent modifications. Read the file first (`read_file(limit=3)`) to reset the conflict detection before writing.
4. **Interactive CODEOWNERS prompt:** Pipe empty input: `echo "" | yarn backstage-cli new ...`
5. **Deprecated `id` parameter:** Use `--option pluginId=<name>` not `--option id=<name>`.
6. **Backend template generates TodoListService:** Delete `src/services/` after scaffolding.
7. **Frontend template generates example components:** Delete `src/components/ExampleComponent/` and `src/components/ExampleFetchComponent/` after scaffolding.
8. **Scaffolded `dev/index.*` files are templates, not your code.** Delete `plugins/<id>/dev/index.tsx` and `plugins/<id>-backend/dev/index.ts` after scaffolding. These are template entry points that won't compile for your plugin. Recreate when you're ready for local development.
9. **Backstage version API differences:** The new frontend plugin API (`createFrontendPlugin`, `createApiExtension`, `createPageExtension`, `createEntityContentExtension`) may not exist in older Backstage versions. In v1.51.0-next.3, only `createFrontendPlugin` and `createExtension` are available from `@backstage/frontend-plugin-api`. For entity content cards, use `convertLegacyEntityContentExtension` from `@backstage/plugin-catalog-react/alpha`. For pages, use `PageBlueprint` from `@backstage/frontend-plugin-api`. Fall back to the legacy system (`createPlugin` from `@backstage/core-plugin-api`) if the new APIs don't compile.
9. **Pre-existing TS errors are not your fault.** The Backstage repo has many pre-existing type errors (react-redux, zod, catalog-model JSON imports, `@internal/frontend` missing). Only fix errors in files you created. `--jsx not set` errors on `.tsx` files are a repo config issue — ignore.
10. **BUI Tabs use URL routing, not onChange.** The BUI `Tabs` + `Tab` components navigate via React Router URL hashes. They do NOT fire an `onChange` callback. To switch views on tab click, use a `hashchange` event listener or React Router hooks. Never use `useState` + `setView` expecting it to fire from tab clicks — it won't.
11. **Route refs belong in the frontend plugin, not -react.** `createRouteRef` should be defined in `plugins/<id>/src/routes.ts`, not in the `-react` package. The `-react` package can export types and ApiRefs, but route refs and components live in the frontend plugin.
12. **Always run `backstage-code-review` before showing the user.** The structural validation here catches file-level issues. The `backstage-code-review` skill catches functional bugs (tab switching, API wiring), convention violations (route placement, lazy loading), and BUI pattern issues that structural checks miss. Load it with `skill_view(name='backstage-code-review')` and run all 7 dimensions.
13. **`write_file` warnings cascade across a directory tree.** Once a single file in a package gets a "sibling subagent" warning, EVERY subsequent `write_file` in the same package triggers the same warning — even for new files you're creating for the first time. Read the file with `read_file(limit=3)` before writing to clear the warning. When writing multiple files in the same package, prefer a single Python heredoc batch write to avoid the cascade entirely. See `references/tool-patterns.md` for the full pattern.
14. **Custom template placeholders are documented in `references/template-placeholders.md`.** The clean-plugin template system uses `{{PLUGIN_ID}}`, `{{PLUGIN_ID.capitalize}}`, `{{PLUGIN_ID.camelcase}}`, and `{{PLUGIN_NAME}}`. Load this reference before writing or modifying any template file. The `.title()` pitfall (converting `test-e2e` to `TestE2E` instead of `TestE2e`) is documented there — it's the most common rendering bug.

## Post-Scaffold Validation (RUN THIS BEFORE SHOWING USER)

After scaffolding, verify against the catalog plugin as reference. All checks must pass:

### Structure
- [ ] **5 packages exist**: `-common`, `-node`, `-backend`, `-react`, `<id>`
- [ ] **Common**: `common.ts`, `permissions.ts`, `alpha.ts`, `index.ts`
- [ ] **Node**: `types.ts`, `extensions.ts`, `index.ts`
- [ ] **Backend**: `plugin.ts`, `service/router.ts`, `index.ts`
- [ ] **React**: `api.ts`, `types.ts`, `routes.ts`, `testUtils.ts`, `translation.ts`, `filters.ts`, `overridableComponents.ts`, `apis/index.ts`, `components/index.ts`, `hooks/index.ts`, `index.ts`
- [ ] **Frontend**: `plugin.ts` (with `createApiFactory`), `index.ts`, `apis/DefaultClient.ts`, `apis/index.ts`, `components/index.ts`, `alpha/index.ts`, a page component in `components/`

### Plugin.ts (frontend)
- [ ] `createApiFactory` wiring the `ApiRef` to a `DefaultClient` 
- [ ] Route refs imported from `./routes` (NOT from `-react`)
- [ ] Components lazy-imported from `./components/` (NOT from `-react`)
- [ ] ApiRef import from `-react` is OK (ApiRef + types SHOULD come from -react)

### Package.json (all 5 — MUST have these fields)
- [ ] `exports` map: `".": "./src/index.ts"`, `"./alpha": "./src/alpha/index.ts"`, `"./package.json": "./package.json"`
- [ ] `typesVersions` mirroring exports for TypeScript resolution
- [ ] `keywords: ["backstage"]`
- [ ] `homepage` + `repository` fields
- [ ] `sideEffects: false`
- [ ] `files: ["dist"]`
- [ ] `peerDependencies`: react + react-dom + react-router-dom (frontend + react only)
- [ ] `peerDependenciesMeta`: `@types/react: { optional: true }` (frontend + react only)
- [ ] React additionally: `exports["./testUtils"]` + matching `typesVersions`

### React package
- [ ] `testUtils.ts` with MockClient + test utilities
- [ ] `translation.ts` for i18n
- [ ] `exports` map includes `"./testUtils"` and `"./alpha"`

### Backend
- [ ] `schema/openapi.yaml` in `-common` for type sharing
- [ ] `schema/openapi.yaml` in `-backend` for `yarn generate` (generates from THIS location, not from common)
- [ ] `router.ts` imports generated router from `./schema/openapi/generated/router` OR delegates to a service layer with clear separation
- [ ] `"generate"` script points `--client-package` to `-common` (NOT `-react` — the generated client lives in common)
- [ ] Generated router file exists: `plugins/<id>-backend/src/schema/openapi/generated/router.ts`
- [ ] Generated client file exists: `plugins/<id>-common/src/schema/openapi/generated/Api.client.ts`

### Cleanup verification (template leftovers)
- [ ] No `ExampleComponent` or `ExampleFetchComponent` directories
- [ ] No `TodoListService` directory
- [ ] No `dev/index.*` files (delete `plugins/<id>/dev/index.tsx` and `plugins/<id>-backend/dev/index.ts`)
- [ ] Run: `find plugins/<id>* \( -path "*Example*" -o -path "*/dev/*" \)` — must return nothing

### Production readiness
- [ ] `config.d.ts` exists in the `-backend` package root
- [ ] Integration test exists: `plugins/<id>-backend/src/__tests__/integration.test.ts`
- [ ] Router unit test exists: `plugins/<id>-backend/src/__tests__/router.test.ts`
- [ ] At least one hook test exists in `plugins/<id>-react/src/hooks/__tests__/`
- [ ] At least one component test exists in `plugins/<id>/src/components/__tests__/`

### Run verification
```bash
# Structural check
find plugins/<id>* -maxdepth 1 -name "package.json" | wc -l  # must be 5
grep -l "exports" plugins/<id>*/package.json | wc -l           # must be 5

# Key file check
[ -f plugins/<id>/src/components ] && echo "Frontend has NO components — FIX"
[ -f plugins/<id>-react/src/testUtils.ts ] || echo "React missing testUtils — FIX"
[ -f plugins/<id>/src/api/DefaultClient.ts ] || echo "Frontend missing DefaultClient — FIX"
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `yarn: command not found` | Use `node .yarn/releases/yarn-4.8.1.cjs` instead |
| Interactive CODEOWNERS prompt | Pipe empty string: `echo "" \| yarn new ...` |
| `yarn install` fails | Ignore — it's often pre-existing repo issues. Package is scaffolded. |
| Template not found | Use exact IDs from the reference table above |
| `pluginId` deprecated warning | Use `--option pluginId=<id>` not `--option id=<id>` |
| Shell heredoc corrupts TS files | Don't use shell heredocs for `.ts`/`.tsx`. Use `write_file` instead. |
| `write_file` blocked by sibling subagent | Read the file first with `read_file(limit=3)` to clear the conflict. |
| New frontend plugin API doesn't compile | Fall back to legacy `createPlugin` from `@backstage/core-plugin-api`. |

## Available Templates

Each code template is also available as a standalone file for manual use or reference. Load with `skill_view(name='backstage-feature-scaffolder', file_path='templates/<path>')`:

| Template | Target Package | Key Files |
|---|---|---|
| `templates/common-library/` | `-common` | `index.ts`, `types.ts` |
| `templates/node-library/` | `-node` | `index.ts`, `api.ts` |
| `templates/backend-plugin/` | `-backend` | `plugin.ts`, `router.ts`, `index.ts` |
| `templates/web-library/` | `-react` | `index.ts`, `hooks/useData.ts` |
| `templates/frontend-plugin/` | `<id>` | `plugin.ts`, `index.ts` |
| `templates/backend-module/` | `-backend-module-*` | `module.ts`, `index.ts` |

## Related Skills

After scaffolding, use these skills to fill in the details:

| Task | Skill |
|---|---|
| Build backend routes | `backstage-backend-api` |
| Create API clients | `backstage-client-api` |
| Add database tables | `backstage-core-services` (database) |
| Add permissions | `backstage-auth-permissions` |
| Build UI components | `backstage-ui-components` |
| Style components | `backstage-ui-styling` |
| Add tests | `backstage-testing` |
| Wire into app | `backstage-app-wiring` |
| Build entity page cards | `backstage-catalog-system` |
| Publish events | `backstage-messaging` |
| Scaffolder actions | `backstage-scaffolder-system` |
| End-to-end patterns | `backstage-integration-patterns` |
