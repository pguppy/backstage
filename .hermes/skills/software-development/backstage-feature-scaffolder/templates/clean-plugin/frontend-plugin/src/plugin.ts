import {
  createPlugin,
  createApiFactory,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { {{PLUGIN_ID.camelcase}}ApiRef } from '@backstage/plugin-{{PLUGIN_ID}}-react';
import { rootRouteRef } from './routes';
import { Default{{PLUGIN_ID.capitalize}}Client } from './apis/DefaultClient';

/**
 * {{PLUGIN_NAME}} frontend plugin.
 *
 * Provides {{PLUGIN_ID.camelcase}}ApiRef: typed API client for the backend.
 * Uncomment the RoutableExtension below and replace ExamplePage with your page.
 * @public
 */
export const {{PLUGIN_ID.camelcase}}Plugin = createPlugin({
  id: '{{PLUGIN_ID}}',
  routes: { root: rootRouteRef },
  apis: [
    createApiFactory({
      api: {{PLUGIN_ID.camelcase}}ApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new Default{{PLUGIN_ID.capitalize}}Client({ discoveryApi, fetchApi }),
    }),
  ],
});

/** Routable extension — replace ExamplePage with your real page component.
 *  Usage: import('./components/MyPage').then(m => ({ default: m.MyPage }))
 */
// export const {{PLUGIN_ID.camelcase}}Page = {{PLUGIN_ID.camelcase}}Plugin.provide(
//   createRoutableExtension({
//     name: '{{PLUGIN_ID.capitalize}}Page',
//     component: () => import('./components/ExamplePage').then(m => ({ default: m.ExamplePage })),
//     mountPoint: rootRouteRef,
//   }),
// );
