---
name: backstage-frontend-services
description: "Use when building Backstage frontend plugins and need to understand all utility APIs, extension blueprints, data refs, and frontend capabilities. Covers 22+ core APIs, 20+ blueprints, i18n, analytics, feature flags, swappable components, and testing. Includes when to use each and practical recipes."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, frontend, utility-apis, blueprints, i18n, analytics, feature-flags, testing]
related_skills: [backstage-plugin-blueprint, backstage-core-services, test-driven-development, backstage-ui-components, backstage-ui-styling, backstage-catalog-system, backstage-auth-permissions, backstage-testing, backstage-backend-api, backstage-client-api]
---

# Backstage Frontend Services & Capabilities

## Overview

The Backstage frontend system provides 22+ **Utility APIs** (dependency-injected, plugin-scoped services), 20+ **Extension Blueprints** (pre-built extension templates), 5 **Core Extension Data Refs** (typed output/input slots), and built-in support for **internationalization, analytics, feature flags, and swappable components**. All are imported from `@backstage/frontend-plugin-api` (or `@backstage/plugin-app-react` for app-level blueprints).

**Core principle:** Utility APIs are the frontend equivalent of backend core services — they are dependency-injected, scoped to the providing plugin, and replaceable via overrides.

## Utility APIs — Complete Reference

### Communication APIs (discovery, fetch)

**`discoveryApiRef`** — Resolve backend plugin base URLs:
```ts
const url = await discoveryApi.getBaseUrl('catalog');
// → 'https://backstage.example.com/api/catalog'
```

**`fetchApiRef`** — Auth-injected `fetch` wrapper. Automatically attaches identity tokens:
```ts
const data = await fetchApi.fetch(`${baseUrl}/entities`);
```
⚠️ Requires signed-in user. Use native `fetch` for sign-in pages or unauthenticated contexts.

### Identity & Auth APIs (identityApiRef + 11 OAuth provider refs)

**`identityApiRef`** — User identity, profile, credentials, sign-out:
```ts
const profile = await identityApi.getProfileInfo();          // { displayName, email, picture }
const identity = await identityApi.getBackstageIdentity();   // { userEntityRef, ownershipEntityRefs }
const { token } = await identityApi.getCredentials();        // { token?: string }
await identityApi.signOut();
```

**OAuth provider refs** (11 total): `googleAuthApiRef`, `githubAuthApiRef`, `oktaAuthApiRef`, `gitlabAuthApiRef`, `microsoftAuthApiRef`, `oneloginAuthApiRef`, `bitbucketAuthApiRef`, `bitbucketServerAuthApiRef`, `atlassianAuthApiRef`, `vmwareCloudAuthApiRef`, `openshiftAuthApiRef`. Each provides `getAccessToken(scopes?)` for OAuth2 flows.

**`oauthRequestApiRef`** — Trigger OAuth consent flows programmatically.

### Configuration API (configApiRef)

**`configApiRef`** — Read `app-config.yaml` values:
```ts
const title = configApi.getString('app.title');
const optional = configApi.getOptionalBoolean('myPlugin.feature');
```
Same `Config` interface as backend `rootConfig`. Only `@visibility frontend` fields are accessible.

### UI Interaction APIs

**`toastApiRef`** — Show toast notifications (replaces deprecated `alertApiRef`):
```ts
toastApi.show({ message: 'Operation successful!', severity: 'success' });
toastApi.show({ message: 'Failed!', severity: 'error' });
```

**`errorApiRef`** — Error posting and handling:
```ts
errorApi.post(new Error('Something went wrong'));
// Also returned by errorApi.error$() as Observable for global error listening
```

**`dialogApiRef`** — Programmatic dialog management:
```ts
dialogApi.show({ title: 'Confirm', content: 'Are you sure?', onConfirm: () => {} });
```

### Theme & Appearance APIs

**`appThemeApiRef`** — Theme switching (light/dark/auto + custom themes):
```ts
const themes = appThemeApi.getInstalledThemes();
const currentId = appThemeApi.getActiveThemeId();
appThemeApi.setActiveThemeId('dark');
appThemeApi.activeThemeId$().subscribe(id => { /* theme changed */ });
```

**`iconsApiRef`** — Icon lookup by key:
```ts
const iconElement = iconsApi.icon('dashboard');
const keys = iconsApi.listIconKeys();
```

### Storage & State APIs

