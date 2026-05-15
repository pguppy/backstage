---
'@backstage/plugin-catalog-backend': minor
'@backstage/plugin-catalog-node': patch
---

Added `catalogStitcherServiceFactory` export and wired `catalogStitcherServiceRef` so external plugins can resolve the stitcher through dependency injection. Source names that conflict with reserved `entity.status` keys (e.g. `items`) are now rejected. Orphaned entity status rows are cleaned up during stitching. The `EntityStatusQuery` passed to status mergers now serves prefetched data from cache to avoid redundant database queries. The `createRouter` function now requires `statusStore` and `stitcher` in its options.
