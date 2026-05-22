import { createApiRef } from '@backstage/core-plugin-api';
import type { HealthResponse } from './schema/openapi/generated';

/**
 * API surface for the {{PLUGIN_NAME}} plugin.
 * Each method maps to a backend endpoint defined in the OpenAPI spec.
 * @public
 */
export interface {{PLUGIN_ID.capitalize}}Api {
  /** GET /health — Checks plugin health status. */
  getHealth(): Promise<HealthResponse>;
}

export const {{PLUGIN_ID.camelcase}}ApiRef = createApiRef<{{PLUGIN_ID.capitalize}}Api>({
  id: 'plugin.{{PLUGIN_ID}}.service',
});
