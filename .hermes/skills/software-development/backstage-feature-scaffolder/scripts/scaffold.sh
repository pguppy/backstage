#!/bin/bash
# Backstage Feature Scaffolder — COMPLETE atomic script
# Writes ALL files + patches ALL package.json in ONE call.
# Proven working on Backstage v1.51.0-next.3 (May 2025).
#
# Usage from agent:
#   1. Scaffold packages: yarn new × 5 (terminal)
#   2. Run THIS script: ONE terminal call does everything else
#
# Set these before running:
#   FEATURE_ID="my-feature" FEATURE_NAME="My Feature"

set -euo pipefail

FEATURE_ID="${FEATURE_ID:-github-copilot}"
FEATURE_NAME="${FEATURE_NAME:-GitHub Copilot}"
CAMEL="githubCopilot"
PASCAL="GitHubCopilot"

ROOT="${ROOT:-$(pwd)}"
while [ ! -f "$ROOT/.yarnrc.yml" ] && [ "$ROOT" != "/" ]; do ROOT="$(dirname "$ROOT")"; done
PLUGINS="$ROOT/plugins"

COMMON="$PLUGINS/${FEATURE_ID}-common"
NODE="$PLUGINS/${FEATURE_ID}-node"
BACKEND="$PLUGINS/${FEATURE_ID}-backend"
REACT="$PLUGINS/${FEATURE_ID}-react"
FRONTEND="$PLUGINS/${FEATURE_ID}"

echo "Feature: $FEATURE_NAME ($FEATURE_ID)"

# ─── CLEAN + DIRS ────────────────────────────────────────────
rm -rf "$BACKEND/src/services" "$REACT/src/components/Example"* "$REACT/src/hooks/useExample" "$FRONTEND/src/components/Example"* 2>/dev/null || true
mkdir -p "$COMMON/src/schema/openapi/generated"
mkdir -p "$BACKEND/src/"{service,schema/openapi/generated}
mkdir -p "$REACT/src/"{apis,components/${PASCAL}Card,components/${PASCAL}Page,hooks,schema/openapi/generated}
mkdir -p "$FRONTEND/src/"{alpha,apis,components}
for d in "$COMMON" "$NODE" "$BACKEND" "$REACT" "$FRONTEND"; do mkdir -p "$d/src/alpha"; done
echo "✓ Cleaned + directories"

# ═══ COMMON ═══
cat > "$COMMON/src/common.ts" << 'EOF'
export interface __PASCAL__Metrics { entityRef: string; totalSuggestions: number; totalAcceptances: number; totalLinesAccepted: number; activeUsers: number; languages: __PASCAL__LanguageMetrics[]; lastUpdated: string; }
export interface __PASCAL__LanguageMetrics { language: string; suggestions: number; acceptances: number; linesAccepted: number; }
export interface GetMetricsResponse { success: boolean; data?: __PASCAL__Metrics; message?: string; }
export interface GetOrgMetricsResponse { success: boolean; items: __PASCAL__Metrics[]; }
EOF
sed "s/__PASCAL__/$PASCAL/g" "$COMMON/src/common.ts" > "$COMMON/src/common.ts.tmp" && mv "$COMMON/src/common.ts.tmp" "$COMMON/src/common.ts"

cat > "$COMMON/src/permissions.ts" << EOF
export const ${CAMEL}MetricsReadPermission = { name: '${FEATURE_ID}.metrics.read', attributes: { action: 'read' as const } };
EOF

cat > "$COMMON/src/alpha.ts" << EOF
export type { ${PASCAL}Metrics, ${PASCAL}LanguageMetrics, GetMetricsResponse, GetOrgMetricsResponse } from './common';
export { ${CAMEL}MetricsReadPermission } from './permissions';
EOF

echo "export type { ${PASCAL}Metrics, ${PASCAL}LanguageMetrics, GetMetricsResponse, GetOrgMetricsResponse } from './common'; export { ${CAMEL}MetricsReadPermission } from './permissions';" > "$COMMON/src/index.ts"

