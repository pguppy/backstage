import { createExtensionPoint } from '@backstage/backend-plugin-api';

export interface {{plugin_id}}Extension {
  /** Extension point for {{PLUGIN_NAME}} — replace with real interface. */
  process(): Promise<void>;
}

export const {{PLUGIN_ID}}ExtensionPoint = createExtensionPoint<{{plugin_id}}Extension>({
  id: '{{PLUGIN_ID}}.extension',
});
