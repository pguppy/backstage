---
name: backstage-client-api
description: "Use when building a frontend API client to call a Backstage backend plugin. Covers the complete pattern: defining the API interface, generating an OpenAPI-driven typed fetch client, creating the ApiRef, providing the implementation via ApiBlueprint, consuming it with useApi(), and authentication via discoveryApi + fetchApi. Based on deep source-code analysis of the catalog-client, catalog-react, and catalog frontend plugin."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, frontend, client, api, openapi, discovery, fetch, apiref, useapi, apiblueprint]
    related_skills: [backstage-backend-api, backstage-plugin-blueprint, backstage-frontend-services, backstage-catalog-system, backstage-cli]
---

# Backstage Frontend API Client Development

## The Complete Data Flow

```
Component                   Plugin                    Client Package          Backend
─────────                   ──────                    ──────────────          ───────
useApi(catalogApiRef)   →   ApiBlueprint.make({...})  →  CatalogClient    →  /api/catalog/entities
  ↓                             ↓ fetchApiRef +           ↑ discoveryApi
  catalogApi.getEntities()      discoveryApiRef           ↑ fetchApi.fetch()
```

Every Backstage API client follows this pattern. The catalog plugin is the reference.

## The 4-Layer Architecture

### Layer 1: API Interface (`-common` or client package)

```ts
// packages/catalog-client/src/types/api.ts
export interface CatalogApi {
  getEntities(request?: GetEntitiesRequest, options?: CatalogRequestOptions):
    Promise<GetEntitiesResponse>;
  getEntityByRef(entityRef: string | CompoundEntityRef, options?: CatalogRequestOptions):
    Promise<Entity | undefined>;
  refreshEntity(entityRef: string, options?: CatalogRequestOptions): Promise<void>;
  // ... 15+ more methods
}

export interface GetEntitiesRequest {
  filter?: EntityFilterQuery;
  fields?: string[];
  order?: EntityOrderQuery;
  offset?: number;
  limit?: number;
  after?: string;
}

export interface GetEntitiesResponse {
  items: Entity[];
}

export interface CatalogRequestOptions {
  token?: string;
}
```

**Rule:** The interface should match your backend routes 1:1. Every backend endpoint = one method on the interface.

### Layer 2: Generated Fetch Client (OpenAPI-driven, optional but recommended)

Source: `packages/catalog-client/src/schema/openapi/generated/apis/Api.client.ts`

The generated client handles:
- Discovery: `const baseUrl = await this.discoveryApi.getBaseUrl(pluginId);`
- URL construction: URI template expansion for path/query params
- Auth headers: `Authorization: Bearer ${options?.token}`
- HTTP method + body serialization

```ts
export class DefaultApiClient {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: {
    discoveryApi: { getBaseUrl(pluginId: string): Promise<string> };
    fetchApi?: { fetch: typeof fetch };
  }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi || { fetch: crossFetch };
  }

  public async getEntities(request: GetEntities, options?: RequestOptions):
    Promise<TypedResponse<Array<Entity>>> {
    const baseUrl = await this.discoveryApi.getBaseUrl(pluginId);
    const uri = parse(uriTemplate).expand({ ...request.query });
    return await this.fetchApi.fetch(`${baseUrl}${uri}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(options?.token && { Authorization: `Bearer ${options?.token}` }),
      },
      method: 'GET',
    });
  }
}
```

The `pluginId` is hardcoded: `export const pluginId = 'catalog';` — this maps to the backend plugin.

To generate this from an OpenAPI spec:

```bash
yarn backstage-cli package schema openapi generate --client
```

This requires `schema/openapi.yaml` in your package (the SAME spec used to generate the backend server).

### Layer 2 Alternative: Manual Fetch Client (simple plugins)

For simple plugins without OpenAPI spec generation, write a manual client:

```ts
export class MyPluginClient {
  constructor(private readonly options: {
    discoveryApi: { getBaseUrl(pluginId: string): Promise<string> };
    fetchApi: { fetch: typeof fetch };
  }) {}

