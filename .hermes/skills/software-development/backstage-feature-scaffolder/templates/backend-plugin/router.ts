import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import { LoggerService, HttpAuthService, PermissionsService, RootConfigService } from '@backstage/backend-plugin-api';
import express from 'express';
import Router from 'express-promise-router';
import { Knex } from 'knex';
import { {{PluginId}}Item, {{pluginIdCap}}_READ_PERMISSION } from '@backstage-community/plugin-{{pluginId}}-common';

/**
 * Options for creating the {{pluginId}} router.
 */
export interface RouterOptions {
  db: Knex;
  logger: LoggerService;
  config: RootConfigService;
  permissions: PermissionsService;
  httpAuth: HttpAuthService;
}

/**
 * Creates the {{pluginId}} backend router.
 *
 * @public
 */
export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { db, logger, permissions, httpAuth, config } = options;

  const router = Router();
  router.use(express.json());

  // GET /data/:entityRef — fetch {{pluginId}} data for an entity
  router.get('/data/:kind/:namespace/:name', async (req, res) => {
    const { kind, namespace, name } = req.params;
    const entityRef = `${kind}:${namespace}/${name}`;

    // Auth check — see skill: backstage-auth-permissions
    // const credentials = await httpAuth.credentials(req);
    // await permissions.authorize(
    //   [{ permission: {{pluginIdCap}}_READ_PERMISSION }],
    //   { credentials },
    // );

    // TODO: Query your data source (DB, external API, etc.)
    const items = await db('{{pluginId}}_data')
      .where('entity_ref', entityRef)
      .select('*');

    res.json({ items });
  });

  // POST /data — store {{pluginId}} data
  router.post('/data', async (req, res) => {
    const { entityRef, payload } = req.body;

    if (!entityRef) {
      res.status(400).json({ error: 'entityRef is required' });
      return;
    }

    // TODO: Validate and process payload
    await db('{{pluginId}}_data')
      .insert({
        entity_ref: entityRef,
        payload: JSON.stringify(payload),
      })
      .onConflict('entity_ref')
      .merge();

    res.json({ success: true });
  });

  // Health check
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Apply standard Backstage middleware (error handling, etc.)
  const middleware = MiddlewareFactory.create({ logger, config });
  router.use(middleware.error());

  return router;
}
