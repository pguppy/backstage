import { createPermission } from '@backstage/plugin-permission-common';

export const {{PLUGIN_ID}}ReadPermission = createPermission({
  name: '{{PLUGIN_ID}}.read',
  attributes: { action: 'read' },
});

export const {{PLUGIN_ID}}Permissions = [{{PLUGIN_ID}}ReadPermission];
