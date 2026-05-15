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
import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import { DefaultCatalogStatusStore } from './DefaultCatalogStatusStore';
import { applyDatabaseMigrations } from './migrations';

describe('DefaultCatalogStatusStore', () => {
  const databases = TestDatabases.create();
  it.each(databases.eachSupportedId())(
    'should set and get status on %p',
    async id => {
      const knex = await databases.init(id);
      await applyDatabaseMigrations(knex);
      const store = new DefaultCatalogStatusStore(
        knex,
        mockServices.logger.mock(),
      );
      await store.setStatus('component:default/test', 'github', { prs: 5 });
      const result = await store.getStatuses(['component:default/test']);
      expect(result.get('component:default/test')).toEqual({
        github: { prs: 5 },
      });
    },
  );

  it.each(databases.eachSupportedId())(
    'should delete status by source on %p',
    async id => {
      const knex = await databases.init(id);
      await applyDatabaseMigrations(knex);
      const store = new DefaultCatalogStatusStore(
        knex,
        mockServices.logger.mock(),
      );
      await store.setStatus('component:default/test', 'github', { prs: 5 });
      await store.setStatus('component:default/test', 'pagerduty', {
        alerts: 1,
      });
      await store.deleteStatus('component:default/test', 'github');
      const result = await store.getStatuses(['component:default/test']);
      expect(result.get('component:default/test')).toEqual({
        pagerduty: { alerts: 1 },
      });
    },
  );

  it.each(databases.eachSupportedId())(
    'should return 0 when deleting non-existent status on %p',
    async id => {
      const knex = await databases.init(id);
      await applyDatabaseMigrations(knex);
      const store = new DefaultCatalogStatusStore(
        knex,
        mockServices.logger.mock(),
      );
      const deleted = await store.deleteStatus(
        'component:default/test',
        'nonexistent',
      );
      expect(deleted).toBe(0);
    },
  );
});
