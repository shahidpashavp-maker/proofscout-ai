import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { EvidenceClaim } from '../evidence.js';
import type { FetchResult, SearchResult } from '../tinyfish.js';
import { openDatabase } from '../database/db.js';
import { runMonitoringScheduleTick } from '../services/monitor-scheduler.js';
import { cancelMonitoringCheck, checkMonitoringTask, createMonitoringTask, deleteMonitoringTask, getLatestMonitoringRun, getMonitoringRuns, getMonitoringTask, listMonitoringTasks, setMonitoringTaskStatus, type MonitoringProvider } from '../services/monitoring.js';

const question = 'How many charging stations were installed?';
const page = (url: string, text: string, title = 'City report'): FetchResult => ({ url, title, text });
const claims = (pages: FetchResult[]): EvidenceClaim[] => pages.flatMap((source, i) => source.text.split('\n').filter((sentence) => sentence.length >= 30).map((sentence, j) => ({ id: `${i}-${j}`, claim: sentence, sourceUrl: source.url, sourceTitle: source.title, conflict: false })));
const provider = (sources: FetchResult[]): MonitoringProvider => ({
  search: async () => sources.map(({ url, title }) => ({ url, title, snippet: '' }) as SearchResult),
  fetch: async () => sources,
  extract: claims,
});

test('monitoring tasks support creation, listing, pausing, resuming, deletion and stored runs', async () => {
  const database = openDatabase(':memory:');
  try {
    const task = createMonitoringTask(database, question, 360);
    assert.equal(listMonitoringTasks(database)[0].id, task.id);
    assert.equal(setMonitoringTaskStatus(database, task.id, 'paused')?.status, 'paused');
    await assert.rejects(checkMonitoringTask(database, task.id, provider([])), /Resume/);
    assert.equal(setMonitoringTaskStatus(database, task.id, 'active')?.status, 'active');
    const result = await checkMonitoringTask(database, task.id, provider([page('https://city.example.com/report', 'The city installed 120 charging stations by the end of 2024.')]), { now: () => new Date('2026-01-01T00:00:00Z') });
    assert.equal(result.success, true);
    assert.equal(result.changes.newSources[0].url, 'https://city.example.com/report');
    assert.equal(result.changes.newClaims.length, 1);
    assert.deepEqual(getLatestMonitoringRun(database, task.id), result);
    assert.equal(getMonitoringRuns(database, task.id).length, 1);
    assert.equal(getMonitoringTask(database, task.id)?.lastCheckedAt, result.checkedAt);
    assert.equal(deleteMonitoringTask(database, task.id), true);
    assert.equal(getMonitoringTask(database, task.id), undefined);
    assert.equal(getMonitoringRuns(database, task.id).length, 0);
  } finally { database.close(); }
});

test('monitoring questions, run snapshots and provenance persist across a database restart', async () => {
  const file = join(tmpdir(), `proofscout-monitor-audit-${randomUUID()}.sqlite`);
  let database = openDatabase(file);
  const task = createMonitoringTask(database, question, 1440);
  const source = page('https://city.example.com/population', 'Statistics Iceland reports the national population at the beginning of 2025.');
  const first = await checkMonitoringTask(database, task.id, provider([source]));
  assert.equal(first.success, true);
  database.close();
  database = openDatabase(file);
  try {
    assert.equal(getMonitoringTask(database, task.id)?.question, question);
    assert.equal(getLatestMonitoringRun(database, task.id)?.sources[0].url, source.url);
    assert.equal(getLatestMonitoringRun(database, task.id)?.sources[0].title, source.title);
    assert.equal(getMonitoringRuns(database, task.id).length, 1);
  } finally {
    database.close();
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  }
});

test('monitoring compares source snapshots and identifies new sources and claims', async () => {
  const database = openDatabase(':memory:');
  try {
    const task = createMonitoringTask(database, question, 60);
    const first = provider([page('https://city.example.com/report', 'The city installed 120 charging stations by the end of 2024.')]);
    await checkMonitoringTask(database, task.id, first, { now: () => new Date('2026-01-02T00:00:00Z') });
    const second = provider([
      page('https://city.example.com/report', 'The city installed 150 charging stations by the end of 2025.'),
      page('https://agency.example.com/update', 'The regional agency announced 25 new charging stations for the city.'),
    ]);
    const next = await checkMonitoringTask(database, task.id, second, { now: () => new Date('2026-01-02T00:02:00Z') });
    assert.equal(next.changes.newSources.length, 1);
    assert.equal(next.changes.newSources[0].url, 'https://agency.example.com/update');
    assert.equal(next.changes.changedSources.length, 1);
    assert.equal(next.changes.changedSources[0].url, 'https://city.example.com/report');
    assert.equal(next.changes.newClaims.length, 2);
    assert.equal(next.sources[0].title, 'City report');
  } finally { database.close(); }
});

