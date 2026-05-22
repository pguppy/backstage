---
name: backstage-techdocs
description: "Use when setting up, configuring, or troubleshooting TechDocs in Backstage. Covers the complete lifecycle: annotation setup, mkdocs.yml configuration, generator pipeline (preparer → generator → publisher), CI/CD integration, cloud storage (GCS/S3/Azure), reader/transformers/addons, build strategies, caching, and troubleshooting."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, techdocs, documentation, mkdocs, ci-cd, cloud-storage]
    related_skills: [backstage-plugin-blueprint, backstage-catalog-system, backstage-app-config, backstage-cli]
---

# Backstage TechDocs

## Architecture Overview

TechDocs renders Markdown documentation as static HTML directly on entity pages, powered by MkDocs under the hood.

```
Source (GitHub/GitLab/etc.)
  ↓ Preparer: fetches markdown files
  ↓ Generator: runs mkdocs → static HTML
  ↓ Publisher: stores in cloud/local storage
  ↓ Reader: serves HTML on entity page
```

**Architectures:**
- **Basic (dev):** Build on-the-fly. Generator runs in Docker container when docs are requested. Local filesystem storage.
- **Recommended (prod):** CI/CD pipeline builds docs in repo. Generated files stored in cloud storage (GCS/S3/Azure). Backend only reads and serves.

## Setup

### 1. Install Plugins

```bash
yarn workspace app add @backstage/plugin-techdocs
yarn workspace backend add @backstage/plugin-techdocs-backend
```

Backend wiring:
```ts
// packages/backend/src/index.ts
backend.add(import('@backstage/plugin-techdocs-backend'));
```

Frontend: `@backstage/plugin-techdocs` auto-discovers via feature discovery.

### 2. Entity Annotation

Add to any entity's `catalog-info.yaml`:

```yaml
metadata:
  annotations:
    backstage.io/techdocs-ref: dir:.          # mkdocs.yml at repo root
    # backstage.io/techdocs-ref: dir:./docs    # mkdocs.yml in docs/ subdirectory
    # backstage.io/techdocs-ref: url:https://.../docs/  # remote docs (rare)
```

Without this annotation, no TechDocs tab appears on the entity page.

### 3. mkdocs.yml (in entity's repository)

```yaml
site_name: 'My Service Documentation'
nav:
  - Home: index.md
  - Architecture: architecture.md
  - API: api.md
plugins:
  - techdocs-core
```

The `techdocs-core` plugin is auto-added by Backstage if missing (configurable).

### 4. docs/ Directory

```
docs/
  index.md          ← Required — landing page
  architecture.md   ← Optional — linked from nav
  api.md
  assets/           ← Images, diagrams
```

---

## Configuration

### Basic (Dev/Default)

```yaml
techdocs:
  builder: 'local'          # 'local' or 'external'
  generator:
    runIn: 'docker'         # 'docker' or 'local'
    dockerImage: 'spotify/techdocs'
    pullImage: true
  publisher:
    type: 'local'           # Filesystem storage
```

### Production (Recommended)

```yaml
techdocs:
  builder: 'external'       # Docs built externally (CI/CD)
  generator:
    runIn: 'local'          # Generator not needed — CI/CD builds
  publisher:
    type: 'googleGcs'       # Cloud storage
    googleGcs:
      bucketName: my-techdocs-bucket
      credentials: ${GCS_CREDENTIALS}
    # type: 'awsS3'
    # awsS3:
    #   bucketName: my-techdocs-bucket
    #   region: us-east-1
    #   credentials:
    #     accessKeyId: ${AWS_ACCESS_KEY_ID}
    #     secretAccessKey: ${AWS_SECRET_ACCESS_KEY}
    # type: 'azureBlobStorage'
    # azureBlobStorage:
    #   containerName: my-techdocs-container
    #   credentials:
    #     accountName: ${AZURE_ACCOUNT_NAME}
    #     accountKey: ${AZURE_ACCOUNT_KEY}
  cache:
    ttl: { minutes: 15 }   # Optional: cache generated docs
```

### Build Strategy

Controls whether docs are built locally or externally, per-entity:

```ts
// Default: build locally only if builder='local', skip otherwise
// Custom: hybrid — build some entities locally, others externally
class MyBuildStrategy implements DocsBuildStrategy {
  async shouldBuild(params: { entity: Entity }): Promise<boolean> {
    // Check entity annotations, labels, config etc.
    return params.entity.metadata.annotations?.['backstage.io/techdocs-local'] === 'true';
  }
}
```

---

