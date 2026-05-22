import { useQuery } from "@tanstack/react-query";
import { useApi } from "@backstage/core-plugin-api";
import { copilotApiRef } from "../api";

export function useCopilotFreshness(enterprise: string, from?: string, to?: string) {
  const api = useApi(copilotApiRef);
  return useQuery({
    queryKey: ["github-copilot", "useCopilotFreshness", enterprise, from, to],
    queryFn: () => api.getDataFreshness(enterprise, from!, to),
    staleTime: 5 * 60 * 1000,
    enabled: !!enterprise,
  });
}