  async getItems(options?: { token?: string }): Promise<Item[]> {
    const baseUrl = await this.options.discoveryApi.getBaseUrl('my-plugin');
    const response = await this.options.fetchApi.fetch(
      `${baseUrl}/items`,
      {
        headers: {
          ...(options?.token && { Authorization: `Bearer ${options?.token}` }),
        },
      },
    );
    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }
    return response.json();
  }

  async createItem(item: CreateItemBody, options?: { token?: string }): Promise<Item> {
    const baseUrl = await this.options.discoveryApi.getBaseUrl('my-plugin');
    const response = await this.options.fetchApi.fetch(
      `${baseUrl}/items`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options?.token && { Authorization: `Bearer ${options?.token}` }),
        },
        body: JSON.stringify(item),
      },
    );
    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }
    return response.json();
  }
}
```

### Layer 3: ApiRef + ApiBlueprint (Frontend wiring)

The `ApiRef` is created in your `-react` package:

```ts
// plugins/my-plugin-react/src/api.ts
import { createApiRef } from '@backstage/core-plugin-api';
import type { MyPluginApi } from '@backstage/plugin-my-plugin-common'; // or your client package

export const myPluginApiRef = createApiRef<MyPluginApi>({
  id: 'plugin.my-plugin.service',
});
```

**ApiRef ID convention:** `plugin.<pluginId>.service`

The implementation is provided via `ApiBlueprint` in your frontend plugin:

```ts
// plugins/my-plugin/src/alpha/apis.ts
import { discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import { ApiBlueprint } from '@backstage/frontend-plugin-api';
import { myPluginApiRef } from '@backstage/plugin-my-plugin-react';
import { MyPluginClient } from '@backstage/plugin-my-plugin-client';

export const myPluginApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: myPluginApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new MyPluginClient({ discoveryApi, fetchApi }),
    }),
});

export default [myPluginApi];
```

Then wire into your plugin:

```ts
// plugins/my-plugin/src/alpha/plugin.tsx
import apis from './apis';

export default createFrontendPlugin({
  pluginId: 'my-plugin',
  extensions: [...apis, ...pages, ...navItems],
});
```

### Layer 4: Consumption in Components (TanStack Query)

```tsx
import { useQuery } from '@tanstack/react-query';
import { useApi } from '@backstage/core-plugin-api';
import { myPluginApiRef } from '@backstage/plugin-my-plugin-react';

export function MyPage() {
  const api = useApi(myPluginApiRef);

  const { data, isLoading, error } = useQuery({
    queryKey: ['my-plugin', 'items'],
    queryFn: () => api.getItems(),
    staleTime: 30_000,
  });

  if (isLoading) return <Progress />;
  if (error) return <Error error={error} />;
  return <ItemList items={data?.items ?? []} />;
}
```

TanStack Query is the primary state management solution. See the "State Management: TanStack Query" section below for all patterns including mutations, infinite queries, dependent queries, and testing.

---

## How Auth Works (Automatic)

Backstage uses **service-to-service** auth for frontend-to-backend calls. The `FetchApi` configured in the Backstage app automatically injects auth headers. You do NOT handle tokens manually in client code — the framework's `fetchApiRef` adds the `Authorization` header.

The generated client has an optional `token` parameter in `RequestOptions` for edge cases (e.g., custom auth flows), but standard usage omits it.

---

## Package Structure (Recommended)

For a plugin `my-plugin`:

```
packages/
  my-plugin-common/         ← common-library: types, API interface, permissions
  my-plugin-client/         ← web-library: generated/manual fetch client + ApiRef
                             OR put ApiRef in my-plugin-react
plugins/
  my-plugin-react/          ← web-library: ApiRef, React hooks, shared components
  my-plugin/                ← frontend-plugin: ApiBlueprint providing client
  my-plugin-backend/        ← backend-plugin: Express routes
```

Simpler approach (fewer packages):

```
plugins/
  my-plugin-common/         ← isomorphic types + ApiRef
  my-plugin/                ← frontend-plugin + manual client inline
  my-plugin-backend/        ← backend-plugin
```

---

## OpenAPI Generation

### Setup

1. Create `schema/openapi.yaml` in your client package (same spec as backend)
2. The `pluginId` in the generated client must match your backend plugin's `pluginId`
3. Run both commands:

```bash
# In the client package directory:
yarn backstage-cli package schema openapi generate --client

