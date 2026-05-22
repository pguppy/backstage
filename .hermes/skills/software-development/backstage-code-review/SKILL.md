---
name: backstage-code-review
description: "Use when reviewing ANY Backstage plugin code — self-review before showing user, PR review, or quality gate. Systematic checklist covering 7 dimensions: functional behavior, API conventions, BUI patterns, TanStack Query, package.json, permissions, and structural validation. Designed to catch bugs that structural-only checks miss."
version: 1.1.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, review, checklist, code-quality, conventions, self-review]
    related_skills: [backstage-feature-scaffolder, backstage-ui-components, backstage-client-api, backstage-backend-api, backstage-testing, backstage-auth-permissions]
---

# Backstage Code Review — 7-Dimension Checklist

## When To Use

Run this checklist on ANY Backstage plugin code before showing it to a user, submitting a PR, or declaring work "done." It catches the bugs that structural-only checks miss.

**Trigger conditions:**
- After scaffolding a new feature (run D-1 first, then D0-D8 after writing code)
- After writing any Backstage plugin code (self-review)
- Before merging a PR (code review)
- When a user reports a bug in Backstage code (diagnostic checklist)

**How to use:** Run each dimension top-to-bottom. Mark failures with the severity tag. Fix 🔴 items before showing the user.

---

## Dimension -1: Pre-Write Checklist (Before Writing ANY Code) 🔴

Run this immediately after scaffolding and BEFORE writing implementation code. Fix failures before proceeding.

- [ ] **Scaffold was used, not `yarn new`.** Zero `dev/index.*` or `Example*` files should exist. ExamplePage.tsx from scaffold.py is now a comment-only placeholder — it should NOT be deleted, just left in place.

- [ ] **configSchema is present.** The `-backend/package.json` must have `"configSchema": "config.d.ts"` and `config.d.ts` must exist at the package root. This is checked at scaffold time now — scaffold.py produces this.

- [ ] **OperationId-hook mapping plan exists.** Before writing code, list every `operationId` in the OpenAPI spec. For each one, plan a corresponding TanStack Query hook in `-react/src/hooks/`. Example:
  ```
  operationId: getEnterpriseSummary  →  useCopilotSummary()
  operationId: getEnterpriseDaily    →  useCopilotDaily()
  operationId: getEnterpriseUsers    →  useCopilotUsers()
  operationId: getEnterpriseTeams    →  useCopilotTeams()
  operationId: getDataFreshness      →  useCopilotFreshness()  ← DON'T FORGET THIS ONE
  ```
  If this list has fewer hooks than operationIds, you've already made the most common mistake. Count them: `grep -c operationId plugins/<id>-common/src/schema/openapi.yaml` should equal `ls plugins/<id>-react/src/hooks/*.ts | grep -v index | wc -l`.

- [ ] **Test plan exists.** For every hook, plan a `.test.ts` file. For every page component, plan a `.test.tsx` file. For the router, plan an integration test. Write the test file alongside the source file, not at the end. Tests written after the fact are always incomplete.

- [ ] **Generated stubs exist on disk.** `-backend/src/schema/openapi/generated/router.ts` and `-common/src/schema/openapi/generated/Api.client.ts` must exist. If not, create stubs. These files are checked at scaffold time now.

- [ ] **Zero forbidden patterns.** Run these greps — they must return nothing:
  ```bash
  # No process.env anywhere (use config.getString)
  grep -rn "process.env" plugins/<id>-*/src/ | grep -v "NEVER use\|//.*process.env"
  # No express.Router() anywhere (use createOpenApiRouter)
  grep -rn "= Router()" plugins/<id>-backend/src/ | grep -v generated
  # No manual try/catch with res.status in route handlers (framework handles errors)
  grep -rn "catch.*res\.status" plugins/<id>-backend/src/router.ts
  ```
  If either returns a match, fix before writing any code. These are zero-tolerance Backstage framework violations.

---

---

## Dimension 0: Pre-flight (Run First) 🟢

Before reviewing code, verify the foundation is solid.

- [ ] **`scaffold.py` was used, not `yarn new`.** Check for `dev/index.*` or `Example*` directories — these indicate `yarn new` was used and cleanup may be needed. If found, re-scaffold with `scaffold.py`.

- [ ] **Generated files exist.** Verify `plugins/<id>-backend/src/schema/openapi/generated/router.ts` and `plugins/<id>-react/src/schema/openapi/generated/Api.client.ts` exist on disk. If missing, the import chain will fail.

