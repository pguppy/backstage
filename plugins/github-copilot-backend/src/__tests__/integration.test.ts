import { mockServices, startTestBackend } from '@backstage/backend-test-utils';
import request from 'supertest';
import { githubCopilotPlugin } from '../plugin';

describe('githubCopilotPlugin', () => {
  it('should serve metrics freshness endpoint', async () => {
    const { server } = await startTestBackend({
      features: [
        githubCopilotPlugin,
        mockServices.rootConfig.factory({
          data: {
            app: { baseUrl: 'http://localhost:7007' },
            copilot: { enterprise: 'test-enterprise' },
            integrations: {
              github: [{ host: 'github.com', token: 'test-token' }],
            },
          },
        }),
      ],
    });

    const res = await request(server).get(
      '/api/github-copilot/metrics/freshness',
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      latestAvailableDate: expect.any(String),
      windowStart: expect.any(String),
    });
  });
});
