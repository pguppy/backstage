import {
  coreServices,
  createBackendPlugin,
} from "@backstage/backend-plugin-api";
import { createRouter } from "./router";
import { createSyncTaskRunner } from "./service/SchedulerService";

/**
 * {{PLUGIN_NAME}} backend plugin.
 *
 * Provides an OpenAPI-validated health check and optional scheduled sync.
 * @public
 */
export const {{PLUGIN_ID.camelcase}}Plugin = createBackendPlugin({
  pluginId: "{{PLUGIN_ID}}",
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        scheduler: coreServices.scheduler,
        lifecycle: coreServices.lifecycle,
      },
      async init({ httpRouter, logger, config, scheduler, lifecycle }) {
        const router = await createRouter({ config, logger });

        httpRouter.addAuthPolicy({
          path: "/health",
          allow: "unauthenticated",
        });

        httpRouter.use(router);

        // Optional: scheduled sync task
        const taskRunner = await createSyncTaskRunner({ scheduler, logger, config });
        lifecycle.addShutdownHook(() => taskRunner.stop?.());
      },
    });
  },
});

export default {{PLUGIN_ID.camelcase}}Plugin;
