import { useApi } from '@backstage/core-plugin-api';
import { github-copilotApiRef } from './api';

export function usegithub-copilotData() {
  const api = useApi(github-copilotApiRef);
  // Replace with actual data fetching hook
  return { api };
}