**`storageApiRef`** — Browser localStorage with bucket support:
```ts
const bucket = storageApi.forBucket('my-plugin');
await bucket.set('key', value);
const value = await bucket.get('key');
await bucket.remove('key');
```

**`featureFlagsApiRef`** — Feature flag toggling:
```ts
featureFlagsApi.registerFlag({ name: 'my-feature', pluginId: 'my-plugin' });
if (featureFlagsApi.isActive('my-feature')) { /* show beta UI */ }
featureFlagsApi.save({ states: { 'my-feature': FeatureFlagState.Active } });
```
Flags are persisted in browser localStorage per user.

### Analytics API

**`analyticsApiRef`** — Event capture (prefer `useAnalytics()` hook):
```ts
const analytics = useAnalytics();
analytics.captureEvent('deploy', serviceName, {
  value: 42,
  attributes: { org: 'engineering' },
});
```

**`AnalyticsContext`** — Provide contextual metadata for all child events:
```tsx
<AnalyticsContext attributes={{ segment: 'onboarding' }}>
  <MyComponent />
</AnalyticsContext>
```

Auto-captured context: `pluginId`, `extension`, `routeRef`. Built-in events: `navigate`, `click`, `create`, `search`, `discover`, `not-found`.

### Internationalization (i18n)

**`translationApiRef`** — Low-level translation access. Prefer `useTranslationRef()` hook:
```ts
const { t } = useTranslationRef(myPluginTranslationRef);
return <h1>{t('dashboardPage.title')}</h1>;
```

**`appLanguageApiRef`** — Language switching:
```ts
const { language } = appLanguageApi.getLanguage();
appLanguageApi.setLanguage('zh');
appLanguageApi.language$().subscribe(({ language }) => { /* language changed */ });
```

**Defining translations:**
```ts
export const myPluginTranslationRef = createTranslationRef({
  id: 'plugin.my-plugin',
  messages: {
    dashboardPage: {
      title: 'All your components',
      subtitle: 'Create new component',
    },
  },
});
```

Supports plurals (`_one`, `_other`), JSX interpolation, formatting (`number`, `currency`, `datetime`). CLI export/import for external translation workflows.

### Component APIs

**`swappableComponentsApiRef`** — Replace built-in components (Progress, ErrorDisplay, NotFoundErrorPage):
```ts
const Progress = swappableComponentsApi.getComponent(progressRef);
```

**`pluginHeaderActionsApiRef`** — Access plugin-scoped header action buttons:
```ts
const actions = pluginHeaderActionsApi.getPluginHeaderActions('catalog');
```

### Introspection APIs

**`appTreeApiRef`** — Access the extension tree at runtime. Advanced use only.

**`routeResolutionApiRef`** — Resolve route refs to URLs. Advanced use only.

## Extension Blueprints — Complete Reference

### From `@backstage/frontend-plugin-api`

| Blueprint | Kind | Purpose |
|---|---|---|
| `ApiBlueprint` | `api` | Provide or override any Utility API |
| `PageBlueprint` | `page` | Register a page at a route |
| `SubPageBlueprint` | `sub-page` | Tabbed content within a parent page |
| `PluginHeaderActionBlueprint` | `plugin-header-action` | Header action buttons scoped to plugin |
| `AnalyticsImplementationBlueprint` | `analytics-implementation` | Custom analytics backend |
| `PluginWrapperBlueprint` (alpha) | `plugin-wrapper` | Wrap all plugin elements (providers, etc.) |
| `NavItemBlueprint` | `nav-item` | **Deprecated** — auto-discovered from pages |

### From `@backstage/plugin-app-react`

| Blueprint | Kind | Purpose |
|---|---|---|
| `SignInPageBlueprint` | `sign-in-page` | Custom sign-in page |
| `SwappableComponentBlueprint` | `component` | Replace built-in components |
| `ThemeBlueprint` | `theme` | Register custom themes |
| `IconBundleBlueprint` | `icon-bundle` | Register icon sets |
| `TranslationBlueprint` | `translation` | Override or add translations |
| `NavContentBlueprint` | `nav-content` | Replace entire navbar |
| `RouterBlueprint` | `router` | Replace router component |

### From plugin packages

