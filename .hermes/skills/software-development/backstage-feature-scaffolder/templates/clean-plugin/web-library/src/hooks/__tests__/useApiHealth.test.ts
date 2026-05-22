import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestApiProvider } from "@backstage/frontend-test-utils";
import { {{PLUGIN_ID.camelcase}}ApiRef } from "../../api";

function createWrapper(mockApi: any) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <TestApiProvider apis={[[{{PLUGIN_ID.camelcase}}ApiRef, mockApi]]}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </TestApiProvider>
  );
}

describe("API hook pattern", () => {
  it("should have test coverage for hooks", async () => {
    const mockApi = {
      getHealth: jest.fn().mockResolvedValue({ status: "ok", timestamp: new Date().toISOString() }),
    };
    // Replace with actual hook test:
    // const { result } = renderHook(() => useHealth(), { wrapper: createWrapper(mockApi) });
    // await waitFor(() => expect(result.current.data.status).toBe("ok"));
    expect(mockApi).toBeDefined();
  });
});
