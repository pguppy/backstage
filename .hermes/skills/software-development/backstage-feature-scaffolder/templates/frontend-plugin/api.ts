import { createApiRef } from '@backstage/frontend-plugin-api';

/**
 * API client interface for the {{pluginId}} plugin.
 *
 * @public
 */
export interface {{PluginId}}Api {
  getData(entityRef: string): Promise<{ success: boolean; data: unknown }>;
  submitData(entityRef: string, payload: unknown): Promise<{ success: boolean }>;
}

/**
 * API ref for the {{pluginId}} client.
 *
 * @public
 */
export const {{pluginVar}}ApiRef = createApiRef<{{PluginId}}Api>({
  id: 'plugin.{{pluginId}}.api',
});
