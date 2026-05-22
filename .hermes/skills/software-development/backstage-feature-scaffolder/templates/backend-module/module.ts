import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';

/**
 * {{moduleId}} backend module for the {{pluginId}} plugin.
 *
 * @public
 */
export const {{moduleVar}} = createBackendModule({
  pluginId: '{{pluginId}}',
  moduleId: '{{moduleId}}',
  register(reg) {
    reg.registerInit({
      deps: {
        logger: coreServices.logger,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        config: coreServices.rootConfig,
        // Add extension points from target plugin:
        // extensionPoint: someExtensionPointRef,
      },
      async init({ logger, database, scheduler, config }) {
        const db = await database.getClient();

        // TODO: Run module-specific migrations
        // await applyMigrations(db);

        // TODO: Register with target plugin's extension point
        // extensionPoint.addThing(new MyThing({ db, config }));

        // TODO: Schedule tasks
        // scheduler.scheduleTask({
        //   id: '{{pluginId}}-{{moduleId}}-sync',
        //   frequency: { minutes: 5 },
        //   timeout: { minutes: 1 },
        //   fn: async () => { /* sync logic */ },
        // });

        logger.info('{{moduleId}} module for {{pluginId}} initialized');
      },
    });
  },
});