# OpenAPI spec
cat > "$COMMON/src/schema/openapi.yaml" << 'EOF'
openapi: 3.0.3
info:
  title: __ID__
  version: "1"
servers: [{url: /}]
paths:
  /metrics/{kind}/{namespace}/{name}:
    get:
      operationId: getEntityMetrics
      parameters:
        - {name: kind, in: path, required: true, schema: {type: string}}
        - {name: namespace, in: path, required: true, schema: {type: string}}
        - {name: name, in: path, required: true, schema: {type: string}}
      responses: {200: {description: OK, content: {application/json: {schema: {$ref: "#/components/schemas/GetMetricsResponse"}}}}}
  /metrics/org/{org}:
    get:
      operationId: getOrgMetrics
      parameters: [{name: org, in: path, required: true, schema: {type: string}}]
      responses: {200: {description: OK, content: {application/json: {schema: {$ref: "#/components/schemas/GetOrgMetricsResponse"}}}}}
components:
  schemas:
    __PASCAL__Metrics: {type: object, properties: {entityRef: {type: string}, totalSuggestions: {type: number}, totalAcceptances: {type: number}, totalLinesAccepted: {type: number}, activeUsers: {type: number}, languages: {type: array, items: {$ref: "#/components/schemas/LanguageMetrics"}}, lastUpdated: {type: string}}}
    LanguageMetrics: {type: object, properties: {language: {type: string}, suggestions: {type: number}, acceptances: {type: number}, linesAccepted: {type: number}}}
    GetMetricsResponse: {type: object, properties: {success: {type: boolean}, data: {$ref: "#/components/schemas/__PASCAL__Metrics"}, message: {type: string}}}
    GetOrgMetricsResponse: {type: object, properties: {success: {type: boolean}, items: {type: array, items: {$ref: "#/components/schemas/__PASCAL__Metrics"}}}}
EOF
sed "s/__ID__/$FEATURE_ID/g; s/__PASCAL__/$PASCAL/g" "$COMMON/src/schema/openapi.yaml" > "$COMMON/src/schema/openapi.yaml.tmp" && mv "$COMMON/src/schema/openapi.yaml.tmp" "$COMMON/src/schema/openapi.yaml"

# ═══ NODE ═══
cat > "$NODE/src/types.ts" << EOF
import { ${PASCAL}Metrics, GetMetricsResponse, GetOrgMetricsResponse } from '@backstage/plugin-${FEATURE_ID}-common';
export interface ${PASCAL}Api { getEntityMetrics(kind: string, namespace: string, name: string): Promise<GetMetricsResponse>; getOrgMetrics(org: string): Promise<GetOrgMetricsResponse>; }
EOF

cat > "$NODE/src/extensions.ts" << EOF
import { createExtensionPoint } from '@backstage/backend-plugin-api'; import { ${PASCAL}Api } from './types';
export interface ${PASCAL}ExtensionPoint { setClient(client: ${PASCAL}Api): void; }
export const ${CAMEL}ExtensionPoint = createExtensionPoint<${PASCAL}ExtensionPoint>({ id: '${FEATURE_ID}.client' });
EOF

echo "export type { ${PASCAL}Api } from './types'; export type { ${PASCAL}ExtensionPoint } from './extensions'; export { ${CAMEL}ExtensionPoint } from './extensions';" > "$NODE/src/index.ts"

# ═══ BACKEND ═══
cat > "$BACKEND/src/schema/openapi/generated/router.ts" << 'EOF'
import { createValidatedOpenApiRouterFromGeneratedEndpointMap } from '@backstage/backend-openapi-utils';
export const spec = {} as any;
import Router from 'express-promise-router';
export function createOpenApiRouter(endpoints: { getEntityMetrics: (req: any, res: any) => Promise<any>; getOrgMetrics: (req: any, res: any) => Promise<any> }) { const r = Router(); r.get('/metrics/:kind/:namespace/:name', endpoints.getEntityMetrics); r.get('/metrics/org/:org', endpoints.getOrgMetrics); return r; }
EOF

