---
name: backstage-testing
description: "Use when testing Backstage plugins, components, or backends. Covers frontend testing (renderInTestApp, mockApis), backend testing (startTestBackend, mockServices), E2E with Playwright, and plugin-specific test utilities."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, testing, jest, frontend-testing, backend-testing, e2e, playwright]
    related_skills: [backstage-plugin-blueprint, backstage-core-services, backstage-frontend-services, backstage-backend-api, backstage-client-api, backstage-feature-scaffolder, backstage-code-review, test-driven-development]
---

# Backstage Testing

## Overview

Comprehensive testing utilities: `@backstage/frontend-test-utils` (frontend), `@backstage/backend-test-utils` (backend), Playwright (E2E).

## Frontend Testing

### renderInTestApp

```tsx
import { renderInTestApp, mockApis } from '@backstage/frontend-test-utils';
import { screen } from '@testing-library/react';

await renderInTestApp(<MyComponent />, {
  apis: [
    mockApis.config({ data: { app: { title: 'Test App' } } }),
    mockApis.identity({ userEntityRef: 'user:default/guest' }),
    mockApis.permission({ authorize: async () => ({ result: AuthorizeResult.ALLOW }) }),
    mockApis.storage({ data: { 'key': 'value' } }),
  ],
});
expect(screen.getByText('Test App')).toBeInTheDocument();
```

### Available mockApis

| Mock | Key Methods |
|---|---|
| `mockApis.config({ data })` | `getString()`, `getOptionalBoolean()` |
| `mockApis.identity(opts)` | `{ userEntityRef, ownershipEntityRefs, token, profile }` |
| `mockApis.discovery({ baseUrl })` | `getBaseUrl()` → `${baseUrl}/api/${pluginId}` |
| `mockApis.fetch(opts)` | Wraps fetch with identity injection |
| `mockApis.analytics()` | `getEvents()` |
| `mockApis.featureFlags(opts)` | `isActive()`, `getState()`, `setState()` |
| `mockApis.error(opts)` | `getErrors()`, `waitForError()` |
| `mockApis.alert()` | `getAlerts()`, `waitForAlert()` |
| `mockApis.permission(opts)` | `authorize()` → ALLOW by default |
| `mockApis.storage({ data })` | In-memory bucket storage |
| `mockApis.translation()` | Passthrough returning defaults |

Each has `.mock()` returning jest mocks for assertions.

### renderTestApp (for extensions)

```tsx
renderTestApp({ extensions: [myExtension], apis: [mockApis.permission()] });
```

### TestApiProvider (standalone)

```tsx
render(<TestApiProvider apis={[mockApis.identity(...)]}><MyComponent /></TestApiProvider>);
```

### Custom API tuples

```tsx
apis: [mockApis.config(...), [myCustomApiRef, { doWork: jest.fn() }]]
```

### Plugin-specific mocks

```tsx
import { catalogApiMock } from '@backstage/plugin-catalog-react/testUtils';
apis: [catalogApiMock({ entities: [myEntity] })]
```

### Creating Custom Mock APIs

```ts
import { attachMockApiFactory, createApiMock } from '@backstage/frontend-test-utils';
import { myApiRef, type MyApi } from '@internal/plugin-example-react';

// Fake with real behavior
export function myApiMock(options?: { greeting?: string }) {
  return attachMockApiFactory(myApiRef, { greet: async () => options?.greeting ?? 'Hello!' });
}
// Jest variant (all methods are jest.fn())
export namespace myApiMock {
  export const mock = createApiMock(myApiRef, () => ({ greet: jest.fn() }));
}
// Usage: myApiMock({ greeting: 'Hi!' }) or const m = myApiMock.mock({ greet: async () => 'test' }); expect(m.greet).toHaveBeenCalled();
```

### Testing Extensions

```tsx
import { createExtensionTester } from '@backstage/frontend-test-utils';
const tester = createExtensionTester(myExtension, { config: { path: '/test' } });
expect(tester.reactElement()).toContain('Expected');
expect(tester.data(coreExtensionData.routePath)).toBe('/test');
```

### Database Test Lifecycle

