const num = (v: unknown): number => Number(v) || 0;
const str = (v: unknown): string => String(v ?? "");

function extractChatModes(r: Record<string, unknown>) {
  return { askMode: num(r.chat_panel_ask_mode), editMode: num(r.chat_panel_edit_mode), planMode: num(r.chat_panel_plan_mode), agentMode: num(r.chat_panel_agent_mode), customMode: num(r.chat_panel_custom_mode), unknownMode: num(r.chat_panel_unknown_mode) };
}

export function aggregateSummary(records: Record<string, unknown>[]) {
  const t = { dau: 0, chat: 0, agent: 0, interactions: 0, suggested: 0, accepted: 0, prCreated: 0, prMerged: 0, prCopilot: 0, prReviewed: 0, cli: 0 };
  for (const r of records) {
    const pr = (r.pull_requests as Record<string, unknown>) || {};
    t.dau += num(r.daily_active_users); t.chat += num(r.monthly_active_chat_users); t.agent += num(r.monthly_active_agent_users);
    t.interactions += num(r.user_initiated_interaction_count); t.suggested += num(r.loc_suggested_to_add_sum); t.accepted += num(r.loc_added_sum);
    t.prCreated += num(pr.total_created); t.prMerged += num(pr.total_merged); t.prCopilot += num(pr.total_created_by_copilot); t.prReviewed += num(pr.total_reviewed_by_copilot); t.cli += num(r.daily_active_cli_users);
  }
  return {
    reportWindow: { startDay: str(records[0]?.day), endDay: str(records[records.length-1]?.day) },
    dailyActiveUsers: t.dau, weeklyActiveUsers: Math.round(t.dau*.7), monthlyActiveUsers: t.dau,
    monthlyActiveChatUsers: t.chat, monthlyActiveAgentUsers: t.agent, totalInteractions: t.interactions,
    codeGenerated: t.suggested, codeAccepted: t.accepted, acceptanceRate: t.suggested>0?+((t.accepted/t.suggested)*100).toFixed(1):0,
    chatModes: { askMode:0,editMode:0,planMode:0,agentMode:0,customMode:0,unknownMode:0 },
    pullRequests: { totalCreated:t.prCreated,totalMerged:t.prMerged,copilotCreated:t.prCopilot,copilotReviewed:t.prReviewed,medianTimeToMergeMinutes:0 },
    dailyActiveCLIUsers: t.cli,
  };
}

export function toDailyMetrics(r: Record<string, unknown>) {
  return { day: str(r.day), dailyActiveUsers: num(r.daily_active_users), weeklyActiveUsers: num(r.weekly_active_users), monthlyActiveUsers: num(r.monthly_active_users), userInitiatedInteractionCount: num(r.user_initiated_interaction_count), codeGenerationActivityCount: num(r.code_generation_activity_count), codeAcceptanceActivityCount: num(r.code_acceptance_activity_count), locAddedSum: num(r.loc_added_sum), locDeletedSum: num(r.loc_deleted_sum), agentEdit: num(r.agent_edit), chatModes: extractChatModes(r), dailyActiveCLIUsers: num(r.daily_active_cli_users) };
}

export function toUserMetrics(r: Record<string, unknown>) {
  return { day: str(r.day), userId: str(r.user_id), userLogin: str(r.user_login), dailyActiveUsers: num(r.daily_active_users), userInitiatedInteractionCount: num(r.user_initiated_interaction_count), codeGenerationActivityCount: num(r.code_generation_activity_count), codeAcceptanceActivityCount: num(r.code_acceptance_activity_count), locAddedSum: num(r.loc_added_sum), locDeletedSum: num(r.loc_deleted_sum), chatModes: extractChatModes(r), usedCLI: !!r.used_cli, usedAgent: !!r.used_agent, usedChat: !!r.used_chat, lastKnownIDEVersion: str(r.last_known_ide_version) };
}

export function aggregateTeams(userTeamRecords: Record<string, unknown>[]) {
  const ut: Record<string, { teamId: string; teamSlug: string }> = {};
  for (const r of userTeamRecords) { const uid = str(r.user_id), tid = str(r.team_id)||str(r.slug); if (uid&&tid) ut[uid] = { teamId: tid, teamSlug: str(r.slug) }; }
  const tm: Record<string, { slug: string; count: number }> = {};
  for (const { teamId, teamSlug } of Object.values(ut)) { if (!tm[teamId]) tm[teamId] = { slug: teamSlug||teamId, count: 0 }; tm[teamId].count++; }
  return Object.entries(tm).map(([teamId, t]) => ({ teamId, teamSlug: t.slug, memberCount: t.count, dailyActiveUsers:0, userInitiatedInteractionCount:0, codeGenerationActivityCount:0, codeAcceptanceActivityCount:0, locAddedSum:0, locDeletedSum:0, acceptanceRate:0, agentUsageCount:0 }));
}

export function dateRange(from: string, to: string): string[] {
  const r: string[] = [];
  for (let d = new Date(from), e = new Date(to); d <= e; d.setDate(d.getDate()+1)) r.push(d.toISOString().slice(0,10));
  return r;
}
