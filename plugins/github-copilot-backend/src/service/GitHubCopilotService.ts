import { LoggerService } from '@backstage/backend-plugin-api';

export class GitHubCopilotService {
  private baseUrl = 'https://api.github.com';

  constructor(
    private token: string,
    private logger: LoggerService,
  ) {}

  async fetchAndParse(path: string): Promise<Record<string, unknown>[]> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        Authorization: `Bearer ${this.token}`,
      },
    });
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
    const data = (await resp.json()) as { download_links: string[] };
    const out: Record<string, unknown>[] = [];
    for (const link of data.download_links) {
      const ndjson = await fetch(link);
      if (!ndjson.ok) continue;
      const text = await ndjson.text();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            out.push(JSON.parse(trimmed));
          } catch {
            // skip malformed lines
          }
        }
      }
    }
    return out;
  }
}
