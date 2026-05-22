import React from 'react';
import { useCopilotUsers } from '@backstage/plugin-github-copilot-react';
import { Flex, Text, Skeleton, Alert } from '@backstage/ui';

export function UsersView({ enterprise }: { enterprise: string }) {
  const end = new Date(); const start = new Date(); start.setDate(start.getDate() - 28);
  const from = start.toISOString().slice(0, 10); const to = end.toISOString().slice(0, 10);
  const { data, isLoading, error } = useCopilotUsers(enterprise, from, to);
  if (isLoading) return <Skeleton />;
  if (error) return <Alert status="danger" title="Error">{(error as Error).message}</Alert>;
  return <Flex direction="column" gap="4"><Text variant="title-large">User Drill-Down</Text><Text color="secondary">{enterprise} · {from} to {to}</Text>{data && data.length > 0 ? <Text>{data.length} users with Copilot activity</Text> : <Text color="secondary">No user data</Text>}</Flex>;
}
