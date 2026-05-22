# Catalog Processing Pipeline — Authoritative Excerpts

Source: `docs/features/software-catalog/life-of-an-entity.md` and `docs/features/software-catalog/descriptor-format.md`

## Processing vs Stitching

> "Processing, where the policies and processors continually treat the ingested data and may emit both other raw entities, errors, relations to other entities, etc."
> "Stitching, where all of the data emitted by various processors are assembled together into the final output entity."
> "An entity is not visible to the outside world (through the catalog API), until it has passed through the last process and landed among the final entities."

> "The stitching is currently a fixed process, that cannot be modified or extended."

**Key implication:** Processors (`preProcessEntity`, `postProcessEntity`) run during PROCESSING, not stitching. You can add processors via `catalogProcessingExtensionPoint.addProcessor()`. But you cannot modify the stitcher. All entity enrichment must happen during processing — the stitcher assembles whatever the processors produced.

## Status Field

> "The `status` root object is a read-only set of statuses, pertaining to the current state or health of the entity."

> "Each type may appear more than once in the array."

> "The current main use case for this field is for the ingestion processes of the catalog itself to convey information about errors and warnings back to the user."

**Key implications:**
1. Status is READ-ONLY in entity descriptor YAML — do NOT put `status:` in `catalog-info.yaml`
2. Multiple items with the same `type` can coexist (e.g., two `ci-cd/deployment` from different sources)
3. The built-in use case is catalog ingestion errors — your custom status system may overlap with core behavior

## Entity Refresh

> "POST /refresh" — "Refreshes the entity related to entityRef."

The `/refresh` endpoint marks an entity for reprocessing. It does NOT guarantee immediate update — the entity goes into the processing queue and is picked up on the next processing cycle.

## Entity Providers vs Processors

> "Entity providers — feed initial raw entity data into the catalog"
> "Policies — establish baseline rules about the shape of entities"
> "Processors — validate, analyze, and mutate the raw entity data into its final form"

Entity providers push raw entities. Processors transform them. The stitcher assembles the final result. All three are distinct phases.

## Processing Interval

The catalog's `processingInterval` (default 100-150 seconds) controls how often the processing loop runs. Each cycle:
1. Picks up unprocessed/updated entities from entity providers
2. Runs the processor pipeline on each entity
3. Passes processed entities to the stitcher
4. Stitcher assembles final entities and writes to DB

A `POST /refresh` call marks an entity to be picked up in the NEXT processing cycle — so latency is `processingInterval / 2` on average.