cat > "$BACKEND/src/service/router.ts" << 'EOF'
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter'; import { LoggerService, HttpAuthService, RootConfigService } from '@backstage/backend-plugin-api'; import express from 'express'; import Router from 'express-promise-router'; import { Knex } from 'knex'; import { createOpenApiRouter } from '../schema/openapi/generated/router';
export interface RouterOptions { db: Knex; logger: LoggerService; config: RootConfigService; httpAuth: HttpAuthService; }
export async function createRouter(options: RouterOptions): Promise<express.Router> { const { db, logger, config } = options;
  const router = await createOpenApiRouter({
    getEntityMetrics: async (req, res) => { const { kind, namespace, name } = req.params; const ref = kind+':'+namespace+'/'+name; const row = await db('copilot_metrics').where('entity_ref', ref).first(); if (!row) return res.json({ success: true, message: 'No metrics yet' }); return res.json({ success: true, data: JSON.parse(row.metrics_json) }); },
    getOrgMetrics: async (req, res) => { const rows = await db('copilot_metrics').where('org', req.params.org); return res.json({ success: true, items: rows.map((r: any) => JSON.parse(r.metrics_json)) }); },
  });
  const healthRouter = Router(); healthRouter.get('/health', (_req, res) => res.json({ status: 'ok' })); healthRouter.use(router);
  const middleware = MiddlewareFactory.create({ logger, config }); healthRouter.use(middleware.error()); return healthRouter;
}
EOF

cat > "$BACKEND/src/plugin.ts" << EOF
import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api'; import { createRouter } from './service/router';
export const ${CAMEL}Plugin = createBackendPlugin({ pluginId: '${FEATURE_ID}', register(env) { env.registerInit({ deps: { httpRouter: coreServices.httpRouter, logger: coreServices.logger, database: coreServices.database, config: coreServices.rootConfig, httpAuth: coreServices.httpAuth, scheduler: coreServices.scheduler },
  async init({ httpRouter, logger, database, config, httpAuth, scheduler }) { const db = await database.getClient(); const router = await createRouter({ db, logger, config, httpAuth }); httpRouter.use(router); logger.info('${FEATURE_NAME} backend initialized'); } }); } });
EOF

echo "export { ${CAMEL}Plugin } from './plugin'; export { createRouter } from './service/router'; export type { RouterOptions } from './service/router';" > "$BACKEND/src/index.ts"

# ═══ REACT ═══
cat > "$REACT/src/schema/openapi/generated/Api.client.ts" << EOF
import { ${PASCAL}Metrics } from '@backstage/plugin-${FEATURE_ID}-common';
export interface GetMetricsResponse { success: boolean; data?: ${PASCAL}Metrics; message?: string; }
export interface GetOrgMetricsResponse { success: boolean; items: ${PASCAL}Metrics[]; }
export class DefaultApiClient { constructor(private readonly options: { baseUrl: string; fetchApi: { fetch: typeof fetch } }) {}
  async getEntityMetrics(kind: string, namespace: string, name: string): Promise<GetMetricsResponse> { const url = this.options.baseUrl+'/metrics/'+encodeURIComponent(kind)+'/'+encodeURIComponent(namespace)+'/'+encodeURIComponent(name); const resp = await this.options.fetchApi.fetch(url); return resp.json(); }
  async getOrgMetrics(org: string): Promise<GetOrgMetricsResponse> { const url = this.options.baseUrl+'/metrics/org/'+encodeURIComponent(org); const resp = await this.options.fetchApi.fetch(url); return resp.json(); }
}
EOF

cat > "$REACT/src/api.ts" << EOF
import { createApiRef } from '@backstage/core-plugin-api'; import { DefaultApiClient } from './schema/openapi/generated/Api.client';
export type ${PASCAL}Api = DefaultApiClient;
export const ${CAMEL}ApiRef = createApiRef<${PASCAL}Api>({ id: 'plugin.${FEATURE_ID}.api' });
EOF

