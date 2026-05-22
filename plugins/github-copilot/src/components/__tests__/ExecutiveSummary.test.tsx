import React from "react";
import { render, screen } from "@testing-library/react";
import { ExecutiveSummary } from "../ExecutiveSummary";

describe("ExecutiveSummary", () => {
  const summary = { reportWindow:{startDay:"2025-01-01",endDay:"2025-01-28"}, dailyActiveUsers:500, weeklyActiveUsers:1200, monthlyActiveUsers:2500, monthlyActiveChatUsers:1800, monthlyActiveAgentUsers:900, totalInteractions:45000, codeGenerated:120000, codeAccepted:85000, acceptanceRate:70.8, chatModes:{askMode:0,editMode:0,planMode:0,agentMode:0,customMode:0,unknownMode:0}, pullRequests:{totalCreated:0,totalMerged:0,copilotCreated:0,copilotReviewed:0,medianTimeToMergeMinutes:0}, dailyActiveCLIUsers:200 };

  it("shows no data when null", () => {
    render(<ExecutiveSummary summary={null} isLoading={false} enterprise="t" />);
    expect(screen.getByText(/No data/)).toBeInTheDocument();
  });

  it("renders metrics", () => {
    render(<ExecutiveSummary summary={summary as any} isLoading={false} enterprise="t" />);
    expect(screen.getByText("500")).toBeInTheDocument();
    expect(screen.getByText("70.8%")).toBeInTheDocument();
  });
});