# In the backend package directory:
yarn backstage-cli package schema openapi generate --server
```

### What You Get

**Server (backend):** `createOpenApiRouter()` — Express router with `express-openapi-validator` middleware that auto-validates every request against the spec.

**Client (frontend):** `DefaultApiClient` — Typed fetch class that:
- Calls `discoveryApi.getBaseUrl(pluginId)` for every request
- Expands URI templates with path/query parameters
- Adds `Authorization: Bearer` headers when token provided
- Returns `TypedResponse<T>` with typed `.json()`

---

## The Full Example: From Zero to Working Client

### Step 1: Define Your Interface

```ts
// plugins/my-plugin-common/src/api.ts
export interface MyPluginApi {
  getItems(options?: RequestOptions): Promise<{ items: Item[] }>;
  getItem(id: string, options?: RequestOptions): Promise<Item | undefined>;
  createItem(body: CreateItemBody, options?: RequestOptions): Promise<Item>;
}

export interface RequestOptions {
  token?: string;
}

export interface Item {
  id: string;
  name: string;
}

export interface CreateItemBody {
  name: string;
}
```

### Step 2: Create the Client

```ts
// plugins/my-plugin-client/src/MyPluginClient.ts
import { ResponseError } from '@backstage/errors';
import { MyPluginApi, Item, CreateItemBody, RequestOptions } from '@backstage/plugin-my-plugin-common';

export class MyPluginClient implements MyPluginApi {
  constructor(private readonly options: {
    discoveryApi: { getBaseUrl(pluginId: string): Promise<string> };
    fetchApi: { fetch: typeof fetch };
  }) {}

  async getItems(options?: RequestOptions): Promise<{ items: Item[] }> {
    const baseUrl = await this.options.discoveryApi.getBaseUrl('my-plugin');
    const res = await this.options.fetchApi.fetch(`${baseUrl}/items`, {
      headers: options?.token ? { Authorization: `Bearer ${options?.token}` } : {},
    });
    if (!res.ok) throw await ResponseError.fromResponse(res);
    return { items: await res.json() };
  }

  async getItem(id: string, options?: RequestOptions): Promise<Item | undefined> {
    const baseUrl = await this.options.discoveryApi.getBaseUrl('my-plugin');
    const res = await this.options.fetchApi.fetch(`${baseUrl}/items/${encodeURIComponent(id)}`, {
      headers: options?.token ? { Authorization: `Bearer ${options?.token}` } : {},
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw await ResponseError.fromResponse(res);
    return res.json();
  }

  async createItem(body: CreateItemBody, options?: RequestOptions): Promise<Item> {
    const baseUrl = await this.options.discoveryApi.getBaseUrl('my-plugin');
    const res = await this.options.fetchApi.fetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options?.token && { Authorization: `Bearer ${options?.token}` }),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await ResponseError.fromResponse(res);
    return res.json();
  }
}
```

### Step 3: Create the ApiRef

```ts
// plugins/my-plugin-react/src/api.ts
import { createApiRef } from '@backstage/core-plugin-api';
import type { MyPluginApi } from '@backstage/plugin-my-plugin-common';

export const myPluginApiRef = createApiRef<MyPluginApi>({
  id: 'plugin.my-plugin.service',
});
```

### Step 4: Provide via ApiBlueprint

```ts
// plugins/my-plugin/src/alpha/apis.ts
import { discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import { ApiBlueprint } from '@backstage/frontend-plugin-api';
import { myPluginApiRef } from '@backstage/plugin-my-plugin-react';
import { MyPluginClient } from '@backstage/plugin-my-plugin-client';

export default ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: myPluginApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new MyPluginClient({ discoveryApi, fetchApi }),
    }),
});
```

### Step 5: Wire into Plugin

```ts
// plugins/my-plugin/src/alpha/plugin.tsx
import { createFrontendPlugin } from '@backstage/frontend-plugin-api';
import apis from './apis';

export default createFrontendPlugin({
  pluginId: 'my-plugin',
  extensions: [apis, ...pages],
});
```

### Step 6: Consume in Components

```tsx
import { useApi } from '@backstage/core-plugin-api';
import { myPluginApiRef } from '@backstage/plugin-my-plugin-react';