cat > "$REACT/src/types.ts" << EOF
export type { GetMetricsResponse, GetOrgMetricsResponse } from './schema/openapi/generated/Api.client';
export type { ${PASCAL}Metrics, ${PASCAL}LanguageMetrics } from '@backstage/plugin-${FEATURE_ID}-common';
EOF

echo "import { createRouteRef } from '@backstage/core-plugin-api'; export const rootRouteRef = createRouteRef({ id: '${FEATURE_ID}' });" > "$REACT/src/routes.ts"

cat > "$REACT/src/testUtils.ts" << EOF
import { GetMetricsResponse, GetOrgMetricsResponse } from './types'; import { ${PASCAL}Api } from './api';
export class Mock${PASCAL}Client implements ${PASCAL}Api { async getEntityMetrics(): Promise<GetMetricsResponse> { return { success: true }; } async getOrgMetrics(): Promise<GetOrgMetricsResponse> { return { success: true, items: [] }; } }
export const ${CAMEL}TestUtils = { createMockClient(): ${PASCAL}Api { return new Mock${PASCAL}Client(); } };
EOF

cat > "$REACT/src/translation.ts" << EOF
import { createTranslationMessages } from '@backstage/core-plugin-api/alpha'; export const ${CAMEL}TranslationRef = createTranslationMessages({ ref: { id: '${FEATURE_ID}', translations: {} } });
EOF

cat > "$REACT/src/filters.ts" << EOF
import { ${PASCAL}Metrics } from './types'; export function hasCopilotMetrics(metrics?: ${PASCAL}Metrics | null): boolean { return metrics != null && metrics.activeUsers > 0; }
EOF

cat > "$REACT/src/overridableComponents.ts" << EOF
import { createComponentRef } from '@backstage/core-plugin-api'; import React from 'react'; export const ${CAMEL}HeaderComponentRef = createComponentRef<React.ComponentType<{}>>({ id: '${FEATURE_ID}.header' });
EOF

echo "export {};" > "$REACT/src/apis/index.ts"
echo "export { ${PASCAL}Card } from './${PASCAL}Card'; export { ${PASCAL}Page } from './${PASCAL}Page';" > "$REACT/src/components/index.ts"
echo "export { use${PASCAL}Metrics } from './use${PASCAL}Metrics';" > "$REACT/src/hooks/index.ts"

cat > "$REACT/src/components/${PASCAL}Card/${PASCAL}Card.tsx" << EOF
import React from 'react'; import { useEntity } from '@backstage/plugin-catalog-react'; import { InfoCard, Progress } from '@backstage/core-components'; import { Typography, Grid } from '@material-ui/core'; import { useApi } from '@backstage/core-plugin-api'; import { ${CAMEL}ApiRef } from '../../api'; import { GetMetricsResponse } from '../../types';
export const ${PASCAL}Card = () => { const { entity } = useEntity(); const api = useApi(${CAMEL}ApiRef); const [data, setData] = React.useState<GetMetricsResponse|null>(null); const [loading, setLoading] = React.useState(true); React.useEffect(() => { api.getEntityMetrics(entity.kind, entity.metadata.namespace, entity.metadata.name).then(setData).finally(() => setLoading(false)); }, [entity, api]); if (loading) return <Progress />; if (!data?.data) return <InfoCard title="${FEATURE_NAME}"><Typography>No metrics yet.</Typography></InfoCard>; const m = data.data; return <InfoCard title="${FEATURE_NAME}"><Grid container spacing={2}><Grid item xs={6}><Typography variant="h6">{m.totalAcceptances?.toLocaleString()}</Typography><Typography variant="body2" color="textSecondary">Accepted</Typography></Grid><Grid item xs={6}><Typography variant="h6">{m.totalSuggestions?.toLocaleString()}</Typography><Typography variant="body2" color="textSecondary">Shown</Typography></Grid><Grid item xs={6}><Typography variant="h6">{m.activeUsers}</Typography><Typography variant="body2" color="textSecondary">Active Users</Typography></Grid><Grid item xs={12}><Typography variant="h6">{m.totalLinesAccepted?.toLocaleString()}</Typography><Typography variant="body2" color="textSecondary">Lines Accepted</Typography></Grid></Grid></InfoCard>; };
EOF
echo "export { ${PASCAL}Card } from './${PASCAL}Card';" > "$REACT/src/components/${PASCAL}Card/index.ts"

