# OpenAPI-Driven API Pattern in Backstage

## Source: Catalog Plugin Analysis (May 2025, v1.51.0-next.3)

The Backstage catalog plugin uses an OpenAPI-first approach where the API is defined in a YAML spec, and both the typed backend router and typed frontend client are generated from it.

## Architecture

```
github-copilot-common/src/schema/openapi.yaml    ← THE SOURCE OF TRUTH
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
  github-copilot-backend/          github-copilot-react/
  schema/openapi/generated/       schema/openapi/generated/
  router.ts                        Api.client.ts
  (typed createOpenApiRouter)      (typed DefaultApiClient)
          │                               │
          ▼                               ▼
  plugin.ts: createBackendPlugin   api.ts: createApiRef + createApiFactory
  router.ts: createOpenApiRouter({ apiFactory wraps DefaultApiClient
    getMetrics: handler, ...       creates the ApiRef instance
  })
```

## The Generate Command

```json
// github-copilot-backend/package.json
{
  "scripts": {
    "generate": "backstage-repo-tools package schema openapi generate --server --client-package plugins/github-copilot-react"
  }
}
```

This generates:
- **Server**: `src/schema/openapi/generated/router.ts` — typed `createOpenApiRouter()` with endpoint map
- **Client**: `plugins/github-copilot-react/src/schema/openapi/generated/Api.client.ts` — typed `DefaultApiClient`

## OpenAPI Spec (minimal)

```yaml
openapi: 3.0.3
info:
  title: github-copilot
  version: "1"
paths:
  /metrics/{kind}/{namespace}/{name}:
    get:
      operationId: getEntityMetrics    # ← becomes function name
      parameters:
        - $ref: "#/components/parameters/kind"
        - $ref: "#/components/parameters/namespace"
        - $ref: "#/components/parameters/name"
      responses:
        "200":
          description: Success
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/GetMetricsResponse"
components:
  parameters:
    kind:
      name: kind
      in: path
      required: true
      schema:
        type: string
  schemas:
    GetMetricsResponse:
      type: object
      properties:
        success:
          type: boolean
        data:
          $ref: "#/components/schemas/CopilotMetrics"
```

## Backend Usage

### Generated Router (auto-generated, never edit)
```typescript
// src/schema/openapi/generated/router.ts
import { createValidatedOpenApiRouterFromGeneratedEndpointMap } from '@backstage/backend-openapi-utils';

export function createOpenApiRouter(endpoints: EndpointMap) {
  return createValidatedOpenApiRouterFromGeneratedEndpointMap({
    spec,
    endpoints,
  });
}
```

### Router Implementation
```typescript
// src/router.ts
import { createOpenApiRouter } from './schema/openapi/generated/router';

export async function createRouter(options: RouterOptions) {
  const router = await createOpenApiRouter({
    getEntityMetrics: async (req, res) => {
      // req.params is typed! { kind: string; namespace: string; name: string }
      const { kind, namespace, name } = req.params;
      const row = await options.db('copilot_metrics')
        .where('entity_ref', `${kind}:${namespace}/${name}`)
        .first();
      return res.json({ success: true, data: JSON.parse(row.metrics_json) });
    },
  });
  return router;
}
```

## Frontend Usage

### Generated Client (auto-generated, never edit)
```typescript
// src/schema/openapi/generated/Api.client.ts
export class DefaultApiClient {
  constructor(private readonly options: {
    baseUrl: string;
    fetchApi: { fetch: typeof fetch };
  }) {}

  async getEntityMetrics(kind: string, namespace: string, name: string) {
    // Typed fetch — no manual URL construction
    const url = `${this.options.baseUrl}/metrics/${kind}/${namespace}/${name}`;
    const resp = await this.options.fetchApi.fetch(url);
    return resp.json();
  }
}
```

### ApiRef + ApiFactory (in react package)
```typescript
// src/api.ts
import { createApiRef } from '@backstage/core-plugin-api';
import { DefaultApiClient } from './schema/openapi/generated/Api.client';

export interface GitHubCopilotApi {
  getEntityMetrics(kind: string, namespace: string, name: string):
    ReturnType<DefaultApiClient['getEntityMetrics']>;
}

export const githubCopilotApiRef = createApiRef<GitHubCopilotApi>({
  id: 'plugin.github-copilot.api',
});
```

```typescript
// In plugin.ts or wherever the plugin is created:
export const githubCopilotPlugin = createPlugin({
  id: 'github-copilot',
  apis: [
    createApiFactory({
      api: githubCopilotApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory({ discoveryApi, fetchApi }) {
        return new DefaultApiClient({
          baseUrl: discoveryApi.getBaseUrl('github-copilot'),
          fetchApi,
        });
      },
    }),
  ],
});
```

## Real Backstage Catalog Example

The catalog plugin uses this exact pattern:

- **Spec**: `plugins/catalog-backend/src/schema/openapi.yaml` (1358 lines)
- **Generate**: `backstage-repo-tools package schema openapi generate --server --client-package packages/catalog-client`
- **Server generated**: `plugins/catalog-backend/src/schema/openapi/generated/router.ts` (1633 lines)
- **Client generated**: `packages/catalog-client/src/schema/openapi/generated/`
- **Backend usage**: `createRouter.ts` imports `createOpenApiRouter` from `../schema/openapi`
- **Frontend usage**: `CatalogClient.ts` wraps `DefaultApiClient` from `./schema/openapi`

## Pitfalls

1. **Don't skip the spec.** Hand-written routes become untyped quickly.
2. **operationId → function name.** `getEntityMetrics` becomes the handler key in `createOpenApiRouter`.
3. **`generated/` files are machine output.** Never hand-edit them. If something is wrong, fix the `openapi.yaml` spec and re-run `yarn generate`.
4. **The spec lives in `-common`.** Both backend and frontend need it for type consistency.
5. **In older Backstage versions**, `backstage-repo-tools` might not be available. Fall back to hand-written routes with explicit typing.
