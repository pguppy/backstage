import {
  createPlugin,
  createRoutableExtension,
  createApiFactory,
  discoveryApiRef,
  fetchApiRef,
  configApiRef,
} from '@backstage/core-plugin-api';
import {
  {{pluginVar}}ApiRef,
  rootRouteRef,
} from '@backstage-community/plugin-{{pluginId}}-react';
import { Default{{PluginId}}Client } from './api/Default{{PluginId}}Client';

/**
 * {{name}} frontend plugin.
 *
 * @public
 */
export const {{pluginVar}}Plugin = createPlugin({
  id: '{{pluginId}}',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: {{pluginVar}}ApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
        configApi: configApiRef,
      },
      factory({ discoveryApi, fetchApi, configApi }) {
        return new Default{{PluginId}}Client({ discoveryApi, fetchApi, configApi });
      },
    }),
  ],
});

/**
 * {{name}} page extension.
 *
 * @public
 */
export const {{PluginId}}Page = {{pluginVar}}Plugin.provide(
  createRoutableExtension({
    name: '{{PluginId}}Page',
    component: () =>
      import('./components/{{PluginId}}Page').then(m => m.{{PluginId}}Page),
    mountPoint: rootRouteRef,
  }),
);
