/**
 * Common types for the {{pluginId}} plugin.
 *
 * @packageDocumentation
 */

/**
 * Example type shared between frontend and backend.
 */
export interface {{PluginId}}Item {
  id: string;
  entityRef: string;
  data: Record<string, unknown>;
}

/**
 * Request type for the backend API.
 */
export interface {{PluginId}}Request {
  entityRef: string;
  payload: Record<string, unknown>;
}

/**
 * Response type from the backend API.
 */
export interface {{PluginId}}Response {
  success: boolean;
  data?: {{PluginId}}Item;
  error?: string;
}

/**
 * Permission for accessing {{pluginId}} data.
 */
export const {{pluginIdCap}}_READ_PERMISSION = '{{pluginId}}.read';
