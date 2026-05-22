import { useQuery } from "@tanstack/react-query";
import { useApi } from "@backstage/core-plugin-api";
import { copilotApiRef } from "../api";

export function useCopilotDaily(enterprise: string, from?: string, to?: string) {
  const api = useApi(copilotApiRef);
  return useQuery({
    queryKey: ["github-copilot", "useCopilotDaily", enterprise, from, to],
    queryFn: () => api.getEnterpriseDaily(enterprise, from!, to),
    staleTime: 5 * 60 * 1000,
    enabled: !!enterprise,
  });
}
