import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '../database/db.js';
import type { EvidenceClaim } from '../evidence.js';
import type { FetchResult, SearchResult } from '../tinyfish.js';
import type { TinyFishOAuthSession } from '../tinyfish-oauth.js';
import { compareClaims, type ComparisonGroup } from './comparison.js';
import { isSafePublicWebUrl } from './fetch-policy.js';

export type MonitoringStatus = 'active' | 'paused';
export type MonitoringTask = { id: string; question: string; intervalMinutes: number; status: MonitoringStatus; createdAt: string; updatedAt: string; lastCheckedAt: string | null; lastError: string | null; runCount: number };
export type MonitoringChanges = { newSources: FetchResult[]; changedSources: { url: string; title: string; previousExcerpt: string; currentExcerpt: string }[]; newClaims: EvidenceClaim[]; changedClaims: { previous: EvidenceClaim; current: EvidenceClaim }[]; claimComparisons: ComparisonGroup[] };
export type MonitoringRun = { id: string; taskId: string; checkedAt: string; success: boolean; sources: FetchResult[]; claims: EvidenceClaim[]; changes: MonitoringChanges; error?: string };
type TaskRow = { id: string; question: string; interval_minutes: number; status: MonitoringStatus; created_at: string; updated_at: string; last_checked_at: string | null; last_error: string | null; run_count: number };
type RunRow = { id: string; task_id: string; checked_at: string; success: number; sources_json: string; claims_json: string; changes_json: string; error: string | null };

const mapTask = (row: TaskRow): MonitoringTask => ({ id: row.id, question: row.question, intervalMinutes: row.interval_minutes, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, lastCheckedAt: row.last_checked_at, lastError: row.last_error, runCount: row.run_count });
const mapRun = (row: RunRow): MonitoringRun => ({ id: row.id, taskId: row.task_id, checkedAt: row.checked_at, success: row.success === 1, sources: JSON.parse(row.sources_json) as FetchResult[], claims: JSON.parse(row.claims_json) as EvidenceClaim[], changes: JSON.parse(row.changes_json) as MonitoringChanges, ...(row.error ? { error: row.error } : {}) });
const taskSelect = 'SELECT id, question, interval_minutes, status, created_at, updated_at, last_checked_at, last_error, run_count FROM monitoring_tasks';
const runSelect = 'SELECT id, task_id, checked_at, success, sources_json, claims_json, changes_json, error FROM monitoring_runs';
const emptyChanges = (): MonitoringChanges => ({ newSources: [], changedSources: [], newClaims: [], changedClaims: [], claimComparisons: [] });
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const fingerprint = (page: FetchResult) => createHash('sha256').update(page.text).digest('hex');

export function createMonitoringTask(database: DatabaseHandle, question: string, intervalMinutes: number): MonitoringTask {
  if (question.trim().length < 3 || question.trim().length > 500) throw new Error('Question must be between 3 and 500 characters.');
  if (![60, 360, 1440].includes(intervalMinutes)) throw new Error('Choose an interval of 1 hour, 6 hours, or 24 hours.');
  const count = (database.prepare('SELECT COUNT(*) AS count FROM monitoring_tasks').get() as { count: number }).count;
  if (count >= 50) throw new Error('This workspace has reached the 50 task limit.');
  const id = randomUUID(); const now = new Date().toISOString();
  database.prepare(`INSERT INTO monitoring_tasks (id, question, interval_minutes, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`).run(id, question.trim(), intervalMinutes, now, now);
  return getMonitoringTask(database, id)!;
}

export function listMonitoringTasks(database: DatabaseHandle): MonitoringTask[] {
  return (database.prepare(`${taskSelect} ORDER BY updated_at DESC`).all() as TaskRow[]).map(mapTask);
}

export function getMonitoringTask(database: DatabaseHandle, id: string): MonitoringTask | undefined {
  const row = database.prepare(`${taskSelect} WHERE id = ?`).get(id) as TaskRow | undefined;
  return row ? mapTask(row) : undefined;
}

export function getMonitoringRuns(database: DatabaseHandle, id: string): MonitoringRun[] {
  return (database.prepare(`${runSelect} WHERE task_id = ? ORDER BY checked_at DESC`).all(id) as RunRow[]).map(mapRun);
}

export function getLatestMonitoringRun(database: DatabaseHandle, id: string): MonitoringRun | undefined {
  const row = database.prepare(`${runSelect} WHERE task_id = ? ORDER BY checked_at DESC LIMIT 1`).get(id) as RunRow | undefined;
  return row ? mapRun(row) : undefined;
}

export function getLatestSuccessfulMonitoringRun(database: DatabaseHandle, id: string): MonitoringRun | undefined {
  const row = database.prepare(`${runSelect} WHERE task_id = ? AND success = 1 ORDER BY checked_at DESC LIMIT 1`).get(id) as RunRow | undefined;
  return row ? mapRun(row) : undefined;
}

