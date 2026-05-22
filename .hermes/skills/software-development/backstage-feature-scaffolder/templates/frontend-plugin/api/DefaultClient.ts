import {
  DiscoveryApi,
  FetchApi,
  ConfigApi,
} from '@backstage/core-plugin-api';
import {
  {{PluginId}}Api,
  GetMetricsResponse,
  GetOrgMetricsResponse,
} from '@backstage-community/plugin-{{pluginId}}-react';

/**
 * Default implementation of the {{PluginId}} API client.
 *
 * @public
 */
export class Default{{PluginId}}Client implements {{PluginId}}Api {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: {
    discoveryApi: DiscoveryApi;
    fetchApi: FetchApi;
    configApi: ConfigApi;
  }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async getBaseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('{{pluginId}}');
  }

  async getEntityMetrics(
    kind: string,
    namespace: string,
    name: string,
  ): Promise<GetMetricsResponse> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/metrics/${kind}/${namespace}/${name}`,
    );
    return response.json();
  }

  async getOrgMetrics(org: string): Promise<GetOrgMetricsResponse> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/metrics/org/${org}`,
    );
    return response.json();
  }
}