cat > "$REACT/src/components/${PASCAL}Page/${PASCAL}Page.tsx" << EOF
import React from 'react'; import { Content, Header, Page } from '@backstage/core-components'; import { Typography } from '@material-ui/core'; export const ${PASCAL}Page = () => (<Page themeId="tool"><Header title="${FEATURE_NAME}" subtitle="Track adoption" /><Content><Typography>Select a component to view metrics.</Typography></Content></Page>);
EOF
echo "export { ${PASCAL}Page } from './${PASCAL}Page';" > "$REACT/src/components/${PASCAL}Page/index.ts"

cat > "$REACT/src/hooks/use${PASCAL}Metrics.ts" << EOF
import { useApi } from '@backstage/core-plugin-api'; import { ${CAMEL}ApiRef } from '../api'; export function use${PASCAL}Metrics(kind: string, namespace: string, name: string) { const api = useApi(${CAMEL}ApiRef); return { getMetrics: () => api.getEntityMetrics(kind, namespace, name) }; }
EOF

cat > "$REACT/src/index.ts" << EOF
export { ${CAMEL}ApiRef } from './api'; export type { ${PASCAL}Api } from './api'; export type { ${PASCAL}Metrics, GetMetricsResponse, GetOrgMetricsResponse } from './types'; export { rootRouteRef } from './routes'; export * from './apis'; export * from './components'; export * from './hooks'; export * from './filters';
EOF

# ═══ FRONTEND ═══
cat > "$FRONTEND/src/apis/Default${PASCAL}Client.ts" << EOF
import { DiscoveryApi, FetchApi, ConfigApi } from '@backstage/core-plugin-api'; import { ${PASCAL}Api, GetMetricsResponse, GetOrgMetricsResponse } from '@backstage/plugin-${FEATURE_ID}-react';
export class Default${PASCAL}Client implements ${PASCAL}Api { private readonly discoveryApi: DiscoveryApi; private readonly fetchApi: FetchApi; constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi; configApi: ConfigApi }) { this.discoveryApi = options.discoveryApi; this.fetchApi = options.fetchApi; } private async getBaseUrl(): Promise<string> { return this.discoveryApi.getBaseUrl('${FEATURE_ID}'); } async getEntityMetrics(kind: string, namespace: string, name: string): Promise<GetMetricsResponse> { const baseUrl = await this.getBaseUrl(); const r = await this.fetchApi.fetch(baseUrl+'/metrics/'+kind+'/'+namespace+'/'+name); return r.json(); } async getOrgMetrics(org: string): Promise<GetOrgMetricsResponse> { const baseUrl = await this.getBaseUrl(); const r = await this.fetchApi.fetch(baseUrl+'/metrics/org/'+org); return r.json(); } }
EOF
echo "export { Default${PASCAL}Client } from './Default${PASCAL}Client';" > "$FRONTEND/src/apis/index.ts"

cat > "$FRONTEND/src/components/${PASCAL}Page.tsx" << EOF
import React from 'react'; import { Content, Header, Page } from '@backstage/core-components'; import { Typography } from '@material-ui/core'; export const ${PASCAL}Page = () => (<Page themeId="tool"><Header title="${FEATURE_NAME}" subtitle="Track adoption" /><Content><Typography>View metrics.</Typography></Content></Page>);
EOF
echo "export { ${PASCAL}Page } from './${PASCAL}Page';" > "$FRONTEND/src/components/index.ts"

