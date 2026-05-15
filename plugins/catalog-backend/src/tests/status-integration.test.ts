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
import {
  startTestBackend,
  mockServices,
  mockCredentials,
  TestDatabases,
} from '@backstage/backend-test-utils';
import { catalogPlugin } from '../service/CatalogPlugin';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { createBackendModule } from '@backstage/backend-plugin-api';
import request from 'supertest';
import waitForExpect from 'wait-for-expect';

describe('Native Entity Status Integration', () => {
  const databases = TestDatabases.create();

  it.each(databases.eachSupportedId())(
    'should update entity status and reflect it in the catalog on %p',
    async databaseId => {
      const knex = await databases.init(databaseId);

      // A simple module to provide a test entity
      const testEntityProvider = createBackendModule({
        pluginId: 'catalog',
        moduleId: 'test-provider',
        register(env) {
          env.registerInit({
            deps: {
              processing: catalogProcessingExtensionPoint,
            },
            async init({ processing }) {
              processing.addEntityProvider({
                getProviderName: () => 'test',
                async connect(connection) {
                  await connection.applyMutation({
                    type: 'full',
                    entities: [
                      {
                        entity: {
                          apiVersion: 'backstage.io/v1alpha1',
                          kind: 'Component',
                          metadata: {
                            name: 'test',
                            namespace: 'default',
                            annotations: {
                              'backstage.io/managed-by-location':
                                'url:https://example.com',
                              'backstage.io/managed-by-origin-location':
                                'url:https://example.com',
                            },
                          },
                          spec: {
                            type: 'service',
                            owner: 'user:guest',
                            lifecycle: 'experimental',
                          },
                        },
                      },
                    ],
                  });
                },
              });
            },
          });
        },
      });

      const { server } = await startTestBackend({
        features: [
          catalogPlugin,
          testEntityProvider,
          mockServices.rootConfig.factory({
            data: {
              catalog: {
                stitching: { strategy: { mode: 'immediate' } },
                processingInterval: { seconds: 1 },
              },
            },
          }),
          mockServices.database.factory({ knex }),
        ],
      });

      // 1. Verify entity exists without status
      await waitForExpect(async () => {
        const response = await request(server)
          .get('/api/catalog/entities/by-name/component/default/test')
          .set('Authorization', mockCredentials.user.header());
        expect(response.status).toBe(200);
        expect(response.body.status).toBeUndefined();
      }, 15000);

      // 2. Push a status update to the NATIVE endpoint
      const statusUpdate = {
        source: 'test-source',
        status: {
          ok: true,
          message: 'All systems go',
        },
      };

      const pushResponse = await request(server)
        .post('/api/catalog/entities/by-name/component/default/test/status')
        .set('Authorization', mockCredentials.user.header())
        .send(statusUpdate);

      expect(pushResponse.status).toBe(204);

      // 3. Verify status reflected in the catalog
      await waitForExpect(async () => {
        const response = await request(server)
          .get('/api/catalog/entities/by-name/component/default/test')
          .set('Authorization', mockCredentials.user.header());
        expect(response.status).toBe(200);
        expect(response.body.status).toMatchObject({
          'test-source': {
            ok: true,
            message: 'All systems go',
          },
        });
      }, 10000);
    },
    60000,
  );
});