test('monitoring compares new claims with prior claims and flags changed factual details', async () => {
  const database = openDatabase(':memory:');
  try {
    const task = createMonitoringTask(database, question, 60);
    await checkMonitoringTask(database, task.id, provider([page('https://city.example.com/first', 'The city installed 120 public charging stations during its 2024 expansion.')]), { now: () => new Date('2026-01-02T00:00:00Z') });
    const next = await checkMonitoringTask(database, task.id, provider([page('https://agency.example.com/latest', 'The city installed 70 public charging stations during its 2024 expansion.', 'Agency update')]), { now: () => new Date('2026-01-02T00:02:00Z') });
    assert.equal(next.changes.claimComparisons.some((item) => item.verdict === 'CONTRADICTORY EVIDENCE'), true);
  } finally { database.close(); }
});

test('monitoring retries one failed provider request then stores failure without losing prior results', async () => {
  const database = openDatabase(':memory:');
  try {
    const task = createMonitoringTask(database, question, 1440);
    let attempts = 0;
    const fails = provider([]);
    fails.search = async () => { attempts++; throw new Error('temporary provider outage'); };
    const result = await checkMonitoringTask(database, task.id, fails, { retryDelayMs: 0, now: () => new Date('2026-01-03T00:00:00Z') });
    assert.equal(attempts, 2);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /temporary provider outage/);
    assert.equal(getLatestMonitoringRun(database, task.id)?.success, false);
  } finally { database.close(); }
});

test('a failed run does not replace the previous successful source baseline', async () => {
  const database = openDatabase(':memory:');
  try {
    const task = createMonitoringTask(database, question, 360);
    const baseline = page('https://city.example.com/report', 'The city installed 120 public charging stations during 2024.');
    await checkMonitoringTask(database, task.id, provider([baseline]), { now: () => new Date('2026-01-05T00:00:00Z') });
    const broken = provider([]);
    broken.search = async () => { throw new Error('temporary outage'); };
    await checkMonitoringTask(database, task.id, broken, { retryDelayMs: 0, now: () => new Date('2026-01-05T00:02:00Z') });
    const recovered = await checkMonitoringTask(database, task.id, provider([baseline]), { now: () => new Date('2026-01-05T00:04:00Z') });
    assert.equal(recovered.changes.newSources.length, 0);
    assert.equal(recovered.changes.newClaims.length, 0);
  } finally { database.close(); }
});

test('monitoring enforces interval and cancellation during a running provider call', async () => {
  const database = openDatabase(':memory:');
  try {
    assert.throws(() => createMonitoringTask(database, question, 30), /interval/);
    const task = createMonitoringTask(database, question, 60);
    const controller = new AbortController();
    const slow = provider([]);
    let releaseSearch!: () => void;
    slow.search = () => new Promise((resolve) => { releaseSearch = () => resolve([]); });
    const pending = checkMonitoringTask(database, task.id, slow, { signal: controller.signal, now: () => new Date('2026-01-04T00:00:00Z') });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(cancelMonitoringCheck(task.id), true);
    releaseSearch();
    const result = await pending;
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /cancelled/);
  } finally { database.close(); }
});

test('backend scheduler runs only due active tasks and avoids duplicate overlapping ticks', async () => {
  const database = openDatabase(':memory:');
  try {
    const due = createMonitoringTask(database, question, 60);
    const paused = createMonitoringTask(database, 'How did urban transit ridership change?', 60);
    const future = createMonitoringTask(database, 'What new parks opened this year?', 360);
    database.prepare('UPDATE monitoring_tasks SET created_at = ? WHERE id IN (?, ?)').run('2026-01-01T00:00:00.000Z', due.id, paused.id);
    setMonitoringTaskStatus(database, paused.id, 'paused');
    let runs = 0;
    await runMonitoringScheduleTick(database, new Date('2026-01-01T01:01:00.000Z'), async () => { runs++; });
    assert.equal(runs, 1);
    assert.equal(getMonitoringTask(database, future.id)?.runCount, 0);

    let release!: () => void;
    const slowCheck = runMonitoringScheduleTick(database, new Date('2026-01-01T02:02:00.000Z'), async () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runMonitoringScheduleTick(database, new Date('2026-01-01T02:03:00.000Z'), async () => { runs++; });
    assert.equal(runs, 1);
    release();
    await slowCheck;
  } finally { database.close(); }
});
