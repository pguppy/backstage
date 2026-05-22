import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import { {{pluginIdCap}}_READ_PERMISSION } from '@backstage-community/plugin-{{pluginId}}-common';

/**
 * {{PluginId}} backend plugin.
 *
 * @public
 */
export const {{pluginVar}}Plugin = createBackendPlugin({
  pluginId: '{{pluginId}}',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        database: coreServices.database,
        config: coreServices.rootConfig,
        permissions: coreServices.permissions,
        httpAuth: coreServices.httpAuth,
        scheduler: coreServices.scheduler,
        // Add more deps as needed:
        // auth: coreServices.auth,
        // discovery: coreServices.discovery,
        // urlReader: coreServices.urlReader,
        // cache: coreServices.cache,
      },
      async init({
        httpRouter,
        logger,
        database,
        config,
        permissions,
        httpAuth,
        scheduler,
      }) {
        const db = await database.getClient();

        // TODO: Run migrations if needed
        // await applyMigrations(db);

        const router = await createRouter({
          db,
          logger,
          config,
          permissions,
          httpAuth,
          // pass additional services as needed
        });

        // Register permissions
        // See skill: backstage-auth-permissions
        // permissions.addPermission({
        //   name: {{pluginIdCap}}_READ_PERMISSION,
        //   attributes: { action: 'read' },
        // });

        httpRouter.use(router);

        // Schedule background tasks
        // See skill: backstage-core-services (scheduler)
        // scheduler.scheduleTask({
        //   id: '{{pluginId}}-cleanup',
        //   frequency: { hours: 1 },
        //   timeout: { minutes: 5 },
        //   fn: async () => { /* cleanup */ },
        // });

        logger.info('{{PluginId}} backend plugin initialized');
      },
    });
  },
});