| Blueprint | Package | Purpose |
|---|---|---|
| `EntityCardBlueprint` | `@backstage/plugin-catalog-react/alpha` | Cards on entity overview |
| `EntityContentBlueprint` | `@backstage/plugin-catalog-react/alpha` | Tabs on entity pages |
| `EntityContentLayoutBlueprint` | `@backstage/plugin-catalog-react/alpha` | Layout for entity overview |
| `EntityHeaderBlueprint` | `@backstage/plugin-catalog-react/alpha` | Entity page header |
| `EntityContextMenuItemBlueprint` | `@backstage/plugin-catalog-react/alpha` | Context menu items |
| `EntityIconLinkBlueprint` | `@backstage/plugin-catalog-react/alpha` | Icon links on entity pages |
| `CatalogFilterBlueprint` | `@backstage/plugin-catalog-react/alpha` | Catalog table filters |
| `SearchResultListItemBlueprint` | `@backstage/plugin-search-react/alpha` | Search result rendering |

### Blueprint Usage Patterns

**`.make()`** — Simple, no inputs:
```ts
const page = PageBlueprint.make({ params: { path: '/my-page', loader: () => import('./Page') } });
```

**`.makeWithOverrides()`** — Accepts inputs from other plugins:
```ts
const page = PageBlueprint.makeWithOverrides({
  inputs: { cards: createExtensionInput([coreExtensionData.reactElement]) },
  factory(originalFactory, { inputs }) { return originalFactory({ /* use inputs */ }); },
});
```

**Defining custom blueprints** (for other plugins to use):
```tsx
export const MyWidgetBlueprint = createExtensionBlueprint({
  kind: 'my-widget',
  attachTo: { id: 'api:my-plugin/widgets', input: 'widgets' },
  output: [myWidgetDataRef],
  dataRefs: { widget: myWidgetDataRef },
  *factory(params) { yield myWidgetDataRef(params); },
});
```

## Core Extension Data Refs

Typed slots for extension input/output:

| Ref | ID | Type | Used By |
|---|---|---|---|
| `coreExtensionData.reactElement` | `core.reactElement` | `JSX.Element` | Most blueprints |
| `coreExtensionData.title` | `core.title` | `string` | Pages, nav items |
| `coreExtensionData.icon` | `core.icon` | `IconElement` | Pages, nav items |
| `coreExtensionData.routePath` | `core.routing.path` | `string` | Pages, sub-pages |
| `coreExtensionData.routeRef` | `core.routing.ref` | `RouteRef` | Pages |

Create custom data refs: `createExtensionDataRef<MyType>().with({ id: 'my-plugin.data' })`

## How to Use — Patterns & Recipes

### Pattern: Providing a Utility API

```tsx
// In -react package: define contract
export interface MyApi { doWork(): Promise<void>; }
export const myApiRef = createApiRef<MyApi>({ id: 'plugin.my-plugin.work' });

// In main plugin: provide implementation
const myApiExtension = ApiBlueprint.make({
  params: define => define({
    api: myApiRef,
    deps: { configApi: configApiRef, fetchApi: fetchApiRef },
    factory: ({ configApi, fetchApi }) => new MyApiImpl(configApi, fetchApi),
  }),
});

export default createFrontendPlugin({
  pluginId: 'my-plugin',
  extensions: [myApiExtension, /* pages, nav items... */],
});
```

### Pattern: Consuming a Utility API

```tsx
// In any component:
const myApi = useApi(myApiRef);           // throws if not registered
const myApi = useApiHolder().get(myApiRef); // returns undefined if optional

// In another API's factory:
const otherApi = ApiBlueprint.make({
  params: define => define({
    api: otherApiRef,
    deps: { myApi: myApiRef },  // dependency injection
    factory: ({ myApi }) => new OtherImpl(myApi),
  }),
});
```

### Pattern: Reading config
```ts
const api = useApi(configApiRef);
const title = api.getString('app.title');
```

### Pattern: Feature-flagging an extension
```tsx
const betaPage = PageBlueprint.make({
  params: { path: '/beta', loader: () => import('./BetaPage') },
  if: { featureFlags: { $contains: 'enable-beta' } },
});
```

### Pattern: Analytics instrumentation
```tsx
const analytics = useAnalytics();
analytics.captureEvent('merge', prName, { value: age, attributes: { org, repo } });
```

### Pattern: Internationalization
```tsx
const { t } = useTranslationRef(myPluginTranslationRef);
return <PageHeader title={t('dashboardPage.title')}>{t('dashboardPage.subtitle')}</PageHeader>;
```

### Pattern: Swappable component
```tsx
// Define (in -react):
export const MySwappable = createSwappableComponent({
  name: 'example',
  loader: () => (props) => <div>{props.name}</div>,
});

// Use: <MySwappable name="World" />

// Override (in app):
SwappableComponentBlueprint.make({
  name: 'core-progress',
  params: define => define({ component: Progress, loader: () => MyCustomProgress }),
});
```