export function MyPage() {
  const api = useApi(myPluginApiRef);
  const { value: items, loading, error } = useAsync(() => api.getItems(), [api]);

  if (loading) return <Progress />;
  if (error) return <Error error={error} />;
  return <ItemList items={items?.items ?? []} />;
}
```

---

## The Catalog Plugin Reference (All 4 Layers in One View)

| Layer | File | Pattern |
|---|---|---|
| **Interface** | `packages/catalog-client/src/types/api.ts` | `CatalogApi` interface with typed request/response |
| **Client** | `packages/catalog-client/src/CatalogClient.ts` | Wraps generated `DefaultApiClient` |
| **Generated** | `packages/catalog-client/src/schema/openapi/generated/apis/Api.client.ts` | `discoveryApi.getBaseUrl('catalog')` + `fetchApi.fetch()` |
| **ApiRef** | `plugins/catalog-react/src/api.ts` | `createApiRef<CatalogApi>({ id: 'plugin.catalog.service' })` |
| **Provider** | `plugins/catalog/src/alpha/apis.tsx` | `ApiBlueprint.make({ api: catalogApiRef, deps: {discoveryApiRef, fetchApiRef}, factory: ... })` |
| **Consumer** | `plugins/catalog/src/components/CatalogEntityPage/useEntityFromUrl.ts` | `useApi(catalogApiRef)` → `catalogApi.getEntityByRef(...)` |

## State Management: TanStack Query (Primary)

TanStack Query (`@tanstack/react-query`) is the primary state management and data-fetching solution for all Backstage frontend plugins. It replaces `react-use`'s `useAsync`/`useAsyncRetry` and manual `useEffect`+`useState` patterns.

### Setup

```bash
yarn workspace <plugin-package> add @tanstack/react-query
```

Wrap the app root with `QueryClientProvider` in `packages/app/src/App.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,       // 5 min — data considered fresh
      gcTime: 30 * 60 * 1000,          // 30 min — garbage collection
      retry: 1,                        // Retry once on failure
      refetchOnWindowFocus: false,     // Don't refetch on tab focus
    },
  },
});

const app = createApp({
  elements: [
    <QueryClientProvider client={queryClient}>
      {/* existing providers */}
    </QueryClientProvider>,
  ],
});
```

### Pattern 1: useQuery (GET — replacing useAsync)

Before (react-use):
```tsx
import { useAsync } from 'react-use';
import { catalogApiRef } from '@backstage/plugin-catalog-react';

function MyPage() {
  const catalogApi = useApi(catalogApiRef);
  const { value, loading, error } = useAsync(
    () => catalogApi.getEntities({ filter: { kind: 'Component' } }),
    [catalogApi]
  );
  if (loading) return <Progress />;
  if (error) return <Error error={error} />;
  return <EntityList items={value?.items ?? []} />;
}
```

After (TanStack Query):
```tsx
import { useQuery } from '@tanstack/react-query';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { useApi } from '@backstage/core-plugin-api';

function MyPage() {
  const catalogApi = useApi(catalogApiRef);

  const { data, isLoading, error } = useQuery({
    queryKey: ['catalog', 'entities', { kind: 'Component' }],
    queryFn: () => catalogApi.getEntities({ filter: { kind: 'Component' } }),
    staleTime: 30_000,  // 30s — override global default for this query
  });

  if (isLoading) return <Progress />;
  if (error) return <Error error={error} />;
  return <EntityList items={data?.items ?? []} />;
}
```

**Query key conventions:**
- `['pluginName', 'resource', params]` — e.g. `['catalog', 'entities', { kind, namespace }]`
- `['pluginName', 'resource', id]` — e.g. `['catalog', 'entity', 'component:default/my-svc']`
- Keys must be serializable (no functions, no symbols)
- Parameter order matters — `{ kind, namespace }` ≠ `{ namespace, kind }` (sort object keys)

### Pattern 2: useMutation (POST/PUT/DELETE — replacing manual fetch + setState)

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@backstage/core-plugin-api';

function CreateItemPage() {
  const myApi = useApi(myPluginApiRef);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (body: CreateItemBody) => myApi.createItem(body),
    onSuccess: (newItem) => {
      // Invalidate queries that list this resource to trigger refetch
      queryClient.invalidateQueries({ queryKey: ['my-plugin', 'items'] });
      // Or optimistically add to cache:
      // queryClient.setQueryData(['my-plugin', 'items'], (old) => ({
      //   ...old,
      //   items: [...(old?.items ?? []), newItem],
      // }));
    },
    onError: (error) => {
      // Error is automatically available in mutation.error
      console.error('Failed to create item', error);
    },
  });

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      mutation.mutate({ name: e.target.name.value });
    }}>
      <input name="name" />
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Creating...' : 'Create'}
      </button>
      {mutation.isError && <Error error={mutation.error} />}
    </form>
  );
}
```

