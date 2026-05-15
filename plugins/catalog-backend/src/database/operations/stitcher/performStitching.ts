/*
 * Copyright 2023 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ENTITY_STATUS_CATALOG_PROCESSING_TYPE } from '@backstage/catalog-client';
import {
  ANNOTATION_EDIT_URL,
  ANNOTATION_VIEW_URL,
  EntityRelation,
} from '@backstage/catalog-model';
import { AlphaEntity, EntityStatusItem } from '@backstage/catalog-model/alpha';
import { SerializedError } from '@backstage/errors';
import { Knex } from 'knex';
import { StitchingStrategy } from '../../../stitching/types';
import {
  DbFinalEntitiesRow,
  DbRefreshStateRow,
  DbStitchQueueRow,
} from '../../tables';
import { buildEntitySearch } from './buildEntitySearch';
import { markDeferredStitchCompleted } from './markDeferredStitchCompleted';
import { syncSearchRows } from './syncSearchRows';
import { generateStableHash } from './util';
import {
  LoggerService,
  isDatabaseConflictError,
} from '@backstage/backend-plugin-api';
import {
  StitchingStatusMerger,
  EntityStatusQuery,
} from '@backstage/plugin-catalog-node/alpha';
import { sanitizeStatus, scriptProtocolPattern } from '../../../util/status';
import { DefaultCatalogStatusStore } from '../../DefaultCatalogStatusStore';
import { JsonObject } from '@backstage/types';

/**
 * Performs the act of stitching - to take all of the various outputs from the
 * ingestion process, and stitching them together into the final entity JSON
 * shape.
 */
