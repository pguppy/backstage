---
name: backstage-app-config
description: "Use when configuring ANY Backstage instance via app-config.yaml. Covers the complete configuration surface: app, backend, catalog, scaffolder, auth, database, cache, search, techdocs, kubernetes, proxy, and all plugin configs. Includes secrets management, environment overrides, and config schema conventions."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, configuration, app-config, yaml, secrets, environment]
    related_skills: [backstage-core-services, backstage-catalog-system, backstage-scaffolder-system]
---

# Backstage App Configuration

## Overview

Backstage is configured through YAML files: `app-config.yaml` (default), `app-config.local.yaml` (gitignored, local overrides), and environment-specific files (`app-config.production.yaml`). Files are merged in order: later files override earlier ones.

**Config resolution:** `app-config.yaml` → `app-config.local.yaml` → `app-config.<env>.yaml`

**Core principle:** Every config key must have a `config.d.ts` type declaration with `@visibility` annotations. Without the declaration, TypeScript can't type-check config access.

## Config File Hierarchy

```yaml
# app-config.yaml — committed, defaults for all environments
app:
  title: My Backstage
  baseUrl: http://localhost:3000

# app-config.local.yaml — gitignored, developer overrides
app:
  baseUrl: http://localhost:3001

# app-config.production.yaml — production overrides
app:
  baseUrl: https://backstage.my-company.com
backend:
  baseUrl: https://backstage.my-company.com
  database:
    client: pg
    connection:
      host: ${POSTGRES_HOST}
      user: ${POSTGRES_USER}
      password: ${POSTGRES_SECRET}
```

## Config Schema Conventions

Every plugin consuming config MUST declare a schema:

```ts
// config.d.ts
export interface Config {
  myPlugin?: {
    /**
     * API endpoint URL
     * @visibility frontend  // ← accessible in browser
     */
    apiUrl?: string;

    /**
     * API authentication token
     * @visibility secret      // ← never logged, backend only
     */
    apiToken?: string;

    /**
     * Feature flag
     * @visibility backend    // ← default, backend only
     */
    processInterval?: number;
  };
}
```

Reference in `package.json`: `"configSchema": "config.d.ts"`

## Complete Config Reference

### App (Frontend)

```yaml
app:
  title: Backstage                          # Browser tab title
  baseUrl: http://localhost:3000            # Frontend URL
  packages: all                             # Plugin discovery mode
  support:
    url: https://github.com/org/repo/issues # Support link
    items:                                  # Support dropdown items
      - title: Issues
        icon: github
        links: [{ url: https://..., title: GitHub Issues }]
  routes:
    bindings:                               # Cross-plugin route bindings
      catalog.viewTechDoc: techdocs.docRoot
  extensions:                               # Extension configuration
    - page:catalog/entity:
        config:
          showNavItemIcons: true
```

### Backend

```yaml
backend:
  baseUrl: http://localhost:7007            # Backend URL (for service discovery)
  listen:
    port: 7007                              # Listen port
    host: 0.0.0.0                           # Listen host
  cors:
    origin: http://localhost:3000           # CORS allowed origins
    methods: [GET, POST, PUT, DELETE]       # Allowed methods
    credentials: true                       # Allow credentials
  database:
    client: better-sqlite3                  # pg, sqlite3, better-sqlite3
    connection:
      filename: ':memory:'                  # SQLite: file or :memory:
      # For PostgreSQL:
      host: ${POSTGRES_HOST}
      port: ${POSTGRES_PORT}
      user: ${POSTGRES_USER}
      password: ${POSTGRES_SECRET}
      database: backstage
    plugin:
      catalog:
        connection:                          # Plugin-specific DB override
          database: catalog-db
  cache:
    store: memory                           # memory, redis, memcache, valkey
    connection: redis://localhost:6379      # For redis/valkey
  auth:
    dangerouslyDisableDefaultAuthPolicy: false
  rateLimit:
    global: true
    window: 6s
    incomingRequestLimit: 100
    plugin:
      catalog: { window: 3s, incomingRequestLimit: 50 }
  reading:
    allow: [{ host: github.com }]           # Allowed URL reader hosts
  lifecycle:
    startupRequestPauseTimeout: { seconds: 5 }
    serverShutdownDelay: { seconds: 0 }
  server:
    headersTimeout: 60000
    requestTimeout: 30s
  csp:                                      # Content Security Policy
    default-src: ["'self'"]
    script-src: ["'self'", "'unsafe-inline'"]
    connect-src: ["'self'", 'http:', 'https:']
  health:
    headers:
      service-name: my-service
  auditor:
    severityLogLevelMappings:
      low: debug
      medium: info
      high: warn
      critical: error
```

