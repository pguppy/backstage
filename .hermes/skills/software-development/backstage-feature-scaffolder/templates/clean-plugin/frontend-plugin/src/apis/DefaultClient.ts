import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { DefaultApiClient, type HealthResponse, type RequestOptions } from '@backstage/plugin-{{PLUGIN_ID}}-react/schema/openapi/generated';
import type { {{PLUGIN_ID.capitalize}}Api } from '@backstage/plugin-{{PLUGIN_ID}}-react';

/**
 * Default implementation of {{PLUGIN_NAME}} API.
 * Wraps the generated DefaultApiClient — each method delegates to the generated client.
 * Custom business logic (transformations, caching, error formatting) goes here.
 * @public
 */
export class Default{{PLUGIN_ID.capitalize}}Client implements {{PLUGIN_ID.capitalize}}Api {
  private readonly client: DefaultApiClient;

  constructor(options: {
    discoveryApi: DiscoveryApi;
    fetchApi: FetchApi;
  }) {
    this.client = new DefaultApiClient({
      discoveryApi: options.discoveryApi,
      fetchApi: options.fetchApi,
    });
  }

  async getHealth(): Promise<HealthResponse> {
    return this.client.getHealth();
  }
}