### Pattern 3: Entity Detail Page (replacing useAsyncRetry)

Before:
```tsx
import { useAsyncRetry } from 'react-use';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { useRouteRefParams } from '@backstage/core-plugin-api';

function EntityPage() {
  const catalogApi = useApi(catalogApiRef);
  const { kind, namespace, name } = useRouteRefParams(entityRouteRef);

  const { value: entity, loading, error, retry } = useAsyncRetry(
    () => catalogApi.getEntityByRef({ kind, namespace, name }),
    [catalogApi, kind, namespace, name],
  );
  // ...
}
```

After:
```tsx
import { useQuery } from '@tanstack/react-query';
import { catalogApiRef } from '@backstage/plugin-catalog-react';

function EntityPage() {
  const catalogApi = useApi(catalogApiRef);
  const { kind, namespace, name } = useRouteRefParams(entityRouteRef);

  const {
    data: entity,
    isLoading,
    error,
    refetch,        // replaces "retry"
  } = useQuery({
    queryKey: ['catalog', 'entity', { kind, namespace, name }],
    queryFn: () => catalogApi.getEntityByRef({ kind, namespace, name }),
    enabled: !!name,  // Don't fetch until route params are resolved
    staleTime: 60_000,
  });

  if (isLoading) return <Progress />;
  if (error) return <Error error={error} />;
  if (!entity) return <NotFound />;
  return <EntityDetail entity={entity} onRefresh={refetch} />;
}
```

### Pattern 4: Dependent Queries (fetch A, then B based on A's result)

```tsx
function ParentChildPage() {
  const catalogApi = useApi(catalogApiRef);

  const { data: parent } = useQuery({
    queryKey: ['catalog', 'entity', { kind: 'System', namespace: 'default', name: 'payments' }],
    queryFn: () => catalogApi.getEntityByRef('system:default/payments'),
  });

  const { data: children } = useQuery({
    queryKey: ['catalog', 'entities', { kind: parent?.spec?.type }],
    queryFn: () => catalogApi.getEntities({
      filter: { kind: parent!.spec!.type },
    }),
    enabled: !!parent?.spec?.type,  // Only runs when parent resolves
  });
  // ...
}
```

### Pattern 5: Parallel Queries

```tsx
function Dashboard() {
  const catalogApi = useApi(catalogApiRef);

  const { data: components } = useQuery({
    queryKey: ['catalog', 'entities', { kind: 'Component' }],
    queryFn: () => catalogApi.getEntities({ filter: { kind: 'Component' } }),
  });
  const { data: apis } = useQuery({
    queryKey: ['catalog', 'entities', { kind: 'API' }],
    queryFn: () => catalogApi.getEntities({ filter: { kind: 'API' } }),
  });
  const { data: systems } = useQuery({
    queryKey: ['catalog', 'entities', { kind: 'System' }],
    queryFn: () => catalogApi.getEntities({ filter: { kind: 'System' } }),
  });

  const isLoading = [components, apis, systems].some(q => q === undefined);
  // All three fetch in parallel
}
```

### Pattern 6: Infinite List / Cursor Pagination

```tsx
import { useInfiniteQuery } from '@tanstack/react-query';

function EntityList() {
  const catalogApi = useApi(catalogApiRef);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['catalog', 'entities', 'infinite', { kind: 'Component' }],
    queryFn: ({ pageParam }) =>
      catalogApi.queryEntities({
        filter: { kind: 'Component' },
        limit: 20,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.pageInfo.nextCursor,
  });

  const allEntities = data?.pages.flatMap(p => p.items) ?? [];

  return (
    <div>
      {allEntities.map(e => <EntityCard key={e.metadata.uid} entity={e} />)}
      {hasNextPage && (
        <Button onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
          Load More
        </Button>
      )}
    </div>
  );
}
```

### Global Defaults (Recommended)

