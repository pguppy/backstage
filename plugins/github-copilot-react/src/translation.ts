import { createTranslationRef } from '@backstage/core-plugin-api/alpha';

export const github-copilotTranslationRef = createTranslationRef({
  id: 'github-copilot',
  messages: {
    title: 'GitHub Copilot Metrics',
    loading: 'Loading...',
    error: 'An error occurred',
    noData: 'No data available',
  },
});
