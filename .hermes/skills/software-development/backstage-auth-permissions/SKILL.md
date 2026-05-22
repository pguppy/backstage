---
name: backstage-auth-permissions
description: "Use when setting up authentication (21 providers, sign-in resolvers, service-to-service auth) or authorization (permission policies, resource types, conditional rules) in Backstage."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, auth, permissions, authentication, authorization, oauth, sign-in]
    related_skills: [backstage-core-services, backstage-plugin-blueprint, backstage-app-config]
---

# Backstage Auth & Permissions

## Overview

Two-layer security: **Auth** (who you are) with 21 providers, and **Permissions** (what you can do) with policy-based authorization.

## Auth — 21 Providers

`github`, `google`, `okta`, `gitlab`, `microsoft`, `onelogin`, `bitbucket`, `bitbucket-server`, `atlassian`, `vmware-cloud`, `openshift`, `auth0`, `aws-alb`, `azure-easyauth`, `cloudflare-access`, `gcp-iap`, `oauth2`, `oauth2-proxy`, `oidc`, `pinniped`, `guest`

### Installation

```ts
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-github-provider'));
```

### Provider Config

```yaml
auth:
  environment: development
  providers:
    github:
      development:
        clientId: ${GITHUB_CLIENT_ID}
        clientSecret: ${GITHUB_CLIENT_SECRET}
```

### Sign-In Resolver Cookbook

**By email:**
```ts
resolver: async ({ profile: { email } }, ctx) => {
  const { items } = await ctx.catalogApi.getEntities({ filter: { kind: 'User', 'spec.profile.email': email } });
  if (!items.length) throw new Error('User not found');
  return { token: { sub: `user:default/${items[0].metadata.name}` } };
}
```

**By username (GitHub login):**
```ts
resolver: async ({ profile: { displayName } }, ctx) => {
  return { token: { sub: `user:default/${displayName}` } };
}
```

**By email domain (auto-approve company users):**
```ts
resolver: async ({ profile: { email } }, ctx) => {
  if (!email?.endsWith('@my-company.com')) throw new Error('Only company emails allowed');
  const username = email.split('@')[0];
  return { token: { sub: `user:default/${username}` } };
}
```

### Creating a Custom Auth Provider Module

```ts
// auth-backend-module-my-provider/src/module.ts
export const authModuleMyProvider = createBackendModule({
  pluginId: 'auth', moduleId: 'my-provider',
  register(env) {
    env.registerInit({
      deps: { auth: authProvidersExtensionPoint },
      async init({ auth }) {
        auth.registerProvider({
          providerId: 'my-provider',
          factory: createMyProviderFactory(),
        });
      },
    });
  },
});
```

### OAuth Flow Details

1. User clicks "Sign in with X" → redirected to provider
2. Provider authenticates user → redirects back with auth code
3. Backend exchanges code for access token
4. Sign-in resolver maps identity to Backstage User
5. Backstage token issued → stored in browser

### Service-to-Service Auth

```ts
// As your own plugin:
const { token } = await auth.getPluginRequestToken({
  onBehalfOf: await auth.getOwnServiceCredentials(),
  targetPluginId: 'catalog',
});

// On behalf of user:
const { token } = await auth.getPluginRequestToken({
  onBehalfOf: await httpAuth.credentials(req),
  targetPluginId: 'catalog',
});
```

⚠️ Never store tokens. Always call `getPluginRequestToken` fresh per request.

### Cookie-Based (Limited Access)

```ts
http.addAuthPolicy({ path: '/static/:id', allow: 'user-cookie' });
const creds = await httpAuth.credentials(req, { allowLimitedAccess: true });
```

## Permissions

### Define Permissions (in -common)

```ts
import { createPermission } from '@backstage/plugin-permission-common';
export const myReadPermission = createPermission({ name: 'myEntity.read', attributes: { action: 'read' } });
export const myWritePermission = createPermission({ name: 'myEntity.write', attributes: { action: 'create' } });
```

### Register (in backend plugin)

```ts
permissionsRegistry.addResourceType({
  resourceType: 'my-resource',
  permissions: [myReadPermission, myWritePermission],
  rules: [myCustomRule],
});
```

### Authorize in Route Handlers

```ts
const creds = await httpAuth.credentials(req, { allow: ['user'] });
const [decision] = await permissions.authorize(
  [{ permission: myWritePermission }],
  { credentials: creds },
);
if (decision.result !== AuthorizeResult.ALLOW) throw new NotAllowedError();
```

### Custom Rules

```ts
const isOwnerRule = createPermissionRule({
  name: 'IS_OWNER',
  description: 'Allow if user owns the entity',
  resourceType: 'catalog-entity',
  paramsSchema: z.object({}),
  apply(resource) { return resource.metadata.annotations?.['backstage.io/owned-by'] !== undefined; },
  toQuery() { return { key: 'annotations.backstage.io/owned-by', values: ['*'] }; },
});
```

### Policy