## CI/CD Integration (Production Pattern)

Docs are built in CI, not on-demand in Backstage.

### GitHub Actions Example

```yaml
name: Publish TechDocs
on:
  push:
    branches: [main]
    paths: ['docs/**', 'mkdocs.yml']
jobs:
  publish-techdocs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: backstage/techdocs-action@v1
        with:
          storage-type: gcs           # or awsS3, azureBlobStorage
          storage-bucket: my-bucket
          # GCS credentials from GitHub Secrets
          gcs-credentials: ${{ secrets.GCS_SA_KEY }}
          # Or S3:
          # aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          # aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          entity-kind: Component
          entity-name: my-service
```

### Manual (techdocs-cli)

```bash
npx @techdocs/cli generate --output-dir ./site
npx @techdocs/cli publish --publisher-type googleGcs \
  --storage-name my-bucket --entity default/Component/my-service
```

---

## Reader: How Docs Render on Entity Pages

1. User clicks "Docs" tab on entity page
2. Frontend calls `techdocsStorageApi.getEntityDocs(entity, path)`
3. Backend fetches static files from publisher storage
4. Static HTML returned (JavaScript stripped for security)
5. "Transformers" modify HTML: rewrite links, inject CSS, adjust DOM
6. "Addons" inject React components into the rendered page

### Transformers

```ts
// Rewrite relative links to absolute:
const transformer = (dom: Element) => {
  dom.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href');
    if (href?.startsWith('./')) {
      a.setAttribute('href', `https://docs.example.com/${href}`);
    }
  });
  return dom;
};
```

### Addons (React Extensions)

```tsx
import { createTechDocsAddonExtension } from '@backstage/plugin-techdocs-react';

export const MyAddon = createTechDocsAddonExtension({
  name: 'MyAddon',
  component: () => <div>Injected into every TechDocs page</div>,
  location: 'Header', // Where to render: 'Header', 'Content', 'PrimarySidebar'
});
```

---

## Caching

TechDocs backend can cache responses to reduce storage latency:

```yaml
techdocs:
  cache:
    ttl: { minutes: 30 }
    # Uses Backstage's cache service — same backend.cache store
```

```yaml
backend:
  cache:
    store: redis          # Recommended for multi-instance
    connection: redis://localhost:6379
```

The cache stores the generated HTML pages per entity+path, with configurable TTL.

---

## TechDocs CLI

```bash
# Generate docs locally
yarn techdocs-cli generate --no-docker
yarn techdocs-cli serve              # Preview at localhost:3000
yarn techdocs-cli serve --mkdocs-port 8000

# Publish to cloud storage
yarn techdocs-cli publish --publisher-type googleGcs \
  --storage-name my-bucket --entity default/Component/my-service
```

---

## Common Pitfalls

1. **Missing `backstage.io/techdocs-ref` annotation** — No doc tab renders without it.
2. **`mkdocs.yml` at wrong path** — If `dir:.` but `mkdocs.yml` is in `docs/`, nothing builds.
3. **Docker not running** — With `runIn: docker`, TechDocs silently fails if Docker daemon is down.
4. **Missing `techdocs-core` plugin** — Install: `pip install mkdocs-techdocs-core`
5. **Large docs build timeouts** — Production: move generation to CI/CD, not on-request.
6. **Cloud storage permissions** — Backend needs Read permission. CI/CD needs Write.
7. **JavaScript in docs** — Backstage strips all JS for security. Interactive features need addons.
8. **`mkdocs.yml` nav doesn't match files** — Missing files in nav = broken links on entity page.
9. **Caching stale docs** — After CI/CD build, purge cache if TTL hasn't expired.
10. **URL Reader vs Git Preparer** — URL Reader (API-based) is faster. Git Preparer (`git clone`) is slower but works with any repo.

## Verification Checklist

- [ ] `@backstage/plugin-techdocs` installed in frontend
- [ ] `@backstage/plugin-techdocs-backend` installed + wired in backend
- [ ] Entity has `backstage.io/techdocs-ref` annotation
- [ ] `mkdocs.yml` exists in entity's repo at the annotated path
- [ ] `docs/index.md` exists with content
- [ ] `techdocs-core` plugin in `mkdocs.yml`
- [ ] Producer: `builder` set to `local` for dev, `external` for prod
- [ ] Publisher: cloud storage in production, local in dev
- [ ] CI/CD pipeline builds docs on push to main
- [ ] Storage credentials configured with correct permissions
- [ ] Cache enabled in production for latency reduction
- [ ] Docker available if using `runIn: docker`
