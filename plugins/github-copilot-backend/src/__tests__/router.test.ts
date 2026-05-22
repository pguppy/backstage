import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import express from 'express';
import request from 'supertest';
import { createRouter } from '../router';

describe('createRouter', () => {
  let app: express.Express;

  beforeAll(async () => {
    const router = await createRouter({
      config: ConfigReader.fromConfigs([
        {
          context: 'test',
          data: {
            copilot: { enterprise: 'test-enterprise' },
            integrations: {
              github: [{ host: 'github.com', token: 'test-token' }],
            },
          },
        },
      ]),
      logger: mockServices.logger.mock(),
    });

    app = express().use(router);
  });

  it('GET /metrics/freshness returns 200', async () => {
    const res = await request(app).get('/metrics/freshness');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('latestAvailableDate');
  });
});