```ts
import { TestDatabases } from '@backstage/backend-test-utils';
let knex: Knex;
beforeAll(async () => { knex = await TestDatabases.create().init('SQLITE_3'); await knex.migrate.latest({ directory: migrationsDir }); });
afterAll(async () => { await knex.destroy(); });
beforeEach(async () => { await knex('my_table').truncate(); });
```

### E2E Testing

```ts
import { test, expect } from '@playwright/test';
test('entity page loads', async ({ page }) => {
  await page.goto('/catalog/default/component/example');
  await expect(page.locator('h1')).toContainText('example');
});
```
Run: `yarn test:e2e`

### Testing Service-to-Service Calls

```ts
const { server } = await startTestBackend({
  features: [import('@internal/plugin-catalog-backend'), mockServices.discovery.factory()],
});
const response = await request(server).get('/api/catalog/entities');
```

### Testing Extensions

```tsx
const tester = createExtensionTester(myExtension);
expect(tester.reactElement()).toContain('Expected');
```

## Backend Testing

### startTestBackend (integration)

```ts
const { server } = await startTestBackend({ features: [import('@internal/plugin-my-plugin-backend')] });
const resp = await request(server).get('/api/my-plugin/hello');
expect(resp.status).toBe(200);
```

### mockServices (unit)

```ts
const config = mockServices.rootConfig({ data: { myPlugin: { enabled: true } } });
const logger = mockServices.logger.mock();
const database = mockServices.database.mock();
const scheduler = mockServices.scheduler();     // auto-runs non-manual tasks
const auth = mockServices.auth.mock();
const httpAuth = mockServices.httpAuth.mock();
const permissions = mockServices.permissions.mock();
// ... all 19 core services available
```

### mockCredentials

```ts
mockCredentials.user('user:default/alice');
mockCredentials.service('plugin:my-plugin');
mockCredentials.none();
```

### Test Database

```ts
const databases = TestDatabases.create();
const knex = await databases.init('SQLITE_3');
await knex.migrate.latest({ directory: migrationsDir });
// test...
await knex.destroy();
```

## E2E (Playwright)

```ts
test('catalog loads', async ({ page }) => {
  await page.goto('/catalog');
  await expect(page.locator('h1')).toContainText('Catalog');
});
```

Run: `yarn test:e2e`

## TanStack Query Testing

### Test Setup (Required Wrapper)

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TestApiProvider } from '@backstage/frontend-test-utils';

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <TestApiProvider apis={[[myPluginApiRef, mockApi]]}>
      <QueryClientProvider client={createTestQueryClient()}>
        {children}
      </QueryClientProvider>
    </TestApiProvider>
  );
}
```

### Testing useQuery Components

```tsx
test('renders items after loading', async () => {
  mockApi.getItems.mockResolvedValue({
    items: [{ id: '1', name: 'Test Item', status: 'active', createdAt: '' }],
  });

  render(<MyPage />, { wrapper: TestWrapper });

  // Initially loading
  expect(screen.getByTestId('progress')).toBeInTheDocument();
  // Wait for data
  expect(await screen.findByText('Test Item')).toBeInTheDocument();
  // Verify API called
  expect(mockApi.getItems).toHaveBeenCalledTimes(1);
});
```

### Testing useMutation Components

```tsx
test('creates item and refetches', async () => {
  const mockApi = {
    getItems: jest.fn().mockResolvedValue({ items: [] }),
    createItem: jest.fn().mockResolvedValue({ id: '2', name: 'New' }),
  };

  render(<MyPage />, { wrapper: createWrapper(mockApi) });
  await userEvent.click(screen.getByText('Create'));
  // Mutation fired
  expect(mockApi.createItem).toHaveBeenCalledWith({ name: 'New' });
  // After success, query invalidated — getItems called again
  await waitFor(() => expect(mockApi.getItems).toHaveBeenCalledTimes(2));
});
```

### Testing useInfiniteQuery

```tsx
test('loads more pages', async () => {
  mockApi.queryEntities
    .mockResolvedValueOnce({ items: [{ id: '1' }], pageInfo: { nextCursor: 'abc' } })
    .mockResolvedValueOnce({ items: [{ id: '2' }], pageInfo: {} });

  render(<EntityList />, { wrapper: TestWrapper });
  expect(await screen.findByText('1')).toBeInTheDocument();
  await userEvent.click(screen.getByText('Load More'));
  expect(await screen.findByText('2')).toBeInTheDocument();
});
```

---

## Extension Tester (Deep Dive)

```tsx
import { createExtensionTester } from '@backstage/frontend-test-utils';
import { coreExtensionData } from '@backstage/frontend-plugin-api';

