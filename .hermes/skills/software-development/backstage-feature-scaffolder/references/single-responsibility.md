# Single Responsibility Principle — Backstage Plugin Code

## The Rule

**No file >200 lines. No business logic in route handlers. No inline functions in components.**

This applies to ALL Backstage plugin code. Violations are rejected before the user sees them.

## Anti-Patterns — What To Never Write

### Anti-Pattern 1: Monolith Router (400+ lines)

```ts
// ❌ DON'T: 455-line router with everything inline
export async function createRouter(options): Promise<Router> {
  const router = Router();

  // NDJSON parsing logic inline in the handler
  router.get('/summary', async (req, res) => {
    const resp = await fetch(githubUrl, { headers: {...} });
    const { download_links } = await resp.json();
    const allRecords = [];
    for (const link of download_links) {
      const ndjson = await fetch(link);
      const text = await ndjson.text();
      for (const line of text.split('\n')) {
        try { allRecords.push(JSON.parse(line.trim())); } catch {}
      }
    }
    // Aggregation logic also inline
    const totals = allRecords.reduce((acc, r) => ({
      dailyActiveUsers: acc.dailyActiveUsers + n(r.daily_active_users),
      // ... 15 more fields
    }), {});
    res.json(buildSummary(totals));
  });

  // Same pattern repeated for /daily, /users, /teams...
  router.get('/daily', async (req, res) => { /* 80 lines of copy-paste */ });
  router.get('/users', async (req, res) => { /* 80 lines of copy-paste */ });

  return router;
}
```

### Correct: Thin Router + Service Layer

```ts
// ✅ router.ts (~80 lines)
export async function createRouter(options): Promise<Router> {
  const router = Router();
  const service = new ExternalService(config);
  const aggregator = new MetricsAggregator();

  router.get('/summary', async (req, res) => {
    const records = await service.fetch28DayReport(req.query.enterprise);
    const summary = aggregator.toEnterpriseSummary(records);
    res.json(summary);
  });

  router.get('/daily', async (req, res) => {
    const records = await service.fetchDailyReports(req.query.enterprise, req.query.from, req.query.to);
    const metrics = aggregator.toDailyMetrics(records);
    res.json(metrics);
  });

  return router;
}
```

```ts
// ✅ service/ExternalService.ts — HttpClient pattern
export class ExternalService {
  async fetch<T>(path: string): Promise<T> { /* auth, discovery, error handling */ }
  async fetch28DayReport(enterprise: string): Promise<RawRecord[]> { /* NDJSON fetch/parse */ }
  async fetchDailyReports(enterprise: string, from: string, to: string): Promise<RawRecord[]> {}
}
```

```ts
// ✅ service/MetricsAggregator.ts — Pure transformation
export function toEnterpriseSummary(records: RawRecord[]): EnterpriseSummary { /* reduce */ }
export function toDailyMetrics(records: RawRecord[]): DailyMetrics[] { /* map */ }
export function dateRange(from: string, to: string): string[] { /* YYYY-MM-DD list */ }
```

### Anti-Pattern 2: Inline Functions in Components (260+ lines)

```tsx
// ❌ DON'T: DashboardPage with 3 inline view functions
export function DashboardPage() {
  // ... main component body (100 lines) ...
}

function TeamsView() { /* 30 lines */ }       // ← inline
function PRLifecycleView() { /* 30 lines */ }  // ← inline
function CLIAdoptionView() { /* 30 lines */ }  // ← inline
```

### Correct: One View Per File

```tsx
// ✅ components/DashboardPage.tsx (~100 lines)
import { ExecutiveSummary } from './ExecutiveSummary';
import { CodeGenerationView } from './CodeGenerationView';
import { TeamsView } from './TeamsView';
import { PRLifecycleView } from './PRLifecycleView';

export function DashboardPage() {
  // Thin orchestrator — imports views from separate files
  return (
    <FullPage>
      {view === 'summary' && <ExecutiveSummary ... />}
      {view === 'teams' && <TeamsView ... />}
    </FullPage>
  );
}
```

```tsx
// ✅ components/TeamsView.tsx (~30 lines) — standalone file
export function TeamsView({ enterprise, from, to }: Props) { /* ... */ }
```

## Checklist — Run Before Showing User

- [ ] No file >200 lines (router, components, services)
- [ ] Router delegates to service layer (no inline fetch/parse/aggregate)
- [ ] Business logic lives in `service/` directory (not in route handlers)
- [ ] Each component is one file (no inline functions >10 lines)
- [ ] Barrel exports (`index.ts`) export ALL public symbols from each directory
