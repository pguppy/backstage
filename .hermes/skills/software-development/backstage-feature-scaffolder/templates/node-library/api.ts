import { {{PluginId}}Item } from '@backstage-community/plugin-{{pluginId}}-common';

/**
 * API interface for the {{pluginId}} backend plugin.
 *
 * @public
 */
export interface {{PluginId}}Api {
  /**
   * Process a {{pluginId}} request.
   */
  processRequest(request: {
    entityRef: string;
    payload: Record<string, unknown>;
  }): Promise<{{PluginId}}Item>;
}
