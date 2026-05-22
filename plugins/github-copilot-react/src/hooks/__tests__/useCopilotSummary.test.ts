import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestApiProvider } from "@backstage/frontend-test-utils";
import { copilotApiRef } from "../../api";
import { useCopilotSummary } from "../useCopilotSummary";

function createWrapper(mockApi: any) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: React.ReactNode }) => <TestApiProvider apis={[[copilotApiRef, mockApi]]}><QueryClientProvider client={qc}>{children}</QueryClientProvider></TestApiProvider>;
}

describe("useCopilotSummary", () => {
  it("fetches summary", async () => {
    const mock = { getEnterpriseSummary: jest.fn().mockResolvedValue({ dailyActiveUsers: 500 }) };
    const { result } = renderHook(() => useCopilotSummary("test-ent"), { wrapper: createWrapper(mock) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mock.getEnterpriseSummary).toHaveBeenCalledWith("test-ent");
  });
});
