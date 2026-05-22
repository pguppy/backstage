import { createApiRef } from '@backstage/core-plugin-api';
import type { HealthResponse } from './schema/openapi/generated';

/**
 * API surface for the GitHub Copilot Metrics plugin.
 * Each method maps to a backend endpoint defined in the OpenAPI spec.
 * @public
 */
export interface GithubCopilotApi {
  /** GET /health — Checks plugin health status. */
  getHealth(): Promise<HealthResponse>;
}

export const githubCopilotApiRef = createApiRef<GithubCopilotApi>({
  id: 'plugin.github-copilot.service',
});
