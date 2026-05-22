import { useApi } from '@backstage/frontend-plugin-api';
// TODO: replace with the actual API ref from your frontend plugin
// import { {{pluginVar}}ApiRef } from '@backstage-community/plugin-{{pluginId}}';

/**
 * Hook for fetching {{pluginId}} data.
 *
 * TODO: After setting up the API client, replace this with a proper
 * TanStack Query hook using useQuery.
 * See skill: backstage-client-api for the full pattern.
 */
export function use{{PluginId}}Data(entityRef: string) {
  // TODO: Replace with real implementation
  return {
    data: null,
    loading: false,
    error: null,
  };
}
