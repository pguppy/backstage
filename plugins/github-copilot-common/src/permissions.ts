import { createPermission } from '@backstage/plugin-permission-common';

export const github-copilotReadPermission = createPermission({
  name: 'github-copilot.read',
  attributes: { action: 'read' },
});

export const github-copilotPermissions = [github-copilotReadPermission];
