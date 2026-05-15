# Catalog Status API Remediation Plan V2

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the critical race condition in the stitching cache and address remaining quality/maintainability issues.

**Architecture:** We will replace the shared `batchCache` with an `AsyncLocalStorage` based context to ensure thread-safe concurrent stitching. We will also extract sanitization logic into a utility and improve type safety.

**Tech Stack:** TypeScript, Node.js AsyncLocalStorage, Backstage Backend System.

---

### Task 1: Fix Stitching Race Condition

**Files:**

- Modify: `plugins/catalog-backend/src/service/CatalogBuilder.ts`

- [ ] **Step 1: Replace shared Map with AsyncLocalStorage**

```typescript
import { AsyncLocalStorage } from 'async_hooks';

// Inside CatalogBuilder.build()
const statusStore = new DefaultCatalogStatusStore(dbClient, logger);
const stitchingContext = new AsyncLocalStorage<
  Map<string, Record<string, JsonObject>>
>();

this.addStitchingStatusMerger({
  async preFetch({ entityRefs }) {
    const statuses = await statusStore.getStatuses(entityRefs);
    stitchingContext.enterWith(statuses);
  },

  async merge({ entity, entityRef }) {
    const batchCache = stitchingContext.getStore();
    const statusData = batchCache?.get(entityRef.toLowerCase());
    if (statusData) {
      entity.status = {
        ...entity.status,
        ...statusData,
      };
    }
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add plugins/catalog-backend/src/service/CatalogBuilder.ts
git commit -m "fix(catalog-backend): resolve race condition in status stitching cache"
```

---

### Task 2: Extract Sanitization Utility

**Files:**

- Create: `plugins/catalog-backend/src/util/status.ts`
- Modify: `plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`

- [ ] **Step 1: Create status utility**

```typescript
// plugins/catalog-backend/src/util/status.ts
import { JsonObject } from '@backstage/types';

const scriptProtocolPattern =
  /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*\:/i;

export function sanitizeStatus(status: JsonObject) {
  const sanitize = (obj: any) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && scriptProtocolPattern.test(value)) {
        obj[key] =
          'https://backstage.io/annotation-rejected-for-security-reasons';
      } else if (typeof value === 'object') {
        sanitize(value);
      }
    }
  };
  sanitize(status);
}
```

- [ ] **Step 2: Use utility in performStitching**

- [ ] **Step 3: Commit**

```bash
git add plugins/catalog-backend/src/util/status.ts plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts
git commit -m "refactor(catalog-backend): extract status sanitization to utility"
```

---

### Task 3: Final Polishing

**Files:**

- Modify: `plugins/catalog-backend/src/service/createRouter.ts`
- Modify: `plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts`

- [ ] **Step 1: Remove any casts in router and improve meta**

- [ ] **Step 2: Lower log level for JSON parse failures**

- [ ] **Step 3: Final verification**

Run: `yarn tsc && yarn test --no-watch`

- [ ] **Step 4: Commit**

```bash
git add plugins/catalog-backend/src/service/createRouter.ts plugins/catalog-backend/src/database/DefaultCatalogStatusStore.ts
git commit -m "style(catalog-backend): final polishing of status api implementation"
```
