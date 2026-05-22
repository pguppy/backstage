import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestApiProvider } from "@backstage/frontend-test-utils";
import { copilotApiRef } from "../../api";
import { useCopilotTeams } from "../useCopilotTeams";

function createWrapper(mockApi: any) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <TestApiProvider apis={[[copilotApiRef, mockApi]]}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </TestApiProvider>
  );
}

describe("useCopilotTeams", () => {
  it("should fetch data", async () => {
    const mockApi = { getEnterpriseTeams: jest.fn().mockResolvedValue([]) };
    const { result } = renderHook(() => useCopilotTeams("test-ent", "2025-01-01", "2025-01-02"), { wrapper: createWrapper(mockApi) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApi.getEnterpriseTeams).toHaveBeenCalledWith("test-ent", "2025-01-01", "2025-01-02");
  });
});