### Pattern: Toast notification
```tsx
const toast = useApi(toastApiRef);
toast.show({ message: 'Saved!', severity: 'success' });
```

### Pattern: Feature flag state check
```tsx
const flags = useApi(featureFlagsApiRef);
if (flags.isActive('new-dashboard')) return <NewDashboard />;
```

### Pattern: Theme toggle
```tsx
const themeApi = useApi(appThemeApiRef);
themeApi.setActiveThemeId('dark');
```

## APIRef ID Naming Convention

API ref IDs follow `core.<name>` for built-in and `plugin.<pluginId>.<name>` for plugin-owned APIs. The frontend system infers the owning plugin from the ID — use the `plugin.<pluginId>.*` pattern to prevent other plugins from overwriting your API.

## Extension Config & Overrides

Configure via `app-config.yaml`:
```yaml
app:
  extensions:
    - api:plugin.example.work:
        config:
          goSlow: false
    - page:my-plugin:
        config:
          title: Custom Title
```

Replace implementations via `createFrontendModule` + `withOverrides`:
```tsx
const module = createFrontendModule({
  pluginId: 'app',
  extensions: [ApiBlueprint.make({ params: { factory: createApiFactory({ api: workApiRef, factory: () => new CustomImpl() }) } })],
});
```

## Testing with Mock APIs

Import from `@backstage/frontend-test-utils`:

```tsx
import { renderInTestApp, mockApis } from '@backstage/frontend-test-utils';

// Fake instances (functional mocks):
await renderInTestApp(<MyComponent />, {
  apis: [
    mockApis.config({ data: { app: { title: 'Test' } } }),
    mockApis.identity({ userEntityRef: 'user:default/guest' }),
    mockApis.permission({ authorize: async () => ({ result: AuthorizeResult.ALLOW }) }),
    mockApis.storage({ data: { 'my-key': 'my-value' } }),
  ],
});

// Jest mocks (for assertions):
const fetchApi = mockApis.fetch.mock();
expect(fetchApi.fetch).toHaveBeenCalledTimes(1);
```

**Available mocks:** `mockApis.config()`, `.discovery()`, `.fetch()`, `.identity()`, `.analytics()`, `.featureFlags()`, `.error()`, `.alert()`, `.permission()`, `.storage()`, `.translation()`. Each has a `.mock()` variant returning jest mocks.

## Common Pitfalls

1. **Using `fetchApi` on sign-in pages** — Default `fetchApi` requires signed-in user. Use native `fetch` for sign-in flows.
2. **Using deprecated `alertApiRef`** — Migrate to `toastApiRef`. AlertApi will be removed.
3. **Using deprecated `NavItemBlueprint`** — Pages now auto-populate the sidebar from their title + icon.
4. **Missing `info.packageJson` in plugin** — Required for published plugins. Without it, plugin metadata is unavailable.
5. **API ref ID without `plugin.` prefix** — Non-core APIs should use `plugin.<pluginId>.*` to enforce ownership.
6. **Config without `@visibility frontend`** — Default is `@visibility backend`. Frontend can only read `@visibility frontend` fields.
7. **Using `useApi()` for optional APIs** — Use `useApiHolder().get()` for APIs that may not be registered.
8. **Not providing `.optional()` on blueprint outputs** — All outputs are required by default. Mark optional outputs with `.optional()`.
9. **Translation keys not nested** — Flat keys at root level cause conflicts. Group semantically.
10. **Feature flags without `featureFlags` declaration in plugin** — Must declare in `createFrontendPlugin` before they're available in the UI.

## Verification Checklist

- [ ] Core APIs imported from `@backstage/frontend-plugin-api` (not `core-plugin-api` for new system)
- [ ] API ref IDs follow `plugin.<id>.<name>` pattern for plugin-owned APIs
- [ ] `info.packageJson` loader included in `createFrontendPlugin`
- [ ] Feature flags declared in plugin definition before use
- [ ] `@visibility frontend` on config fields consumed by frontend
- [ ] Deprecated `alertApiRef` replaced with `toastApiRef`
- [ ] Deprecated `NavItemBlueprint` removed (auto-discovered from pages)
- [ ] `makeWithOverrides` used when extension accepts external inputs
- [ ] Translation keys semantically nested, not flat
- [ ] Mock APIs used in tests via `mockApis` from `@backstage/frontend-test-utils`