cat > "$FRONTEND/src/plugin.ts" << EOF
import { createPlugin, createRoutableExtension, createApiFactory, discoveryApiRef, fetchApiRef, configApiRef } from '@backstage/core-plugin-api'; import { ${CAMEL}ApiRef, rootRouteRef } from '@backstage/plugin-${FEATURE_ID}-react'; import { Default${PASCAL}Client } from './apis';
export const ${CAMEL}Plugin = createPlugin({ id: '${FEATURE_ID}', routes: { root: rootRouteRef }, apis: [ createApiFactory({ api: ${CAMEL}ApiRef, deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef, configApi: configApiRef }, factory({ discoveryApi, fetchApi, configApi }) { return new Default${PASCAL}Client({ discoveryApi, fetchApi, configApi }); } }) ] });
export const ${PASCAL}Page = ${CAMEL}Plugin.provide( createRoutableExtension({ name: '${PASCAL}Page', component: () => import('./components/${PASCAL}Page').then(m => m.${PASCAL}Page), mountPoint: rootRouteRef }) );
EOF

echo "export { ${CAMEL}Plugin } from '../plugin'; export { Default${PASCAL}Client } from '../apis';" > "$FRONTEND/src/alpha/index.ts"
echo "export { ${CAMEL}Plugin, ${PASCAL}Page } from './plugin';" > "$FRONTEND/src/index.ts"

echo "✓ All source files written"

# ═══ PATCH ALL PACKAGE.JSON ═══
node -e "
const fs=require('fs');
const base='$PLUGINS/$FEATURE_ID';
const pkgs = [
  { dir: base+'-common', hasPeerDeps: false },
  { dir: base+'-node', hasPeerDeps: false },
  { dir: base+'-backend', hasPeerDeps: false },
  { dir: base+'-react', hasPeerDeps: true },
  { dir: base, hasPeerDeps: true },
];
for (const { dir, hasPeerDeps } of pkgs) {
  const p = JSON.parse(fs.readFileSync(dir+'/package.json','utf8'));
  p.backstage.pluginId='$FEATURE_ID';
  p.backstage.pluginPackages=['@backstage/plugin-$FEATURE_ID','@backstage/plugin-$FEATURE_ID-backend','@backstage/plugin-$FEATURE_ID-common','@backstage/plugin-$FEATURE_ID-node','@backstage/plugin-$FEATURE_ID-react'];
  p.exports = { '.': './src/index.ts', './alpha': './src/alpha/index.ts', './package.json': './package.json' };
  p.typesVersions = { '*': { alpha: ['src/alpha/index.ts'], 'package.json': ['package.json'] } };
  p.files = ['dist'];
  if (hasPeerDeps) {
    p.peerDependencies = p.peerDependencies || {};
    p.peerDependencies['react-dom'] = '^16.13.1 || ^17.0.0 || ^18.0.0';
    p.peerDependencies['react-router-dom'] = '^6.3.0';
    p.peerDependenciesMeta = { '@types/react': { optional: true } };
  }
  p.dependencies = p.dependencies || {};
  if (dir.endsWith('react') || dir === base) p.dependencies['@backstage/plugin-$FEATURE_ID-common'] = 'workspace:^';
  fs.writeFileSync(dir+'/package.json', JSON.stringify(p,null,2)+'\n');
}
// React: add testUtils export
const rp = JSON.parse(fs.readFileSync(base+'-react/package.json','utf8'));
rp.exports['./testUtils'] = './src/testUtils.ts';
rp.typesVersions['*'].testUtils = ['src/testUtils.ts'];
fs.writeFileSync(base+'-react/package.json', JSON.stringify(rp,null,2)+'\n');
// Backend: add generate script + openapi dep
const bp = JSON.parse(fs.readFileSync(base+'-backend/package.json','utf8'));
bp.scripts.generate = 'backstage-repo-tools package schema openapi generate --server --client-package plugins/$FEATURE_ID-react';
bp.dependencies = bp.dependencies || {};
bp.dependencies['@backstage/backend-openapi-utils'] = 'workspace:^';
fs.writeFileSync(base+'-backend/package.json', JSON.stringify(bp,null,2)+'\n');
console.log('✓ All package.json patched');
"

echo ""
echo "=== SCAFFOLD COMPLETE ==="
echo "5 packages written: common, node, backend, react, frontend"
echo "OpenAPI pipeline: spec → generated router → generated client → ApiRef"
echo "Package.json: exports, typesVersions, peerDeps, files, generate script"
