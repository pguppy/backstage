# Catalog Processor Type Import Gotchas

Common import errors when writing catalog processors and modules. Verified against Backstage v1.51.0-next.3.

## 1. `catalogProcessingExtensionPoint` — Must import from `/alpha`

❌ `import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node'`

✅ `import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node/alpha'`

## 2. `LocationSpec` — From `@backstage/plugin-catalog-common`, not `@backstage/catalog-model`

❌ `import type { LocationSpec } from '@backstage/catalog-model'`

✅ `import type { LocationSpec } from '@backstage/plugin-catalog-common'`

## 3. `SerializedError` — From `@backstage/errors`, not `@backstage/catalog-model/alpha`

❌ `import type { SerializedError } from '@backstage/catalog-model/alpha'`

✅ `import type { SerializedError } from '@backstage/errors'`

`EntityStatusItem` IS exported from `@backstage/catalog-model/alpha` but `SerializedError` is re-exported there from `@backstage/errors`. The direct import from `@backstage/errors` is correct and avoids re-export chains.

## 4. `BackstageCredentials` — Generic with `principal` typed as `unknown`

```ts
// BackstageCredentials<TPrincipal = unknown>
type BackstageCredentials<TPrincipal = unknown> = {
  principal: TPrincipal;  // ← unknown unless you specify TPrincipal
};

// To access .principal.type / .principal.subjects, use:
import type { BackstageCredentials } from '@backstage/backend-plugin-api';
// Cast in your code:
const principal = (credentials as BackstageCredentials<{ type: string; subjects: string[] }>).principal;
```

## 5. `CatalogProcessor.postProcessEntity` — 4-arg signature

❌ `postProcessEntity(entity: Entity, emit: CatalogProcessorEmit): Promise<Entity>`

✅ `postProcessEntity(entity: Entity, location: LocationSpec, emit: CatalogProcessorEmit, cache: CatalogProcessorCache): Promise<Entity>`

The `CatalogProcessor` interface requires all 4 parameters. Use `_` prefixes for unused params.

## 6. `Set` spread requires `Array.from()` 

When `downlevelIteration` is not enabled in tsconfig (common in Backstage), spreading `Set` directly causes TS2802:

❌ `[...mySet]`

✅ `Array.from(mySet)`

## 7. `workspace:^` — Only for `@backstage/*` and `@internal/*` packages

❌ `"uuid": "workspace:^"`, `"express": "workspace:^"`, `"knex": "workspace:^"`

✅ `"uuid": "^11.0.0"`, `"express": "^4.17.1"`, `"knex": "^3.0.0"`

Using `workspace:^` on npm packages causes `YN0001: Workspace not found` during `yarn install`.