- [ ] **No template cruft.** Run `find plugins/<id>* \( -path "*Example*" -o -path "*TodoList*" -o -path "*/dev/*" \)` — must return nothing. Exception: the scaffold's `ExamplePage.tsx` is now a comment-only placeholder — it's OK to leave it.

- [ ] **Cross-package imports are structured correctly.** The import chain must follow the dependency direction: `frontend-plugin` → `-react` → `-common`. No reverse imports. Verify:
  - `-react` never imports from the frontend plugin (`plugins/<id>/`)
  - `-common` never imports from `-react` or the frontend plugin
  - Generated client types flow from `-common/schema/openapi/generated` to both `-react` and the frontend plugin

---

## Dimension 1: Functional Behavior 🔴

These are bugs — the code doesn't work as intended.

- [ ] **Tab/view switching actually works.** If using BUI `Tabs` with `href`, verify that clicking a tab changes what's displayed. BUI Tabs route via URL hash — they do NOT fire an `onChange` callback. Wire `hashchange` events or use `Button` toggles instead.

- [ ] **State changes are connected to UI.** Every `useState` setter must have a corresponding UI element that calls it. Search for `const [x, setX] = useState(` and verify `setX` is called somewhere.

- [ ] **API client methods match router endpoints.** Every method on the client interface must have a corresponding route handler. Check: (1) path matches, (2) HTTP method matches, (3) query/body params match.

- [ ] **ApiRef is provided.** Every `createApiRef` must have a corresponding `createApiFactory` or `ApiBlueprint.make`. Without this, `useApi()` throws at runtime. The provider must be in the same app's extension list.

- [ ] **Backend routes are actually mounted.** The plugin's `httpRouter.use(router)` call must be in `registerInit`. Public routes need `httpRouter.addAuthPolicy()` BEFORE `httpRouter.use()`.

- [ ] **No silent empty responses.** Stub endpoints returning `[]` or `{}` should either have real implementations or be clearly marked with TODO comments. Empty data is indistinguishable from "no data available."

- [ ] **No file is a monolith.** Every source file must have a single responsibility. See Dimension 2 "No monolith files" for the full checklist (line limits, extraction rules). Quick check: `wc -l` on every source file — anything >250 lines fails. Use `grep -c 'export function\|^function '` — files with 3+ function definitions fail.

- [ ] **Generated OpenAPI files exist on disk.** Verify both:
  - `plugins/<id>-backend/src/schema/openapi/generated/router.ts` exists
  - `plugins/<id>-react/src/schema/openapi/generated/Api.client.ts` exists
  If missing, run `yarn generate` or create matching stubs. Never ship code with imports from `./schema/openapi/generated/` that don't resolve.

---

## Dimension 2: API & Client Conventions 🟡

Deviations from Backstage patterns. The code works but doesn't follow conventions.

- [ ] **Express Router is created via `createOpenApiRouter()`, NOT `express.Router()`.** The generated OpenAPI router provides built-in request validation, typed request/response objects, and automatic error responses. Using raw `Router()` from `express` bypasses all of this and forces you to manually validate every parameter and cast every type. The only valid pattern: `const router = await createOpenApiRouter();`. Never write `const router = Router();`.

- [ ] **OpenAPI spec exists in the backend package.** The `yarn generate` command runs from the `-backend` directory and reads `schema/openapi.yaml` locally. The file must exist at `plugins/<id>-backend/src/schema/openapi.yaml`. Having it in `-common` is insufficient — the generate tool doesn't look there. Both packages can have copies (common for type sharing, backend for generation).

- [ ] **Generated client lives in the common package, not react.** The `--client-package` flag in the `generate` script must point to `plugins/<id>-common`. The generated `DefaultApiClient` and types live there. The `-react` package imports them via `@backstage/plugin-<id>-common/schema/openapi/generated`. The catalog plugin demonstrates this: `--client-package packages/catalog-client`, and `catalog-react` imports from `@backstage/catalog-client`.

- [ ] **Route refs are defined locally, not re-exported.** Both the frontend plugin (`plugins/<id>/src/routes.ts`) and the `-react` package must define their own `rootRouteRef` using `createRouteRef`. Neither should re-export from the other. The catalog plugin is the reference — both `plugins/catalog/src/routes.ts` and `plugins/catalog-react/src/routes.ts` call `createRouteRef({ id: 'catalog' })` independently.