### Catalog

```yaml
catalog:
  processingInterval: { minutes: 3 }
  staleEntityThreshold: { hours: 24 }
  orphanStrategy: delete                     # delete | keep
  rules:
    - allow: [Component, API, Resource, System, Domain, Group, User, Template, Location]
  locations:
    - type: url
      target: https://github.com/org/repo/blob/main/catalog-info.yaml
    - type: file
      target: ./local/entities.yaml
  providers:
    github:
      organization: my-org
      schedule: { frequency: { minutes: 30 }, timeout: { minutes: 5 } }
```

### Auth

```yaml
auth:
  environment: development
  providers:
    github:
      development:
        clientId: ${GITHUB_CLIENT_ID}
        clientSecret: ${GITHUB_CLIENT_SECRET}
    google:
      development:
        clientId: ${GOOGLE_CLIENT_ID}
        clientSecret: ${GOOGLE_CLIENT_SECRET}
    okta:
      development:
        clientId: ${OKTA_CLIENT_ID}
        clientSecret: ${OKTA_CLIENT_SECRET}
        audience: ${OKTA_AUDIENCE}
```

### Scaffolder

```yaml
scaffolder:
  defaultTimeoutMinutes: 10
  maxTimeoutMinutes: 60
  experimental:
    enableBackstageUi: true
```

### Search

```yaml
search:
  elasticsearch:
    provider: aws                            # aws, elastic, or empty
    node: https://elastic.example.com:9200
    auth:
      username: ${ES_USERNAME}
      password: ${ES_PASSWORD}
```

### TechDocs

```yaml
techdocs:
  builder: local                            # local | external
  generator:
    runIn: local                            # local | docker
  publisher:
    type: local                             # local | awsS3 | googleGcs | azureBlobStorage
```

### Proxy

The backend proxy lets frontend code call external APIs without CORS issues. Requests go to `/api/proxy/<endpoint-path>` and are forwarded to the configured target.

```yaml
proxy:
  endpoints:
    /my-api:
      target: https://api.example.com
      changeOrigin: true
      headers:
        Authorization: Bearer ${API_TOKEN}
      # allowedHeaders: ['Authorization', 'Content-Type']
      # allowedMethods: ['GET', 'POST']
    /jenkins:
      target: https://jenkins.internal.corp
      changeOrigin: true
      headers:
        X-Jenkins-Auth: ${JENKINS_TOKEN}
```

**Usage from frontend:**

```ts
// Call the proxy — NOT the target URL directly
const response = await fetch('/api/proxy/my-api/v1/data');
const data = await response.json();

// With Backstage's fetchApi:
const { fetch } = useApi(fetchApiRef);
const response = await fetch('/api/proxy/jenkins/job/my-job/api/json');
```

**When to use proxy vs backend plugin API:**
- **Proxy:** Third-party APIs you don't control, simple pass-through, no Backstage integration needed
- **Backend plugin:** Need to add auth, transform data, cache, or integrate with Backstage services

**Config options per endpoint:**
- `target` — (required) The upstream URL to proxy to
- `changeOrigin` — Rewrite the Host header to match the target
- `headers` — Static headers added to every forwarded request
- `allowedHeaders` — Which client headers to forward (default: none)
- `allowedMethods` — Which HTTP methods to allow (default: all)

### Integrations

```yaml
integrations:
  github:
    - host: github.com
      token: ${GITHUB_TOKEN}
  gitlab:
    - host: gitlab.com
      token: ${GITLAB_TOKEN}
```

### Kubernetes

```yaml
kubernetes:
  serviceLocatorMethod:
    type: multiTenant
  clusterLocatorMethods:
    - type: config
      clusters:
        - name: production
          url: https://k8s.example.com
          authProvider: serviceAccount
          serviceAccountToken: ${K8S_TOKEN}
```

## Secrets & Environment Variables

Use `${ENV_VAR}` syntax for secrets. Supports `${ENV_VAR:-default}` for defaults:

