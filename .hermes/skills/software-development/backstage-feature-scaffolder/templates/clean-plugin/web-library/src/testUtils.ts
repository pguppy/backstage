import type { {{plugin_id}}Api } from './api';

export class Mock{{plugin_id}}Client implements {{plugin_id}}Api {
  async getHealth(): Promise<{ status: string }> {
    return { status: 'ok' };
  }
}
