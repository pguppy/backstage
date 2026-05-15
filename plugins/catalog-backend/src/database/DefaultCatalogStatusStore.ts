/*
 * Copyright 2026 The Backstage Authors
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
import { Knex } from 'knex';
import { JsonObject } from '@backstage/types';
import { LoggerService } from '@backstage/backend-plugin-api';

export class DefaultCatalogStatusStore {
  constructor(
    private readonly db: Knex,
    private readonly logger: LoggerService,
  ) {}

  async setStatus(entityRef: string, source: string, status: JsonObject) {
    await this.db('entity_status')
      .insert({
        entity_ref: entityRef.toLowerCase(),
        source: source,
        status: JSON.stringify(status),
        updated_at: this.db.fn.now(),
      })
      .onConflict(['entity_ref', 'source'])
      .merge(['status', 'updated_at']);
  }

  async deleteStatus(entityRef: string, source: string): Promise<number> {
    const deleted = await this.db('entity_status')
      .where('entity_ref', entityRef.toLowerCase())
      .where('source', source)
      .delete();
    return deleted;
  }

  async getStatuses(
    entityRefs: string[],
  ): Promise<Map<string, Record<string, JsonObject>>> {
    const rows = await this.db('entity_status')
      .whereIn(
        'entity_ref',
        entityRefs.map(r => r.toLowerCase()),
      )
      .select('entity_ref', 'source', 'status');

    const result = new Map<string, Record<string, JsonObject>>();
    for (const row of rows) {
      if (!result.has(row.entity_ref)) result.set(row.entity_ref, {});
      try {
        result.get(row.entity_ref)![row.source] = JSON.parse(row.status);
      } catch (e) {
        this.logger.debug(
          `Failed to parse status for entity ${row.entity_ref} from source ${row.source}`,
          e,
        );
        result.get(row.entity_ref)![row.source] = {};
      }
    }
    return result;
  }

  async listSources(entityRef: string): Promise<string[]> {
    const rows = await this.db('entity_status')
      .where('entity_ref', entityRef.toLowerCase())
      .select('source');
    return rows.map(r => r.source);
  }

  async deleteAllForEntity(entityRef: string): Promise<number> {
    return this.db('entity_status')
      .where('entity_ref', entityRef.toLowerCase())
      .delete();
  }

  async cleanOrphanedStatuses(batchSize: number = 500): Promise<number> {
    // Find orphan refs in a subquery, then delete them in one operation.
    // This is more atomic than SELECT + DELETE which can race with
    // concurrent refresh_state inserts.
    const orphanRefs = this.db('entity_status')
      .select('entity_status.entity_ref')
      .leftJoin(
        'refresh_state',
        'entity_status.entity_ref',
        'refresh_state.entity_ref',
      )
      .whereNull('refresh_state.entity_ref')
      .limit(batchSize);

    const deleted = await this.db('entity_status')
      .whereIn('entity_ref', orphanRefs)
      .delete();

    return deleted;
  }
}
