import { LoggerService, RootConfigService } from "@backstage/backend-plugin-api";
import { createOpenApiRouter } from "./schema/openapi/generated";

interface RouterOptions {
  config: RootConfigService;
  logger: LoggerService;
}

export async function createRouter({ config, logger }: RouterOptions) {
  // Generated OpenAPI router — validates requests, handles errors.
  const router = await createOpenApiRouter();

  // GET /health
  router.get("/health", (_req, res) => {
    logger.info("Health check requested");
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return router;
}
