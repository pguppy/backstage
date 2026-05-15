---
'@backstage/plugin-catalog-backend': patch
---

Added batch status write endpoint `POST /entities/status-batch` for bulk status updates. The `?stitch=deferred` query parameter on status endpoints is renamed to `?stitch=skip` to clarify that no stitch is triggered when this option is used.
