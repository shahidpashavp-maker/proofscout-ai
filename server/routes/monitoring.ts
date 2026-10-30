import { Router, type Response } from 'express';
import { db } from '../database/db.js';
import { buildEvidence } from '../evidence.js';
import { fetchPages, searchWeb } from '../tinyfish.js';
import { readSession } from '../tinyfish-oauth.js';
import { associateMonitoringSession, cancelMonitoringCheck, checkMonitoringTask, createMonitoringTask, deleteMonitoringTask, forgetMonitoringSession, getLatestMonitoringRun, getMonitoringRuns, getMonitoringTask, isMonitoringCheckRunning, listMonitoringTasks, setMonitoringTaskStatus } from '../services/monitoring.js';

const router = Router();
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (_error: unknown, response: Response) => response.status(500).json({ error: 'The monitoring database could not complete this request.' });

router.get('/monitoring', (_request, response) => {
  try { return response.json({ tasks: listMonitoringTasks(db).map((task) => ({ ...task, latestRun: getLatestMonitoringRun(db, task.id) ?? null })) }); }
  catch (error) { return fail(error, response); }
});

router.post('/monitoring', (request, response) => {
  const question = typeof request.body?.question === 'string' ? request.body.question.trim() : '';
  const intervalMinutes = request.body?.intervalMinutes;
  if (question.length < 3 || question.length > 500) return response.status(400).json({ error: 'Enter a question between 3 and 500 characters.' });
  if (![60, 360, 1440].includes(intervalMinutes)) return response.status(400).json({ error: 'Choose an interval of 1 hour, 6 hours, or 24 hours.' });
  try {
    const task = createMonitoringTask(db, question, intervalMinutes);
    associateMonitoringSession(task.id, readSession(request.headers.cookie));
    return response.status(201).json({ task });
  }
  catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : 'Could not create a monitoring task.' }); }
});

router.get('/monitoring/:taskId', (request, response) => {
  if (!ID.test(request.params.taskId)) return response.status(400).json({ error: 'Invalid task ID.' });
  try {
    const task = getMonitoringTask(db, request.params.taskId);
    return task ? response.json({ task, runs: getMonitoringRuns(db, task.id) }) : response.status(404).json({ error: 'Monitoring task not found.' });
  } catch (error) { return fail(error, response); }
});

router.post('/monitoring/:taskId/:action', async (request, response) => {
  const { taskId, action } = request.params;
  if (!ID.test(taskId)) return response.status(400).json({ error: 'Invalid task ID.' });
  try {
    if (action === 'pause' || action === 'resume') {
      const task = setMonitoringTaskStatus(db, taskId, action === 'pause' ? 'paused' : 'active');
      return task ? response.json({ task }) : response.status(404).json({ error: 'Monitoring task not found.' });
    }
    if (action === 'cancel') return cancelMonitoringCheck(taskId) ? response.json({ cancelled: true }) : response.status(409).json({ error: 'There is no active check to cancel.' });
    if (action !== 'check') return response.status(404).json({ error: 'Unknown monitoring action.' });
    const controller = new AbortController();
    const session = readSession(request.headers.cookie);
    associateMonitoringSession(taskId, session);
    const run = await checkMonitoringTask(db, taskId, {
      search: (question, signal) => searchWeb(question, session, signal),
      fetch: (question, urls, signal) => fetchPages(question, urls, session, signal),
      extract: buildEvidence,
    }, { signal: controller.signal });
    return response.status(run.success ? 200 : 502).json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Monitoring action failed.';
    const status = /already in progress|wait at least|daily limit|Resume this/i.test(message) ? 409 : /not found/i.test(message) ? 404 : 500;
    return response.status(status).json({ error: message });
  }
});

router.delete('/monitoring/:taskId', (request, response) => {
  if (!ID.test(request.params.taskId)) return response.status(400).json({ error: 'Invalid task ID.' });
  try {
    if (isMonitoringCheckRunning(request.params.taskId)) {
      cancelMonitoringCheck(request.params.taskId);
      return response.status(409).json({ error: 'Cancellation requested. Retry deletion after the active check stops.' });
    }
    const deleted = deleteMonitoringTask(db, request.params.taskId);
    if (deleted) forgetMonitoringSession(request.params.taskId);
    return deleted ? response.json({ deleted: true }) : response.status(404).json({ error: 'Monitoring task not found.' });
  } catch (error) { return fail(error, response); }
});

export default router;
