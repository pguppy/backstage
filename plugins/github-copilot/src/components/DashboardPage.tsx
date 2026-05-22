import React, { useState, useEffect } from 'react';
import { useCopilotSummary } from '@backstage/plugin-github-copilot-react';
import { ExecutiveSummary } from './ExecutiveSummary';
import { DailyView } from './DailyView';
import { UsersView } from './UsersView';
import { TeamsView } from './TeamsView';
import { FullPage, Header, Container, Button, Alert, Tabs, TabList, Tab } from '@backstage/ui';

type View = 'summary' | 'daily' | 'users' | 'teams';
function hashView(): View { const h = window.location.hash.replace('#', ''); return (['summary', 'daily', 'users', 'teams'] as View[]).includes(h as View) ? (h as View) : 'summary'; }

export function DashboardPage() {
  const [view, setView] = useState<View>(hashView);
  useEffect(() => { const handler = () => setView(hashView()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  const enterprise = 'my-enterprise';
  const { data: summary, isLoading, error, refetch } = useCopilotSummary(enterprise);
  return (
    <FullPage>
      <FullPage.Header>
        <Header title="GitHub Copilot Metrics" tabs={<TabList><Tab href="#summary" matchStrategy="hash">Summary</Tab><Tab href="#daily" matchStrategy="hash">Daily</Tab><Tab href="#users" matchStrategy="hash">Users</Tab><Tab href="#teams" matchStrategy="hash">Teams</Tab></TabList>} customActions={<Button variant="secondary" size="small" isPending={isLoading} iconStart="refresh" onPress={() => refetch()}>Refresh</Button>} />
      </FullPage.Header>
      <FullPage.Content><Container>{error ? <Alert status="danger" title="Error">{(error as Error).message}</Alert> : <>{view === 'summary' && <ExecutiveSummary summary={summary ?? null} isLoading={isLoading} enterprise={enterprise} />}{view === 'daily' && <DailyView enterprise={enterprise} />}{view === 'users' && <UsersView enterprise={enterprise} />}{view === 'teams' && <TeamsView enterprise={enterprise} />}</>}</Container></FullPage.Content>
    </FullPage>
  );
}
