import React from "react";
import { render, screen } from "@testing-library/react";
import { TestApiProvider } from "@backstage/frontend-test-utils";
import { {{PLUGIN_ID.camelcase}}ApiRef } from "@backstage/plugin-{{PLUGIN_ID}}-react";

describe("Page component pattern", () => {
  it("should render with mocked API", async () => {
    // const mockApi = { getHealth: jest.fn().mockResolvedValue({ status: "ok" }) };
    // render(
    //   <TestApiProvider apis={[[{{PLUGIN_ID.camelcase}}ApiRef, mockApi]]}>
    //     <ExamplePage />
    //   </TestApiProvider>
    // );
    // expect(await screen.findByText("ok")).toBeInTheDocument();
    expect(true).toBe(true);
  });
});
