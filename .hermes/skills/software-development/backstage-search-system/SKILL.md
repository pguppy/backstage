---
name: backstage-search-system
description: "Use when building search in Backstage: configuring engines (Elasticsearch, PostgreSQL), creating collators, customizing search result rendering, or integrating search into plugins."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, search, elasticsearch, collators, search-engine]
    related_skills: [backstage-plugin-blueprint, backstage-core-services, backstage-catalog-system]
---

# Backstage Search System

## Overview

11 packages. Pluggable search: engine backends (Elasticsearch, PostgreSQL), collators that index data, frontend with custom result rendering. Default engine is Lunr (in-memory) for development. Powered by `IndexBuilder` which collects collators and decorators, builds a scheduler, and periodically refreshes the index.

**Architecture:** `Plugin Data → Collator → IndexBuilder → Search Engine → User Query → Results → Frontend`

### Backend Flow

1. `searchIndexRegistryExtensionPoint` collects collators + decorators from modules
2. `searchEngineRegistryExtensionPoint` lets modules override the default Lunr engine
3. On init: `IndexBuilder` compiles collators into scheduled tasks
4. REST API at `/api/search/query` serves search results
5. Optional permission-aware engine wraps results with authorization checks

## Search Engines

### Elasticsearch

```yaml
search:
  elasticsearch:
    node: https://elastic.example.com:9200
    auth: { username: ${ES_USERNAME}, password: ${ES_PASSWORD} }
```
Install: `backend.add(import('@backstage/plugin-search-backend-module-elasticsearch'))`

### PostgreSQL

```yaml
search:
  pg:
    connection: { host: ${POSTGRES_HOST}, user: ${POSTGRES_USER}, password: ${POSTGRES_PASSWORD} }
```
Install: `backend.add(import('@backstage/plugin-search-backend-module-pg'))`

## Collators

Built-in: `search-backend-module-catalog` (entities), `search-backend-module-techdocs` (docs), `search-backend-module-explore` (tools), `search-backend-module-stack-overflow-collator` (Q&A).

Install:
```ts
backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));
```

### Custom Collator (Registered via Extension Point)

```ts
// In a search-backend-module:
import { searchIndexRegistryExtensionPoint } from '@backstage/plugin-search-backend-node/alpha';

export const searchModuleMyCollator = createBackendModule({
  pluginId: 'search', moduleId: 'my-collator',
  register(env) {
    env.registerInit({
      deps: { searchIndex: searchIndexRegistryExtensionPoint, scheduler: coreServices.scheduler },
      async init({ searchIndex, scheduler }) {
        searchIndex.addCollator({
          schedule: scheduler.createScheduledTaskRunner({ frequency: { minutes: 30 }, timeout: { minutes: 5 } }),
          factory: MyCollatorFactory.fromConfig(/* ... */),
        });
      },
    });
  },
});
```

### IndexableDocument Spec

```ts
interface IndexableDocument {
  title: string; text: string; location: string;
  kind?: string; lifecycle?: string; owner?: string;
  authorization?: { resourceRef: string; };
}
```

### Scheduling Collators

Each collator gets its own schedule via `scheduler.createScheduledTaskRunner`:

```ts
searchIndex.addCollator({ schedule: scheduler.createScheduledTaskRunner({ frequency: { hours: 1 }, timeout: { minutes: 10 } }), factory: ... });
```

### Custom Search Engine

```ts
searchEngineRegistryExtensionPoint.setSearchEngine(new MyCustomEngine());
```

### Search Page Component

```tsx
import { SearchPage, SearchBar, SearchResult, SearchResultPaging } from '@backstage/plugin-search';
<SearchPage><SearchBar /><SearchResult><SearchResultPaging /></SearchResult></SearchPage>
```

## Frontend

### Custom Search Result Items

```tsx
import { SearchResultListItemBlueprint } from '@backstage/plugin-search-react/alpha';
const myResult = SearchResultListItemBlueprint.make({
  name: 'my-type',
  params: {
    predicate: (result) => result.kind === 'my-data',
    loader: () => import('./MyResult').then(m => <m.MyResult />),
  },
});
```

### Search API

