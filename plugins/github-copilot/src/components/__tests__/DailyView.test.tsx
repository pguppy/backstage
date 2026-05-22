import React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestApiProvider } from "@backstage/frontend-test-utils";
import { copilotApiRef } from "@backstage/plugin-github-copilot-react";
import { DailyView } from "../DailyView";

const mockApi = { getEnterpriseDaily: jest.fn().mockResolvedValue([]) };

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <TestApiProvider apis={[[copilotApiRef, mockApi]]}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </TestApiProvider>
  );
}

describe("DailyView", () => {
  it("should render", async () => {
    render(<DailyView enterprise="test" />, { wrapper: createWrapper() });
    await screen.findByText(/test/);
  });
});
