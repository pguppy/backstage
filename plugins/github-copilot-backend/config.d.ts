import { HumanDuration } from "@backstage/types";

export interface Config {
  /**
   * Configuration for the GitHub Copilot Metrics backend plugin.
   * @visibility frontend
   */
  github-copilot?: {
    /**
     * Enable or disable the plugin.
     * @visibility frontend
     */
    enabled?: boolean;

    /**
     * GitHub Enterprise slug.
     * @visibility backend
     */
    enterprise?: string;

    /**
     * GitHub Organization slug.
     * @visibility backend
     */
    organization?: string;

    /**
     * Interval for periodic data sync. Uses HumanDuration format (e.g. "6h", "1d").
     * @visibility backend
     */
    syncInterval?: HumanDuration;
  };
}
