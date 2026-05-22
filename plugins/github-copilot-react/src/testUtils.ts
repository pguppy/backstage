import type { github-copilotApi } from './api';

export class Mockgithub-copilotClient implements github-copilotApi {
  async getHealth(): Promise<{ status: string }> {
    return { status: 'ok' };
  }
}
