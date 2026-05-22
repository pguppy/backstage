import { useApi } from '@backstage/core-plugin-api';
import { {{PLUGIN_ID}}ApiRef } from './api';

export function use{{plugin_id}}Data() {
  const api = useApi({{PLUGIN_ID}}ApiRef);
  // Replace with actual data fetching hook
  return { api };
}