- [ ] **Components are lazy-loaded.** The frontend plugin imports page components with `React.lazy()` or `createRoutableExtension`. Direct imports bloat the initial bundle.

- [ ] **ApiRef ID follows convention:** `plugin.<pluginId>.service`

- [ ] **Backend pluginId matches frontend pluginId.** The client calls `discoveryApi.getBaseUrl(pluginId)` — this must match the backend's `createBackendPlugin({ pluginId })`.

- [ ] **No `process.env` anywhere.** All configuration must come from Backstage's config service (`config.getString()`, `config.getOptionalString()`). Environment variables go in `app-config.yaml` via `${ENV_VAR}` substitution, then accessed through config. Direct `process.env` access bypasses the config schema, secret masking, and validation. This is a 🔴 violation — never use `process.env` in backend code.

- [ ] **No monolith files.** Every source file should have a single responsibility. Hard limits:
  - Router files: max 200 lines (route wiring only — business logic in `service/` or `lib/` directory)
  - Page components: max 200 lines (thin orchestration — child views in separate files)
  - Service classes: one class per file
  - Never define 3+ component functions in a single file
  - If a file exceeds these limits, extract logic into dedicated files in `service/`, `lib/`, `utils/`, or sibling component files.

---

## Dimension 3: BUI Component Patterns 🟡

- [ ] **Tabs use URL-based routing.** BUI `Tabs` + `Tab` use `href` and `matchStrategy`. They navigate via React Router, not via `onChange`. To detect tab changes, use `useEffect` + `hashchange` listener or React Router hooks.

- [ ] **Table cells use Cell/CellText/CellProfile wrappers.** Bare text inside Table cells is not supported. Use `<Cell>`, `<CellText title={...} />`, or `<CellProfile>`.

- [ ] **`isPending` not `loading`.** BUI components use `isPending` for loading states. The `loading` prop is deprecated.

- [ ] **Spacing uses BUI system, not MUI `sx`.** BUI components accept `p`, `m`, `gap`, `px`, `py` props. MUI's `sx` prop doesn't work on BUI components.

- [ ] **`FullPage` layout is correct.** Must have `<FullPage.Header>` + `<FullPage.Content>`. Header contains `<Header>` with `title`, `tabs`, and `customActions`.

- [ ] **`bg` prop is semantic, not hardcoded.** Use `bg="neutral"` for layered backgrounds, not explicit `--bui-bg-neutral-2`.

- [ ] **Icons use Remix icon names.** `iconStart="refresh"`, `iconStart="brain"` etc. — Remix Icon names as strings. Not JSX elements.

---

## Dimension 4: TanStack Query 🟡

- [ ] **Query keys are arrays with pluginId prefix.** `['pluginId', 'resource', params...]`. Never raw strings.

- [ ] **Query keys are serializable.** No functions, symbols, or circular references in keys. Sort object key order for consistency.

- [ ] **`staleTime` is set.** Every `useQuery` should have an explicit `staleTime` appropriate for its data freshness. Default is 0 (always stale).

- [ ] **`enabled` is used for dependent queries.** Queries that depend on route params or prior query results should use `enabled: !!param` to prevent premature fetching.

- [ ] **`useMutation` invalidates queries on success.** After a mutation, invalidate related queries with `queryClient.invalidateQueries()` to trigger refetch.

- [ ] **Test wrappers include `QueryClientProvider`.** TanStack Query tests need a `QueryClientProvider` with `retry: false` and `gcTime: 0`.

---

## Dimension 5: Package.json Completeness 🟢

Structural — easy to verify, hard to get wrong.

- [ ] `exports` map present for every package: `"."`, `"./alpha"`, `"./package.json"`
- [ ] `typesVersions` mirrors `exports` exactly
- [ ] `pluginId` set (all packages share the same ID)
- [ ] `pluginPackages` array lists all 5 package names
- [ ] `sideEffects: false`
- [ ] `files: ["dist"]`
- [ ] `keywords: ["backstage"]`
- [ ] `peerDependencies` has react + react-dom + react-router-dom (frontend + react only)
- [ ] `peerDependenciesMeta: { "@types/react": { "optional": true } }` (frontend + react only)
- [ ] React package additionally has `exports["./testUtils"]` + matching `typesVersions`
- [ ] Backend package has `"generate"` script pointing `--client-package` to `-react`

---

## Dimension 6: Permissions & Auth 🟡

- [ ] **Permissions are defined in -common.** Every backend resource operation should have a corresponding permission in `permissions.ts`.

