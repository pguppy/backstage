import { createExtensionPoint } from '@backstage/backend-plugin-api';

export interface github-copilotExtension {
  /** Extension point for GitHub Copilot Metrics — replace with real interface. */
  process(): Promise<void>;
}

export const github-copilotExtensionPoint = createExtensionPoint<github-copilotExtension>({
  id: 'github-copilot.extension',
});
