# Catalog Status API — Key Design Decisions

See full spec: `.hermes/designs/catalog-status-api-spec.md`

## Core Insight

Status belongs IN the entity, not in a separate system. `AlphaEntity` already has `status?: EntityStatus`. The framework made this decision — our job is build the write infrastructure.

## Fast Write Pattern

For high-frequency entity field updates (CI/CD, PagerDuty, health checks):

1. Event/API → buffer table (`entity_status_buffer`) — single-row upsert, <1ms
2. Mark entity "stitch needed"
3. Stitcher drains buffer → merges into entity's `final_entity` → clears buffer
4. Entity API returns status inline — no separate endpoint needed

## Why Not a Separate Table/Plugin

- `AlphaEntity extends Entity { status?: EntityStatus }` — status IS an entity field
- Separate table = consistency problems, extra API, extra frontend code
- Entity is single source of truth
- Same pattern as `relations` — dynamic data stitched into entity, not sharded out