- [ ] **Permission checks happen in route handlers.** Backend routes that access protected resources must call `permissions.authorize()` and check `decision.result === 'ALLOW'`.

- [ ] **Public routes have auth policy exceptions.** Any route that should be accessible without auth needs `httpRouter.addAuthPolicy({ path, allow: 'unauthenticated' })` BEFORE `httpRouter.use()`.

- [ ] **Health/freshness endpoints are unauthenticated.** Status, health check, and data-freshness endpoints should be public.

---

## Dimension 8: Consistency 🔴

Catches "works but inconsistent" patterns — the hardest bugs to spot.

- [ ] **One hook per API method — VERIFY BY COUNT.** Count operationIds in the spec and hooks in the `-react` package. They must be equal. Run:
  ```bash
  echo "Spec methods: $(grep -c operationId plugins/<id>-common/src/schema/openapi.yaml)"
  echo "Hooks: $(ls plugins/<id>-react/src/hooks/*.ts 2>/dev/null | grep -v index | wc -l)"
  ```
  If these numbers differ, you missed a hook. Every `operationId` must have a corresponding `useXxx()` hook. No direct `useApi()` + manual fetch in components — that's what this check prevents.

- [ ] **Tests exist for all key files.** Every hook (in `-react/src/hooks/`) should have a corresponding `.test.ts` file. The router should have a unit test. The main page component should have a component test. Backend should have an integration test using `startTestBackend`. A plugin with zero test files is not production-ready. For test patterns, load `backstage-backend-testing` with `skill_view(name='backstage-backend-testing')`.

- [ ] **Plugin imported statically, never via dynamic `import()`.** Tests must use `import { xxxPlugin } from '../plugin'` — never `import("@internal/plugin-xxx-backend")`. Dynamic imports fail silently with cryptic errors in `startTestBackend`. Grep: `grep -rn "import(@" plugins/<id>-backend/src/__tests__/` — must return nothing.

- [ ] **Integration tests use `mockServices.rootConfig.factory`** for config, not `process.env`. Every `startTestBackend` call should include mock config with `integrations`, `app.baseUrl`, and any plugin-specific config needed for the test.

- [ ] **All views are separate files.** If DashboardPage renders 3+ views with conditional logic, each view must be in its own file. No inline function components in the page file. Exception: tiny helpers (under 5 lines, like `hashView` or `formatPercent`) are OK inline. The page component itself counts as one function — if `grep "^function\|^export function"` returns more than 2 results, extract.

- [ ] **Config schema exists.** Every backend plugin must have a `config.d.ts` file at the package root, using `export interface Config` with `@visibility` annotations. Without this, the plugin's config is not discoverable by the Backstage config system.

- [ ] **Generated files are consistent with the spec.** The generated router's paths must match the OpenAPI spec's paths. The generated client's methods must match the spec's operationIds. If the spec has `operationId: getFoo`, the client must have `getFoo()`.

- [ ] **Placeholder/stub code is clearly marked.** Any endpoint, view, or method that returns empty data must have a `// TODO:` comment explaining what's needed. Silent empty responses are indistinguishable from real "no data" results.

- [ ] **Scaffold leftovers are removed.** After using `scaffold.py`, the `ExamplePage.tsx` references the scaffold's health-check hook. If you replace the hooks with your own, either update ExamplePage to use your hooks or delete it. Never leave a file that imports non-existent symbols.

Quick structural checks. Run these every time.

```bash
# Must return 5
find plugins/<id>* -maxdepth 1 -name "package.json" | wc -l

# Must return 5
grep -l '"exports"' plugins/<id>*/package.json | wc -l

# Key files must exist
[ -f plugins/<id>-common/src/common.ts ] && echo "common.ts OK" || echo "MISSING common.ts"
[ -f plugins/<id>-react/src/testUtils.ts ] && echo "testUtils.ts OK" || echo "MISSING testUtils.ts"
[ -f plugins/<id>-react/src/translation.ts ] && echo "translation.ts OK" || echo "MISSING translation.ts"
[ -f plugins/<id>/src/apis/DefaultClient.ts ] && echo "DefaultClient OK" || echo "MISSING DefaultClient"
[ -f plugins/<id>-common/src/schema/openapi.yaml ] && echo "openapi.yaml OK" || echo "MISSING openapi.yaml"
[ -f plugins/<id>/src/alpha/index.ts ] && echo "alpha/index.ts OK" || echo "MISSING alpha/index.ts"

# Template leftovers must NOT exist
find plugins/<id>* -path "*Example*" && echo "Example* FOUND — CLEAN ME" || echo "No Example* leftovers OK"
find plugins/<id>* -path "*/dev/index.*" && echo "dev/index.* FOUND — CLEAN ME" || echo "No dev/index leftovers OK"
```

