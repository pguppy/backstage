---
'@backstage/catalog-client': patch
'@backstage/plugin-catalog-node': patch
---

Added `setEntityStatus` and `deleteEntityStatus` methods to the `CatalogApi` and `CatalogService` interfaces for managing out-of-band entity status from in-process plugins and frontend clients.
