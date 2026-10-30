import type { DatabaseHandle } from '../database/db.js';
import { buildEvidence } from '../evidence.js';
import { getSelectedTinyFishAuthMode } from '../tinyfish-auth.js';
import { fetchPages, searchWeb } from '../tinyfish.js';
import { hasOAuthTokens } from '../tinyfish-oauth.js';
import { checkMonitoringTask, getLatestMonitoringRun, getMonitoringSession, listMonitoringTasks } from './monitoring.js';

const scheduled = new Set<string>();
let tickRunning = false;

export async function runMonitoringScheduleTick(database: DatabaseHandle, now = new Date(), injectedCheck?: (taskId: string, question: string) => Promise<unknown>): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const due = listMonitoringTasks(database).filter((task) => {
      if (task.status !== 'active' || scheduled.has(task.id)) return false;
      const lastRun = getLatestMonitoringRun(database, task.id);
      const basis = lastRun?.checkedAt ?? task.createdAt;
      return now.getTime() - new Date(basis).getTime() >= task.intervalMinutes * 60_000;
    });
    // Keep concurrent provider work bounded so a large task list cannot overwhelm TinyFish.
    for (let index = 0; index < due.length; index += 2) {
      await Promise.all(due.slice(index, index + 2).map(async (task) => {
        scheduled.add(task.id);
        try {
          if (injectedCheck) { await injectedCheck(task.id, task.question); return; }
          const session = getMonitoringSession(task.id);
          if (getSelectedTinyFishAuthMode() === 'oauth' && !hasOAuthTokens(session)) return;
          await checkMonitoringTask(database, task.id, {
            search: (question, signal) => searchWeb(question, session, signal),
            fetch: (question, urls, signal) => fetchPages(question, urls, session, signal),
            extract: buildEvidence,
          }, { retryDelayMs: 1_000 });
        } catch {
          // The task remains available for a later scheduled attempt; manual checks expose API errors.
          console.error('Monitoring scheduler could not run a due task.');
        } finally { scheduled.delete(task.id); }
      }));
    }
  } finally { tickRunning = false; }
}

export function startMonitoringScheduler(database: DatabaseHandle, pollIntervalMs = 30_000): NodeJS.Timeout {
  const timer = setInterval(() => { void runMonitoringScheduleTick(database); }, Math.max(5_000, pollIntervalMs));
  timer.unref();
  return timer;
}
