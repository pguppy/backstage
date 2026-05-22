import { createPlugin, createApiFactory, createRoutableExtension, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import { copilotApiRef } from '@backstage/plugin-github-copilot-react';
import { rootRouteRef } from './routes';
import { DefaultCopilotClient } from './apis/DefaultClient';

export const copilotPlugin = createPlugin({
  id: 'github-copilot',
  routes: { root: rootRouteRef },
  apis: [createApiFactory({ api: copilotApiRef, deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef }, factory: ({ discoveryApi, fetchApi }) => new DefaultCopilotClient({ discoveryApi, fetchApi }) })],
});

export const CopilotPage = copilotPlugin.provide(createRoutableExtension({ name: 'CopilotPage', component: () => import('./components/DashboardPage').then(m => ({ default: m.DashboardPage })), mountPoint: rootRouteRef }));