```yaml
backend:
  database:
    connection:
      password: ${POSTGRES_PASSWORD}
      host: ${POSTGRES_HOST:-localhost}
```

## Environment-Specific Configs

Load additional configs via `--config` flag:

```bash
NODE_ENV=production yarn start --config app-config.production.yaml
```

Or configure in rootHttpRouter service factory:
```ts
backend.add(rootConfigServiceFactory({
  argv: ['--config', '/backstage/app-config.production.yaml'],
  remote: { reloadIntervalSeconds: 60 },
}));
```

## Production Deployment Configuration

### Database (PostgreSQL)

```yaml
backend:
  database:
    client: pg
    connection:
      host: ${POSTGRES_HOST}
      port: ${POSTGRES_PORT:-5432}
      user: ${POSTGRES_USER}
      password: ${POSTGRES_SECRET}
      database: backstage
    plugin:
      catalog:
        connection:
          database: catalog-db     # Plugin-specific database
    knexConfig:
      pool:
        min: 2
        max: 10
```

### Cache (Redis for multi-instance)

```yaml
backend:
  cache:
    store: redis
    connection: redis://${REDIS_HOST}:6379
    redis:
      namespace: backstage
      keyPrefixSeparator: ':'
```

### Rate Limiting (Production)

```yaml
backend:
  rateLimit:
    global: true
    window: 6s
    incomingRequestLimit: 100
    skipSuccessfulRequests: false
    store:
      type: redis
      connection: redis://${REDIS_HOST}:6379
  trustProxy: true    # If behind a load balancer/proxy
```

### Server Configuration

```yaml
backend:
  listen:
    port: 7007
    host: 0.0.0.0
  server:
    headersTimeout: 60000
    requestTimeout: 30s
    keepAliveTimeout: { seconds: 5 }
```

### CSP Headers (Production)

```yaml
backend:
  csp:
    default-src: ["'self'"]
    script-src: ["'self'", "'unsafe-inline'", "'unsafe-eval'"]
    connect-src: ["'self'", 'https:', 'wss:']
    img-src: ["'self'", 'data:', 'https:']
    style-src: ["'self'", "'unsafe-inline'"]
```

### Health Checks for Load Balancers

```yaml
backend:
  health:
    headers:
      x-envoy-upstream-healthchecked-cluster: backstage
      service-name: backstage
```

Endpoints: `/.backstage/health/v1/readiness`, `/.backstage/health/v1/liveness`

### Environment-Specific Configs

```bash
NODE_ENV=production yarn start --config app-config.production.yaml
```

Or via code:
```ts
backend.add(rootConfigServiceFactory({
  argv: ['--config', '/etc/backstage/app-config.production.yaml'],
}));
```

### Plugin-specific config
```yaml
myPlugin:
  apiUrl: https://api.example.com
  enableFeature: true
  retries: 3
```

### Using config in backend plugins
```ts
const config = await coreServices.rootConfig; // injected via deps
const url = config.getString('myPlugin.apiUrl');
const enabled = config.getOptionalBoolean('myPlugin.enableFeature') ?? true;
```

### Using config in frontend plugins
```tsx
const configApi = useApi(configApiRef);
const title = configApi.getString('app.title');
```

## Common Pitfalls

1. **Missing `@visibility frontend`** — Fields default to `@visibility backend`. Frontend can't read backend-only fields.
2. **Hardcoding secrets** — Always use `${ENV_VAR}` for tokens/passwords.
3. **Missing `configSchema` in package.json** — Config types won't be discovered without it.
4. **Wrong merge order** — `app-config.local.yaml` overrides `app-config.yaml`. Production configs load last.
5. **Nested config with incorrect types** — Use `config.getConfig('key')` for nested objects, not `config.getString('key.subkey')`.
6. **Not using `getOptional*` methods** — `config.getString()` throws if missing. Use `getOptionalString()` for optional fields.

## Verification Checklist

- [ ] `config.d.ts` exists with proper types and `@visibility` annotations
- [ ] `configSchema` in `package.json` points to `config.d.ts`
- [ ] Secrets use `${ENV_VAR}` syntax
- [ ] `app-config.local.yaml` is gitignored
- [ ] Frontend fields marked `@visibility frontend`
- [ ] Backend-only fields use default `@visibility backend`
- [ ] Sensitive fields marked `@visibility secret`
