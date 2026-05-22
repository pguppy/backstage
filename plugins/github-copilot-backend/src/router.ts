import { LoggerService, RootConfigService } from "@backstage/backend-plugin-api";
import { GitHubCopilotService } from "./service/GitHubCopilotService";
import { aggregateSummary, toDailyMetrics, toUserMetrics, aggregateTeams, dateRange } from "./service/MetricsAggregator";
import { createOpenApiRouter } from "./schema/openapi/generated";

const DAY_MS = 86_400_000;
const DATA_LAG_DAYS = 3;
const HISTORY_DAYS = 365;

const API = {
  summary: (ent: string) => `/enterprises/${ent}/copilot/metrics/reports/enterprise-28-day/latest`,
  dailyUsers: (ent: string, day: string) => `/enterprises/${ent}/copilot/metrics/reports/users-1-day?day=${day}`,
  userTeams: (ent: string, day: string) => `/enterprises/${ent}/copilot/metrics/reports/user-teams-1-day?day=${day}`,
} as const;

function resolveEnterprise(q: Record<string, unknown>, d: string): string { return (q.enterprise as string) || d; }
function resolveDateRange(q: Record<string, unknown>): { from: string; to: string } { const from = q.from as string, to = (q.to as string) || from; return { from, to }; }
function freshnessDate(daysAgo: number): string { return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10); }

interface RouterOptions { config: RootConfigService; logger: LoggerService; }

export async function createRouter({ config, logger }: RouterOptions) {
  const token = config.has("integrations.github.0.token") ? config.getString("integrations.github.0.token") : "";
  const enterprise = config.getOptionalString("copilot.enterprise") ?? config.getOptionalString("integrations.github.0.host") ?? "";
  const service = new GitHubCopilotService(token, logger);
  const router = await createOpenApiRouter();
  let lastSync: Date | null = null;

  router.get("/metrics/enterprise/summary", async (req, res) => {
    const ent = resolveEnterprise(req.query, enterprise);
    const records = await service.fetchAndParse(API.summary(ent));
    lastSync = new Date();
    res.json(aggregateSummary(records));
  });

  router.get("/metrics/enterprise/daily", async (req, res) => {
    const ent = resolveEnterprise(req.query, enterprise);
    const { from, to } = resolveDateRange(req.query);
    const records: Record<string, unknown>[] = [];
    for (const day of dateRange(from, to)) records.push(...(await service.fetchAndParse(API.dailyUsers(ent, day))));
    res.json(records.map(toDailyMetrics));
  });

  router.get("/metrics/enterprise/users", async (req, res) => {
    const ent = resolveEnterprise(req.query, enterprise);
    const { from, to } = resolveDateRange(req.query);
    const users: Record<string, unknown>[] = [];
    for (const day of dateRange(from, to)) users.push(...(await service.fetchAndParse(API.dailyUsers(ent, day))));
    res.json(users.map(toUserMetrics));
  });

  router.get("/metrics/enterprise/teams", async (req, res) => {
    const ent = resolveEnterprise(req.query, enterprise);
    const { from, to } = resolveDateRange(req.query);
    const ut: Record<string, unknown>[] = [];
    for (const day of dateRange(from, to)) { try { ut.push(...(await service.fetchAndParse(API.userTeams(ent, day)))); } catch { logger.debug("No team data for day " + day); } }
    res.json(aggregateTeams(ut));
  });

  router.get("/metrics/freshness", (_req, res) => {
    res.json({ lastSyncDate: lastSync?.toISOString() ?? null, latestAvailableDate: freshnessDate(DATA_LAG_DAYS), windowStart: freshnessDate(HISTORY_DAYS), daysAvailable: 0 });
  });
  return router;
}