export function setMonitoringTaskStatus(database: DatabaseHandle, id: string, status: MonitoringStatus): MonitoringTask | undefined {
  const result = database.prepare('UPDATE monitoring_tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
  return result.changes ? getMonitoringTask(database, id) : undefined;
}

export function deleteMonitoringTask(database: DatabaseHandle, id: string): boolean {
  return database.prepare('DELETE FROM monitoring_tasks WHERE id = ?').run(id).changes > 0;
}

function calculateChanges(previous: MonitoringRun | undefined, pages: FetchResult[], claims: EvidenceClaim[]): MonitoringChanges {
  if (!previous?.success) return { ...emptyChanges(), newSources: pages.filter((page) => !page.error && page.text.trim()) , newClaims: claims };
  const previousPages = new Map(previous.sources.filter((page) => !page.error).map((page) => [page.url, page]));
  const previousClaims = new Map(previous.claims.map((claim) => [normalize(claim.claim), claim]));
  const changes = emptyChanges();
  for (const page of pages) {
    if (page.error || !page.text.trim()) continue;
    const before = previousPages.get(page.url);
    if (!before) changes.newSources.push(page);
    else if (fingerprint(before) !== fingerprint(page)) changes.changedSources.push({ url: page.url, title: page.title, previousExcerpt: before.text.slice(0, 700), currentExcerpt: page.text.slice(0, 700) });
  }
  for (const claim of claims) {
    const prior = previousClaims.get(normalize(claim.claim));
    if (!prior) changes.newClaims.push(claim);
    else if (prior.sourceUrl !== claim.sourceUrl) changes.changedClaims.push({ previous: prior, current: claim });
  }
  changes.claimComparisons = compareClaims([...previous.claims, ...claims], [...previous.sources, ...pages])
    .filter((comparison) => comparison.verdict !== 'INSUFFICIENT EVIDENCE');
  return changes;
}

export type MonitoringProvider = {
  search: (question: string, signal?: AbortSignal) => Promise<SearchResult[]>;
  fetch: (question: string, urls: string[], signal?: AbortSignal) => Promise<FetchResult[]>;
  extract: (pages: FetchResult[]) => EvidenceClaim[];
};

const inFlight = new Set<string>();
const activeControllers = new Map<string, AbortController>();
const DAILY_BUDGET = 24;
const MINUTE_BUDGET_MS = 60_000;
const oauthSessions = new Map<string, TinyFishOAuthSession>();

export function associateMonitoringSession(id: string, session: TinyFishOAuthSession | undefined): void {
  if (session) oauthSessions.set(id, session);
  else oauthSessions.delete(id);
}

export function getMonitoringSession(id: string): TinyFishOAuthSession | undefined { return oauthSessions.get(id); }
export function forgetMonitoringSession(id: string): void { oauthSessions.delete(id); }

export async function checkMonitoringTask(database: DatabaseHandle, id: string, provider: MonitoringProvider, options: { signal?: AbortSignal; now?: () => Date; retryDelayMs?: number } = {}): Promise<MonitoringRun> {
  const task = getMonitoringTask(database, id);
  if (!task) throw new Error('Monitoring task not found.');
  if (task.status !== 'active') throw new Error('Resume this monitoring task before checking it.');
  if (inFlight.has(id)) throw new Error('A check for this task is already in progress.');
  const now = options.now ?? (() => new Date()); const startedAt = now(); const currentDate = startedAt.toISOString().slice(0, 10);
  const latest = getLatestMonitoringRun(database, id);
  if (latest && startedAt.getTime() - new Date(latest.checkedAt).getTime() < MINUTE_BUDGET_MS) throw new Error('Please wait at least one minute between checks for this task.');
  const dayStart = `${currentDate}T00:00:00.000Z`;
  const todayCount = (database.prepare('SELECT COUNT(*) AS count FROM monitoring_runs WHERE task_id = ? AND checked_at >= ?').get(id, dayStart) as { count: number }).count;
  if (todayCount >= DAILY_BUDGET) throw new Error('This task has reached its 24 check daily limit.');
  inFlight.add(id);
  const controller = new AbortController();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  activeControllers.set(id, controller);
  const signal = controller.signal;
  const runId = randomUUID(); let pages: FetchResult[] = []; let claims: EvidenceClaim[] = []; let success = false; let error: string | undefined;
  try {
    const doWithRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw new Error('Monitoring check cancelled.');
        try { return await operation(); }
        catch (cause) { if (attempt >= 1 || signal?.aborted) throw cause; await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 100)); }
      }
    };
    const results = await doWithRetry(() => provider.search(task.question, signal));
    if (signal?.aborted) throw new Error('Monitoring check cancelled.');
    const urls = [...new Set(results.map((result) => result.url).filter(isSafePublicWebUrl))].slice(0, 5);
    if (urls.length === 0) throw new Error('Search returned no usable source URLs.');
    pages = await doWithRetry(() => provider.fetch(task.question, urls, signal));
    if (signal?.aborted) throw new Error('Monitoring check cancelled.');
    claims = provider.extract(pages);
    if (signal?.aborted) throw new Error('Monitoring check cancelled.');
    success = true;
  } catch (cause) { error = signal?.aborted ? 'Monitoring check cancelled.' : cause instanceof Error ? cause.message : 'Monitoring check failed.'; }
  finally { inFlight.delete(id); activeControllers.delete(id); }
  const previous = getLatestSuccessfulMonitoringRun(database, id);
  const changes = success ? calculateChanges(previous, pages, claims) : emptyChanges();
  const checkedAt = now().toISOString();
  const run: MonitoringRun = { id: runId, taskId: id, checkedAt, success, sources: pages, claims, changes, ...(error ? { error: error.slice(0, 300) } : {}) };
  const save = database.transaction(() => {
    database.prepare(`INSERT INTO monitoring_runs (id, task_id, checked_at, success, sources_json, claims_json, changes_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(run.id, id, checkedAt, success ? 1 : 0, JSON.stringify(pages), JSON.stringify(claims), JSON.stringify(changes), run.error ?? null);
    database.prepare('UPDATE monitoring_tasks SET last_checked_at = ?, last_error = ?, updated_at = ?, run_count = run_count + 1 WHERE id = ?').run(checkedAt, run.error ?? null, checkedAt, id);
  });
  save();
  return run;
}

export function cancelMonitoringCheck(id: string): boolean {
  const controller = activeControllers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isMonitoringCheckRunning(id: string): boolean { return inFlight.has(id); }