---

## Dimension 9: Code Smells 🔴

Systematic elimination of the most common code smells in Backstage plugins.

- [ ] **No DRY violations in route handlers.** If the same pattern appears in 3+ route handlers, extract it. Common violations:
  - `(req.query.enterprise as string) || configDefault` repeated → `resolveEnterprise()` helper
  - `from`/`to` extraction repeated → `resolveDateRange()` helper
  - Inline data transformation → `toXxxMetrics()` function in the aggregator

- [ ] **No magic numbers.** Numbers like `86400000`, `3`, `365` must be named constants (`DAY_MS`, `DATA_LAG_DAYS`, `HISTORY_DAYS`). Zero exceptions.

- [ ] **No hardcoded API paths.** URL strings like `/enterprises/${ent}/copilot/metrics/...` must be in a constants object (`API.summary(ent)`, `API.dailyUsers(ent, day)`). Makes endpoints discoverable and testable.

- [ ] **No `as any` casts.** Raw records should be transformed through typed functions in the aggregator, not cast inline in the router. The aggregator functions handle the `Record<string, unknown>` → typed conversion.

- [ ] **No dead imports.** Run `grep -rn "import.*from" plugins/<id>-backend/src/router.ts` — verify every import is used. Remove unused ones.

- [ ] **No one-letter variable names.** `svc` → `service`. `cfg` → `config`. Abbreviations save 3 characters and cost readability.

- [ ] **No mutable shared state in route handlers.** `let lastSync = null` followed by `lastSync = new Date()` inside a handler is a race condition. Use a proper store or accept that freshness is approximate.

- [ ] **No silent empty catch blocks.** If a `catch {}` swallows errors without logging, it masks failures. At minimum log a debug message explaining why the error is expected.

1. **Dimension -1 first** — before writing ANY code. Plan hooks, tests, verify foundation. Fix all issues before proceeding.
2. **Dimension 0 second** — after scaffolding, verify no cruft, generated files exist, import chain correct.
3. **Dimension 1 third** — catch bugs. Fix all 🔴 items.
4. **Dimension 2 fourth** — catch convention violations.
5. **Dimensions 3-6** — code quality.
6. **Dimension 7** — structural check.
7. **Dimension 8 last** — consistency. Count hooks vs operationIds. This catches the most common mistake (missing hook for one API method).

## Common Failure Patterns & Root Causes

| Symptom | Most Likely Root Cause | Dimension |
|---|---|---|
| Tab click does nothing | BUI Tabs use URL routing, not onChange. Missing hashchange listener. | 1 |
| `useApi()` throws at runtime | ApiRef has no provider in the extension list | 1 |
| Endpoint returns 404 | pluginId mismatch between client and backend | 2 |
| Route imports from -react | Route refs should be defined locally in BOTH packages, not re-exported | 2 |
| Huge initial bundle | Components imported eagerly instead of lazy-loaded | 2 |
| Table renders blank cells | Bare text — needs Cell/CellText wrapper | 3 |
| Query refetching too often | Missing staleTime | 4 |
| Query not firing | Missing `enabled` or deps array issue | 4 |
| Stub data shown as real | Empty arrays indistinguishable from "no data" | 1 |
| Import from `./schema/openapi/generated/` fails | `yarn generate` was never run. Generated files don't exist. | 2 |
| Router is 400+ lines | Business logic and aggregation inline instead of in service layer | 2 |
| Dashboard page has 3+ component functions | Child views not extracted to separate files | 2 |
| Scaffold template code in output | `dev/index.*` or `Example*` files not cleaned after scaffold | 7 |
| `ExamplePage.tsx` imports non-existent hook | Scaffold's health hook was replaced but ExamplePage not updated | 8 |
| Direct `useApi()` in component instead of hook | Missing hook — "one hook per API method" rule violated | 8 |
| View functions inline in page component | Monolith — child views not extracted to separate files | 8 |
| `process.env.GITHUB_TOKEN` used directly | Must use `config.getString()` — env vars go through app-config | 2 |
| `const router = Router()` instead of `createOpenApiRouter()` | Generated router provides validation; raw Express bypasses it | 2 |
