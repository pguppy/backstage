import { {{PluginId}}Api, {{pluginVar}}ApiRef } from '../api';
import { GetMetricsResponse, GetOrgMetricsResponse } from '../types';

/**
 * Mock implementation of the {{PluginId}} API for testing.
 *
 * @public
 */
export class Mock{{PluginId}}Client implements {{PluginId}}Api {
  async getEntityMetrics(): Promise<GetMetricsResponse> {
    return { success: true };
  }
  async getOrgMetrics(): Promise<GetOrgMetricsResponse> {
    return { success: true, items: [] };
  }
}

/**
 * Test utilities for the {{pluginId}} plugin.
 *
 * @public
 */
export const {{pluginVar}}TestUtils = {
  /** Creates a mock API client */
  createMockClient(): {{PluginId}}Api {
    return new Mock{{PluginId}}Client();
  },
};