```tsx
const searchApi = useApi(searchApiRef);
const results = await searchApi.query({ term: 'my-service', types: ['catalog'] });
```

## Decorators

Modify documents before indexing:

```ts
class MyDecorator implements DocumentDecoratorFactory {
  async getDecorator() { return async (doc) => { doc.title = `[Custom] ${doc.title}`; return doc; }; }
}
```

## Search Engine Configuration

### PostgreSQL (Default)

```yaml
search:
  engine: postgres
  pg:
    highlightOptions:
      useHighlight: true
      maxWords: 35
      minWords: 15
      shortWord: 3
      maxFragments: 3
      fragmentDelimiter: ' … '
```

### Elasticsearch/OpenSearch

```bash
yarn workspace backend add @backstage/plugin-search-backend-module-elasticsearch
```

```yaml
search:
  engine: elasticsearch
  elasticsearch:
    cloud:
      id: ${ELASTICSEARCH_CLOUD_ID}
      username: ${ELASTICSEARCH_USERNAME}
      password: ${ELASTICSEARCH_PASSWORD}
    # Or node-based:
    # node: http://localhost:9200
```

```ts
backend.add(import('@backstage/plugin-search-backend-module-elasticsearch'));
```

## Collator Development

```ts
import { IndexableDocument } from '@backstage/plugin-search-common';

class MyCollator implements DocumentCollatorFactory {
  readonly type = 'my-docs';

  async getCollator(): Promise<Readable<IndexableDocument>> {
    return Readable.from(this.execute());
  }

  async *execute(): AsyncGenerator<IndexableDocument> {
    const items = await fetchItems();
    for (const item of items) {
      yield {
        title: item.name,
        text: item.description,
        location: `/my-plugin/${item.id}`,
        authorization: {
          resourceRef: `my-resource:default/${item.id}`,
          // Supports conditional permission filtering in search results
        },
      };
    }
  }
}
```

### Register Collator via Module

```ts
import { searchIndexRegistryExtensionPoint } from '@backstage/plugin-search-backend-node';

export default createBackendModule({
  pluginId: 'search',
  moduleId: 'my-collator',
  register(env) {
    env.registerInit({
      deps: {
        search: searchIndexRegistryExtensionPoint,
        scheduler: coreServices.scheduler,
      },
      async init({ search, scheduler }) {
        search.addCollator({
          schedule: scheduler.createScheduledTaskRunner({
            frequency: { minutes: 10 },
            timeout: { minutes: 5 },
          }),
          factory: MyCollator.fromConfig(/* ... */),
        });
      },
    });
  },
});
```

### Decorator Pattern

```ts
class MyDecorator implements DocumentDecoratorFactory {
  async getDecorator(): Promise<DocumentDecorator> {
    return async (document: IndexableDocument) => {
      // Enrich documents before indexing
      document.lifecycle = await getLifecycle(document.title);
      document.owner = await getOwner(document.title);
      return document;
    };
  }
}
```

## Search Page Customization

### Custom Result Item Component

```tsx
const MyResultItem = SearchResultListItemBlueprint.make({
  name: 'my-result-item',
  params: {
    predicate: result => result.type === 'my-docs',
    component: () => import('./MyResultItem').then(m => <m.MyResultItem />),
  },
});
```

### Custom Filter

```tsx
const MyFilter = CatalogFilterBlueprint.make({
  name: 'my-filter',
  params: {
    loader: () => import('./MyFilter').then(m => <m.MyFilter />),
  },
});
```

## Scheduling & Indexing

```yaml
search:
  collators:
    schedule: { frequency: { minutes: 10 }, timeout: { minutes: 5 } }
    # Batch size for indexing
    batchSize: 100
```

## Common Pitfalls

1. No collators installed — search returns nothing
2. ES not running — silent failure, no results
3. Collator not scheduled — stale data
4. Large documents — keep `text` field lean
5. Missing `type` on custom documents

## Verification Checklist

- [ ] Search backend + engine + collators installed
- [ ] Engine configured and running
- [ ] Custom collators implement `DocumentCollatorFactory`
- [ ] Custom result items use `SearchResultListItemBlueprint`
- [ ] Collators scheduled for refresh
