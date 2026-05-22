import {
  coreServices,
  createBackendPlugin,
} from "@backstage/backend-plugin-api";
import { createRouter } from "./router";
import { createSyncTaskRunner } from "./service/SchedulerService";

/**
 * GitHub Copilot Metrics backend plugin.
 *
 * Provides an OpenAPI-validated health check and optional scheduled sync.
 * @public
 */
export const githubCopilotPlugin = createBackendPlugin({
  pluginId: "github-copilot",
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

export default githubCopilotPlugin;
