import {
  LoggerService,
  SchedulerService,
  SchedulerServiceTaskRunner,
} from "@backstage/backend-plugin-api";
import { HumanDuration } from "@backstage/types";

/**
 * Creates a scheduled task runner for periodic data sync.
 * Configure via app-config: {{PLUGIN_ID}}.syncInterval (e.g. "6h", "1d").
 *
 * Usage in plugin.ts:
 *   const runner = await createSyncTaskRunner({ scheduler, logger, config });
 *   runner.run({ id: "sync", fn: async () => { await syncData(); } });
 */
export async function createSyncTaskRunner({
  scheduler,
  logger,
  config,
}: {
  scheduler: SchedulerService;
  logger: LoggerService;
  config: { getOptionalString: (key: string) => string | undefined };
}): Promise<SchedulerServiceTaskRunner> {
  const interval = config.getOptionalString("{{PLUGIN_ID}}.syncInterval") || "1d";
  logger.info(`Configuring sync with interval: ${interval}`);
  return scheduler.createScheduledTaskRunner({
    frequency: interval as HumanDuration,
    timeout: { minutes: 10 },
  });
}