export async function performStitching(options: {
  knex: Knex | Knex.Transaction;
  logger: LoggerService;
  strategy: StitchingStrategy;
  entityRef: string;
  stitchTicket?: string;
  stitchingStatusMergers?: StitchingStatusMerger[];
  statusStore: DefaultCatalogStatusStore;
  prefetchedStatuses?: Map<string, Record<string, JsonObject>>;
}): Promise<'changed' | 'unchanged' | 'abandoned'> {
  const { knex, logger, entityRef, stitchingStatusMergers } = options;
  const stitchTicket = options.stitchTicket;

  // In deferred mode, the entity is removed from the stitch queue on ANY
  // completion, except when an exception is thrown. In the latter case, the
  // entity will be retried at a later time.
  let removeFromStitchQueueOnCompletion = options.strategy.mode === 'deferred';

  try {
    const entityResult = await knex<DbRefreshStateRow>('refresh_state')
      .where({ entity_ref: entityRef })
      .limit(1)
      .select('entity_id');
    if (!entityResult.length) {
      // Entity does no exist in refresh state table, no stitching required.
      return 'abandoned';
    }

    // Ensure that a final_entities row exists for this entity.
    try {
      await knex<DbFinalEntitiesRow>('final_entities')
        .insert({
          entity_id: entityResult[0].entity_id,
          hash: '',
          entity_ref: entityRef,
        })
        .onConflict('entity_id')
        .ignore();
    } catch (error) {
      // It's possible to hit a race where a refresh_state table delete + insert
      // is done just after we read the entity_id from it. This conflict is safe
      // to ignore because the current stitching operation will be triggered by
      // the old entry, and the new entry will trigger it's own stitching that
      // will update the entity.
      if (isDatabaseConflictError(error)) {
        logger.debug(`Skipping stitching of ${entityRef}, conflict`, error);
        return 'abandoned';
      }

      throw error;
    }

    // Selecting from refresh_state and final_entities should yield exactly
    // one row (except in abnormal cases where the stitch was invoked for
    // something that didn't exist at all, in which case it's zero rows).
    // The join with the temporary incoming_references still gives one row.
    const [processedResult, relationsResult] = await Promise.all([
      knex
        .with('incoming_references', function incomingReferences(builder) {
          return builder
            .from('refresh_state_references')
            .where({ target_entity_ref: entityRef })
            .count({ count: '*' });
        })
        .select({
          entityId: 'refresh_state.entity_id',
          processedEntity: 'refresh_state.processed_entity',
          errors: 'refresh_state.errors',
          incomingReferenceCount: 'incoming_references.count',
          previousHash: 'final_entities.hash',
        })
        .from('refresh_state')
        .where({ 'refresh_state.entity_ref': entityRef })
        .crossJoin(knex.raw('incoming_references'))
        .leftOuterJoin('final_entities', {
          'final_entities.entity_id': 'refresh_state.entity_id',
        }),
      knex
        .distinct({
          relationType: 'type',
          relationTarget: 'target_entity_ref',
        })
        .from('relations')
        .where({ source_entity_ref: entityRef })
        .orderBy('relationType', 'asc')
        .orderBy('relationTarget', 'asc'),
    ]);

    // If there were no rows returned, it would mean that there was no
    // matching row even in the refresh_state. This can happen for example
    // if we emit a relation to something that hasn't been ingested yet.
    // It's safe to ignore this stitch attempt in that case.
    if (!processedResult.length) {
      logger.debug(
        `Unable to stitch ${entityRef}, item does not exist in refresh state table`,
      );
      return 'abandoned';
    }

    const {
      entityId,
      processedEntity,
      errors,
      incomingReferenceCount,
      previousHash,
    } = processedResult[0];

    // If there was no processed entity in place, the target hasn't been
    // through the processing steps yet. It's safe to ignore this stitch
    // attempt in that case, since another stitch will be triggered when
    // that processing has finished.
    if (!processedEntity) {
      logger.debug(
        `Unable to stitch ${entityRef}, the entity has not yet been processed`,
      );
      return 'abandoned';
    }

    // Grab the processed entity and stitch all of the relevant data into
    // it
    const entity = JSON.parse(processedEntity) as AlphaEntity;
    const isOrphan = Number(incomingReferenceCount) === 0;
    let statusItems: EntityStatusItem[] = [];

    if (isOrphan) {
      logger.debug(`${entityRef} is an orphan`);
      entity.metadata.annotations = {
        ...entity.metadata.annotations,
        ['backstage.io/orphan']: 'true',
      };
      try {
        await options.statusStore.deleteAllForEntity(entityRef);
      } catch (error) {
        logger.warn(
          `Failed to clean up status for orphaned entity ${entityRef}`,
          error,
        );
      }
    }
    if (errors) {
      const parsedErrors = JSON.parse(errors) as SerializedError[];
      if (Array.isArray(parsedErrors) && parsedErrors.length) {
        statusItems = parsedErrors.map(e => ({
          type: ENTITY_STATUS_CATALOG_PROCESSING_TYPE,
          level: 'error',
          message: `${e.name}: ${e.message}`,
          error: e,
        }));
      }
    }
    // We opt to do this check here as we otherwise can't guarantee that it will be run after all processors
    for (const annotation of [ANNOTATION_VIEW_URL, ANNOTATION_EDIT_URL]) {
      const value = entity.metadata.annotations?.[annotation];
      if (typeof value === 'string' && scriptProtocolPattern.test(value)) {
        entity.metadata.annotations![annotation] =
          'https://backstage.io/annotation-rejected-for-security-reasons';
      }
    }

    // TODO: entityRef is lower case and should be uppercase in the final
    // result
    entity.relations = relationsResult
      .filter(row => row.relationType /* exclude null row, if relevant */)
      .map<EntityRelation>(row => ({
        type: row.relationType!,
        targetRef: row.relationTarget!,
      }));

    if (stitchingStatusMergers?.length) {
      const prefetched = options.prefetchedStatuses ?? new Map();
      const query: EntityStatusQuery = {
        getStatuses: async (refs: string[]) => {
          const result = new Map<string, Record<string, JsonObject>>();
          const uncached: string[] = [];
          for (const ref of refs) {
            const cached = prefetched.get(ref);
            if (cached) {
              result.set(ref, cached);
            } else {
              uncached.push(ref);
            }
          }
          if (uncached.length > 0) {
            logger.debug(
              `EntityStatusQuery cache miss for ${uncached.length} ref(s) during stitch of ${entityRef}`,
            );
            const fetched = await options.statusStore.getStatuses(uncached);
            for (const [ref, data] of fetched) {
              result.set(ref, data);
            }
          }
          return result;
        },
      };

      for (const merger of stitchingStatusMergers) {
        try {
          await merger.merge({ entity, entityRef, query });
        } catch (error) {
          logger.warn(`StitchingStatusMerger failed for ${entityRef}`, error);
        }
      }
    }

    if (statusItems.length) {
      entity.status = {
        ...entity.status,
        items: [...(entity.status?.items ?? []), ...statusItems],
      };
    }

    if (entity.status) {
      entity.status = sanitizeStatus(entity.status);
    }

    // If the output entity was actually not changed, just abort
    const hash = generateStableHash(entity);
    if (hash === previousHash) {
      logger.debug(`Skipped stitching of ${entityRef}, no changes`);
      return 'unchanged';
    }

    entity.metadata.uid = entityId;
    if (!entity.metadata.etag) {
      // If the original data source did not have its own etag handling,
      // use the hash as a good-quality etag
      entity.metadata.etag = hash;
    }

    // This may throw if the entity is invalid, so we call it before
    // the final_entities write, even though we may end up not needing
    // to write the search index.
    const searchEntries = buildEntitySearch(entityId, entity);

    let updateQuery = knex<DbFinalEntitiesRow>('final_entities')
      .update({
        final_entity: JSON.stringify(entity),
        hash,
        last_updated_at: knex.fn.now(),
      })
      .where('entity_id', entityId);

    // In deferred mode, guard against concurrent stitchers by checking that
    // the stitch_ticket in stitch_queue still matches what we were given.
    if (options.strategy.mode === 'deferred' && stitchTicket) {
      updateQuery = updateQuery.whereExists(
        knex<DbStitchQueueRow>('stitch_queue')
          .where('stitch_queue.entity_ref', entityRef)
          .where('stitch_queue.stitch_ticket', stitchTicket)
          .select(knex.raw('1')),
      );
    }

    const amountOfRowsChanged = await updateQuery;

    if (amountOfRowsChanged === 0) {
      logger.debug(`Entity ${entityRef} is already stitched, skipping write.`);
      return 'abandoned';
    }

    await syncSearchRows(knex, entityId, searchEntries);

    return 'changed';
  } catch (error) {
    removeFromStitchQueueOnCompletion = false;
    throw error;
  } finally {
    if (removeFromStitchQueueOnCompletion && stitchTicket) {
      await markDeferredStitchCompleted({
        knex: knex,
        entityRef,
        stitchTicket,
      });
    }
  }
}
