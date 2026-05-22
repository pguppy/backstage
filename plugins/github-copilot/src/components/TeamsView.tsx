import React from 'react';
import { useCopilotTeams } from '@backstage/plugin-github-copilot-react';
import { Flex, Text, Skeleton, Alert, Table, Cell, CellText } from '@backstage/ui';
import type { TeamMetrics } from '@backstage/plugin-github-copilot-common/schema/openapi/generated';

export function TeamsView({ enterprise }: { enterprise: string }) {
  const end = new Date(); const start = new Date(); start.setDate(start.getDate() - 28);
  const from = start.toISOString().slice(0, 10); const to = end.toISOString().slice(0, 10);
  const { data, isLoading, error } = useCopilotTeams(enterprise, from, to);
  if (isLoading) return <Skeleton />;
  if (error) return <Alert status="danger" title="Error">{(error as Error).message}</Alert>;
  return (
    <Flex direction="column" gap="4">
      <Text variant="title-large">Team Comparison</Text>
      <Text color="secondary">{enterprise} · {from} to {to}</Text>
      {data && data.length > 0 ? (
        <Table columnConfig={[{ id: 'team', label: 'Team', cell: (t: TeamMetrics) => <CellText title={t.teamSlug} description={t.teamId} />, isSortable: true }, { id: 'members', label: 'Members', cell: (t: TeamMetrics) => <Cell><Text>{t.memberCount.toLocaleString()}</Text></Cell>, width: '100px' }, { id: 'dau', label: 'DAU', cell: (t: TeamMetrics) => <Cell><Text>{t.dailyActiveUsers.toLocaleString()}</Text></Cell>, width: '80px' }]} data={data} emptyState={<Text color="secondary">No teams</Text>} />
      ) : <Text color="secondary">No team data available</Text>}
    </Flex>
  );
}