```ts
class MyPolicy implements PermissionPolicy {
  async handle(request, user) {
    if (user?.identity.userEntityRef === 'user:default/admin') return { result: AuthorizeResult.ALLOW };
    if (request.permission.name === 'catalog.entity.read') return { result: AuthorizeResult.ALLOW };
    return { result: AuthorizeResult.DENY };
  }
}
```

### Frontend

```tsx
const { loading, allowed } = usePermission({ permission: myWritePermission });
// Or gate extensions:
const page = PageBlueprint.make({ params: { path: '/admin', loader: ... }, if: { permissions: { $contains: 'admin.access' } } });
```

## Auth + Permissions Together

```ts
router.post('/create', async (req, res) => {
  const creds = await httpAuth.credentials(req, { allow: ['user'] });
  const [decision] = await permissions.authorize([{ permission: createPerm }], { credentials: creds });
  if (decision.result !== AuthorizeResult.ALLOW) throw new NotAllowedError();
  const info = await userInfo.getUserInfo(creds);
  await createEntity({ owner: info.ownershipEntityRefs[0] });
  res.json({ success: true });
});
```

### Provider-Specific Configurations

**Okta:**
```yaml
auth:
  providers:
    okta:
      development:
        clientId: ${OKTA_CLIENT_ID}
        clientSecret: ${OKTA_CLIENT_SECRET}
        audience: ${OKTA_AUDIENCE}
        authServerId: ${OKTA_AUTH_SERVER_ID}
        idp: ${OKTA_IDP}
```

**Azure/Microsoft:**
```yaml
auth:
  providers:
    microsoft:
      development:
        clientId: ${AZURE_CLIENT_ID}
        clientSecret: ${AZURE_CLIENT_SECRET}
        tenantId: ${AZURE_TENANT_ID}
```

**Google:**
```yaml
auth:
  providers:
    google:
      development:
        clientId: ${GOOGLE_CLIENT_ID}
        clientSecret: ${GOOGLE_CLIENT_SECRET}
```

### Permission Conditions & Predicate Matching

```ts
// Backend: check permission with conditions
const [decision] = await permissions.authorize(
  [{
    permission: catalogEntityReadPermission,
    resourceRef: 'component:default/my-service',
  }],
  { credentials: creds },
);
// decision.result = ALLOW | DENY | CONDITIONAL
// If CONDITIONAL, decision.conditions contains the rule predicates to apply
```

```ts
// Custom rule with query translation (for conditional filtering)
const isInSystemRule = createPermissionRule({
  name: 'IS_IN_SYSTEM',
  resourceType: 'catalog-entity',
  paramsSchema: z.object({ systemRef: z.string() }),
  apply(resource, { systemRef }) {
    return resource.spec?.system === systemRef;
  },
  toQuery({ systemRef }) {
    return { key: 'spec.system', values: [systemRef] };
  },
});
```

### Frontend Permission Components

```tsx
// Hook-based
const { loading, allowed } = usePermission({ permission: myWritePermission });

// Component-based gate
<RequirePermission permission={myWritePermission} errorPage={<Forbidden />}>
  <AdminPanel />
</RequirePermission>

// Extension-level gating
const adminPage = PageBlueprint.make({
  params: { path: '/admin', loader: () => import('./Admin').then(m => <m.Admin />) },
  if: { permissions: { $contains: 'admin.access' } },
});
```

### Policy: Allow + Deny with Conditions

```ts
class MyPolicy implements PermissionPolicy {
  async handle(request, user) {
    // Admins get everything
    if (user?.identity.userEntityRef === 'user:default/admin') {
      return { result: AuthorizeResult.ALLOW };
    }
    // Entity read: conditional — filter by ownership
    if (isPermission(request.permission, catalogEntityReadPermission)) {
      return createCatalogConditionalDecision(request.permission, {
        anyOf: [
          catalogConditions.isEntityOwner({ claims: user?.identity.ownershipEntityRefs ?? [] }),
          catalogConditions.isEntityKind({ kinds: ['Component'] }),
        ],
      });
    }
    return { result: AuthorizeResult.DENY };
  }
}
```

## Common Pitfalls

1. Not extracting credentials in handlers — `httpAuth.credentials()` required
2. Reusing tokens — always call `getPluginRequestToken` fresh
3. Sign-in resolver returning wrong `token.sub` format
4. Missing permission definitions in -common package
5. Not registering resource types for custom rules
6. Default allow-all policy in production
7. Missing `@visibility secret` on auth config fields

## Verification Checklist

- [ ] Auth backend + provider module installed
- [ ] Provider configured with secrets via `${ENV_VAR}`
- [ ] Sign-in resolver maps to Backstage User entity
- [ ] Permissions defined in -common, registered in backend
- [ ] Handlers call `permissions.authorize()` for protected ops
- [ ] Policy defaults to DENY for unknown permissions
- [ ] Frontend uses `usePermission()` or `if` predicate
- [ ] Tokens generated fresh, never stored
