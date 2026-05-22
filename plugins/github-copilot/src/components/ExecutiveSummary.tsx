import React from 'react';
import { Card, Flex, Grid, Text, Skeleton, List } from '@backstage/ui';
import type { EnterpriseSummary } from '@backstage/plugin-github-copilot-common/schema/openapi/generated';

function MetricCard({ title, value, subtitle }: { title: string; value: string; subtitle?: string }) {
  return <Card><Card.Header>{title}</Card.Header><Card.Body><Text variant="title-large">{value}</Text>{subtitle && <Text variant="body-small" color="secondary">{subtitle}</Text>}</Card.Body></Card>;
}

export function ExecutiveSummary({ summary, isLoading, enterprise }: { summary: EnterpriseSummary | null; isLoading: boolean; enterprise: string }) {
  if (isLoading) return <Skeleton />;
  if (!summary) return <Text color="secondary">No data for {enterprise}</Text>;
  return (
    <Flex direction="column" gap="6">
      <Text variant="title-large">Executive Summary</Text>
      <Text variant="body-small" color="secondary">{enterprise} · {summary.reportWindow.startDay} to {summary.reportWindow.endDay}</Text>
      <Grid columns={{ initial: '1', sm: '2', lg: '4' }} gap="4">
        <MetricCard title="Daily Active Users" value={summary.dailyActiveUsers.toLocaleString()} subtitle={`WAU: ${summary.weeklyActiveUsers.toLocaleString()} · MAU: ${summary.monthlyActiveUsers.toLocaleString()}`} />
        <MetricCard title="Agent Mode Users" value={summary.monthlyActiveAgentUsers.toLocaleString()} subtitle={`Chat: ${summary.monthlyActiveChatUsers.toLocaleString()}`} />
        <MetricCard title="Acceptance Rate" value={`${summary.acceptanceRate.toFixed(1)}%`} subtitle={`${summary.codeAccepted.toLocaleString()} / ${summary.codeGenerated.toLocaleString()} lines`} />
        <MetricCard title="CLI Users" value={summary.dailyActiveCLIUsers.toLocaleString()} subtitle="Daily active CLI" />
      </Grid>
      <Grid columns={{ initial: '1', md: '2' }} gap="4">
        <Card><Card.Header>Total Interactions</Card.Header><Card.Body><Text variant="title-large">{summary.totalInteractions.toLocaleString()}</Text></Card.Body></Card>
        <Card><Card.Header>Chat Modes</Card.Header><Card.Body><List><List.Row iconStart="chat" action={String(summary.chatModes.askMode)}>Ask</List.Row><List.Row iconStart="edit" action={String(summary.chatModes.editMode)}>Edit</List.Row><List.Row iconStart="brain" action={String(summary.chatModes.agentMode)}>Agent</List.Row></List></Card.Body></Card>
      </Grid>
      <Grid columns={{ initial: '1', sm: '2', lg: '4' }} gap="4">
        <MetricCard title="PRs Created" value={summary.pullRequests.totalCreated.toLocaleString()} subtitle={`${summary.pullRequests.copilotCreated} by Copilot`} />
        <MetricCard title="PRs Merged" value={summary.pullRequests.totalMerged.toLocaleString()} />
        <MetricCard title="Copilot-Reviewed" value={summary.pullRequests.copilotReviewed.toLocaleString()} />
        <MetricCard title="Time to Merge" value={`${summary.pullRequests.medianTimeToMergeMinutes} min`} />
      </Grid>
    </Flex>
  );
}