```ts
// packages/app/src/queryClient.ts
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,        // 5 minutes
      gcTime: 30 * 60 * 1000,           // 30 minutes
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      refetchOnMount: 'always',         // Refetch on mount if data is stale
    },
    mutations: {
      retry: 0,                         // Don't retry mutations by default
      onError: (error) => {
        console.error('Mutation error:', error);
      },
    },
  },
});
```

### Testing with TanStack Query

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },  // No retries, no caching in tests
      mutations: { retry: false },
    },
  });
}

function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <TestApiProvider apis={[[catalogApiRef, mockCatalogApi]]}>
      <QueryClientProvider client={createTestQueryClient()}>
        {children}
      </QueryClientProvider>
    </TestApiProvider>
  );
}

test('renders entities', async () => {
  mockCatalogApi.getEntities.mockResolvedValue({
    items: [{ kind: 'Component', metadata: { name: 'test' } }],
  });

  render(<MyPage />, { wrapper: TestWrapper });
  expect(await screen.findByText('test')).toBeInTheDocument();
});
```

### Migration Checklist (react-use → TanStack Query)

| react-use pattern | TanStack Query replacement |
|---|---|
| `useAsync(fn, deps)` | `useQuery({ queryKey, queryFn })` |
| `useAsyncRetry(fn, deps)` | `useQuery({ queryKey, queryFn })` + `refetch()` |
| `{ value, loading, error }` | `{ data, isLoading, error }` |
| `retry()` | `refetch()` |
| `useEffect` + `api.method().then(setState)` | `useMutation({ mutationFn })` |
| Manual `useState` for loading state | `mutation.isPending` |
| Manual cache invalidation | `queryClient.invalidateQueries()` |
| `useEffect` + `setState` for derived data | `select` option or dependent queries |

1. **Forgetting to provide the API** — If no `ApiBlueprint` provides your `ApiRef`, `useApi()` will throw at runtime. Every `ApiRef` must have exactly one provider.

2. **Wrong `pluginId` in client** — The generated client calls `discoveryApi.getBaseUrl(pluginId)`. This must match your backend plugin's `pluginId`.

3. **Not using `ResponseError.fromResponse()`** — Always translate non-ok responses. The Backstage error handler on the backend returns standardized `ErrorResponseBody` format.

4. **Handling tokens manually** — The framework's `FetchApi` auto-injects auth. Don't manage tokens yourself unless absolutely necessary.

5. **Mixing old and new frontend systems** — Old system uses `createPlugin({ apis: [createApiFactory(...)] })`. New system uses `ApiBlueprint.make()`. Pick one, not both.

6. **ApiRef defined in wrong package** — Define it in `-react` (for shared consumption) or a client package, never in the main frontend plugin package. Otherwise other plugins can't consume it without importing the entire plugin.

7. **Not using `encodeURIComponent` for path params** — When constructing URLs manually, always encode IDs and names.

8. **Missing `Content-Type` for POST/PUT** — `express.json()` needs the header. The generated client includes it automatically.

9. **DiscoveryApi type sensitivity** — The generated client uses a minimal `DiscoveryApi` type (just `getBaseUrl`), not importing from `core-plugin-api`. This avoids circular dependencies. When writing manual clients, accept `{ getBaseUrl(pluginId: string): Promise<string> }` as the discovery type.

10. **Testing without mock** — Always mock the ApiRef in tests:
    ```ts
    import { myPluginApiRef } from '@backstage/plugin-my-plugin-react';
    const mockApi = createApiMock(myPluginApiRef);
    // or in new system:
    mockApi.mock({ getItems: async () => ({ items: [] }) });
    ```

## Verification Checklist

- [ ] API interface defined with typed request/response types
- [ ] Client class implements the interface, takes `discoveryApi` + `fetchApi`
- [ ] Client `pluginId` matches backend plugin's `pluginId`
- [ ] ApiRef created with unique ID: `plugin.<id>.service`
- [ ] `ApiBlueprint` provides the implementation using `discoveryApiRef` + `fetchApiRef`
- [ ] ApiBlueprint included in `createFrontendPlugin({ extensions: [apis, ...] })`
- [ ] Components consume via `useApi(myPluginApiRef)`
- [ ] Client handles non-ok responses with `ResponseError.fromResponse()`
- [ ] Path parameters use `encodeURIComponent`
- [ ] Tests mock the ApiRef, not the HTTP layer
