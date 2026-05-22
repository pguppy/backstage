import {
  createFrontendPlugin,
} from '@backstage/frontend-plugin-api';
import {
  createApiExtension,
  createApiFactory,
  discoveryApiRef,
  fetchApiRef,
  configApiRef,
} from '@backstage/frontend-plugin-api';
import { createPageExtension } from '@backstage/frontend-plugin-api';
import { createEntityContentExtension } from '@backstage/plugin-catalog-react/alpha';
import { {{pluginVar}}ApiRef } from './api';

/**
 * {{PluginId}} frontend plugin.
 *
 * @public
 */
export const {{pluginVar}}Plugin = createFrontendPlugin({
  id: '{{pluginId}}',
  extensions: [
    // API client for backend communication
    // See skill: backstage-client-api
    createApiExtension({
      api: {{pluginVar}}ApiRef,
      factory: createApiFactory({
        api: {{pluginVar}}ApiRef,
        deps: {
          discoveryApi: discoveryApiRef,
          fetchApi: fetchApiRef,
          configApi: configApiRef,
        },
        factory({ discoveryApi, fetchApi, configApi }) {
          // TODO: Implement the API client that calls the backend
          return {
            async getData(entityRef: string) {
              const baseUrl = await discoveryApi.getBaseUrl('{{pluginId}}');
              const response = await fetchApi.fetch(
                `${baseUrl}/data/${entityRef}`,
              );
              return response.json();
            },
            async submitData(entityRef: string, payload: unknown) {
              const baseUrl = await discoveryApi.getBaseUrl('{{pluginId}}');
              const response = await fetchApi.fetch(
                `${baseUrl}/data`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ entityRef, payload }),
                },
              );
              return response.json();
            },
          };
        },
      }),
    }),

    // Entity page card (shows on catalog entity pages)
    // See skill: backstage-catalog-system
    createEntityContentExtension({
      name: '{{pluginId}}-card',
      title: '{{PluginId}}',
      component: () => import('./components/{{PluginId}}Card').then(m => m.{{PluginId}}Card),
    }),

    // Standalone page
    // See skill: backstage-frontend-services
    createPageExtension({
      name: '{{pluginId}}-page',
      path: '/{{pluginId}}',
      component: () => import('./components/{{PluginId}}Page').then(m => m.{{PluginId}}Page),
    }),
  ],
});
