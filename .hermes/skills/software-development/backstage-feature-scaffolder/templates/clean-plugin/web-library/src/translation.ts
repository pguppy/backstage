import { createTranslationRef } from '@backstage/core-plugin-api/alpha';

export const {{PLUGIN_ID}}TranslationRef = createTranslationRef({
  id: '{{PLUGIN_ID}}',
  messages: {
    title: '{{PLUGIN_NAME}}',
    loading: 'Loading...',
    error: 'An error occurred',
    noData: 'No data available',
  },
});