const tester = createExtensionTester(myExtension, {
  config: { path: '/custom-path' },
  apis: [mockApis.permission({ authorize: async () => ({ result: AuthorizeResult.ALLOW }) })],
});

// Assert rendered output
expect(tester.reactElement()).toContain('Expected Text');

// Assert extension data output
expect(tester.data(coreExtensionData.routePath)).toBe('/custom-path');

// Assert multiple data refs
const [element, title] = tester.data(coreExtensionData.reactElement, MyCardBlueprint.dataRefs.title);
expect(title).toBe('My Card');

// Test with mocked extension inputs
const testerWithInputs = createExtensionTester(myPageExtension, {
  config: { path: '/page' },
  inputs: {
    cards: [[MyCardBlueprint.dataRefs.title, 'Injected Card']],
  },
});
```

---

## Backend Service-to-Service Testing

```ts
import { startTestBackend } from '@backstage/backend-test-utils';

test('plugin A calls plugin B', async () => {
  // Start both plugins in same test backend
  const { server } = await startTestBackend({
    features: [
      import('@internal/plugin-catalog-backend'),
      import('@internal/plugin-my-plugin-backend'),
    ],
  });

  // Catalog is now a real service
  const response = await request(server)
    .get('/api/my-plugin/catalog-entities');

  expect(response.status).toBe(200);
  expect(response.body.items).toBeDefined();
});
```

### Testing with Custom Service Factories

```ts
const { server } = await startTestBackend({
  features: [
    import('@internal/plugin-my-plugin-backend'),
    // Override a service factory for this test
    createServiceFactory({
      service: coreServices.discovery,
      deps: {},
      factory: async () => ({
        getBaseUrl: async (pluginId: string) =>
          `http://localhost:${server.address().port}/api/${pluginId}`,
      }),
    }),
  ],
});
```

---

## E2E Testing with Auth

```ts
import { test, expect } from '@playwright/test';

test.describe('catalog entity page', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate via guest provider
    await page.goto('/api/auth/guest/refresh');
    await page.waitForURL('**/catalog');
  });

  test('renders entity details', async ({ page }) => {
    await page.goto('/catalog/default/component/example-website');
    await expect(page.locator('h2').first()).toContainText('example-website');
  });

  test('shows techdocs tab', async ({ page }) => {
    await page.goto('/catalog/default/component/example-website/docs');
    await expect(page.locator('.techdocs-reader')).toBeVisible();
  });
});
```

---

## Mocking Knex Queries

When a processor, router, or store accepts `Knex` via constructor injection and unit tests can't use `TestDatabases` (no real DB available, or testing pure logic), use a **dual-Proxy mock** — see `references/knex-proxy-mock.md` for the full pattern and examples.

## Conventions

- Prefer fewer tests with multiple assertions
- `screen` + `.findBy*` over `waitFor`
- No test IDs — query by text/role/label
- MSW for network mocking (ADR007)
- `CI=1 yarn test <path>` for all tests

## Common Pitfalls

1. Not mocking required APIs — `useApi()` crashes without mock
2. Using `waitFor` instead of `findBy*`
3. Adding test IDs to implementation
4. Backend tests hitting real discovery
5. Not destroying database (`knex.destroy()`)
6. Shared state between tests — use `beforeEach`

## Verification Checklist

- [ ] Frontend: `renderInTestApp` or `renderTestApp` with all required `mockApis`
- [ ] Backend: `startTestBackend` (integration) or `mockServices` (unit)
- [ ] DB tests cleanup with `knex.destroy()`
- [ ] No test IDs in implementation
- [ ] `findBy*` queries preferred
