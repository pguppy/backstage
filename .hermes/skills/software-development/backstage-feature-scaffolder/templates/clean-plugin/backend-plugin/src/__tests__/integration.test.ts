import { mockServices, startTestBackend } from '@backstage/backend-test-utils';
import request from 'supertest';
import { {{PLUGIN_ID.camelcase}}Plugin } from '../plugin';

describe('{{PLUGIN_ID.camelcase}}Plugin', () => {
  it('should serve health check', async () => {
    const { server } = await startTestBackend({
      features: [
        {{PLUGIN_ID.camelcase}}Plugin,
        mockServices.rootConfig.factory({
          data: {
            app: { baseUrl: 'http://localhost:7007' },
          },
        }),
      ],
    });

    const res = await request(server).get('/api/{{PLUGIN_ID}}/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      timestamp: expect.any(String),
    });
  });
});
