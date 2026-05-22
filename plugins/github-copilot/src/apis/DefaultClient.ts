import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { DefaultApiClient } from '@backstage/plugin-github-copilot-common/schema/openapi/generated';
import type { CopilotApi } from '@backstage/plugin-github-copilot-react';

export class DefaultCopilotClient implements CopilotApi {
  private client: DefaultApiClient;
  constructor(o: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) { this.client = new DefaultApiClient({ discoveryApi: o.discoveryApi, fetchApi: o.fetchApi }); }
  getEnterpriseSummary(e: string) { return this.client.getEnterpriseSummary(e); }
  getEnterpriseDaily(e: string, f: string, t?: string) { return this.client.getEnterpriseDaily(e, f, t); }
  getEnterpriseUsers(e: string, f: string, t?: string) { return this.client.getEnterpriseUsers(e, f, t); }
  getEnterpriseTeams(e: string, f: string, t?: string) { return this.client.getEnterpriseTeams(e, f, t); }
  getDataFreshness(e?: string) { return this.client.getDataFreshness(e); }
}
