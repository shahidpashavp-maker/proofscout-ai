import { Router, type Response } from 'express';
import { db } from '../database/db.js';
import { createResearchSession, createProject, deleteProject, getResearchSession, listProjectSessions, listProjects, renameProject } from '../services/project.js';
import { createVerificationRecord, getStoredResearch, isValidVerificationRequest, verifyClaims } from '../services/verification.js';
import { compareStoredResearch } from '../services/comparison.js';

const router = Router();
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const databaseFailure = (_error: unknown, response: Response) => response.status(500).json({ error: 'The project database could not complete this request.' });

router.get('/projects', (_request, response) => {
  try { return response.json({ projects: listProjects(db) }); }
  catch (error) { return databaseFailure(error, response); }
});

router.post('/projects', (request, response) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  if (!name || name.length > 100) return response.status(400).json({ error: 'Project name must be between 1 and 100 characters.' });
  try { return response.status(201).json({ project: createProject(db, name) }); }
  catch (error) { return databaseFailure(error, response); }
});

router.patch('/projects/:projectId', (request, response) => {
  if (!PROJECT_ID.test(request.params.projectId)) return response.status(400).json({ error: 'Invalid project ID.' });
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  if (!name || name.length > 100) return response.status(400).json({ error: 'Project name must be between 1 and 100 characters.' });
  try {
    const project = renameProject(db, request.params.projectId, name);
    return project ? response.json({ project }) : response.status(404).json({ error: 'Project not found.' });
  } catch (error) { return databaseFailure(error, response); }
});

router.delete('/projects/:projectId', (request, response) => {
  if (!PROJECT_ID.test(request.params.projectId)) return response.status(400).json({ error: 'Invalid project ID.' });
  try { return deleteProject(db, request.params.projectId) ? response.json({ deleted: true }) : response.status(404).json({ error: 'Project not found.' }); }
  catch (error) { return databaseFailure(error, response); }
});

router.get('/projects/:projectId/sessions', (request, response) => {
  if (!PROJECT_ID.test(request.params.projectId)) return response.status(400).json({ error: 'Invalid project ID.' });
  try {
    const sessions = listProjectSessions(db, request.params.projectId);
    return sessions ? response.json({ sessions }) : response.status(404).json({ error: 'Project not found.' });
  } catch (error) { return databaseFailure(error, response); }
});

router.post('/projects/:projectId/sessions', (request, response) => {
  if (!PROJECT_ID.test(request.params.projectId)) return response.status(400).json({ error: 'Invalid project ID.' });
  if (!isValidVerificationRequest(request.body)) return response.status(400).json({ error: 'Provide a valid research ID returned by the Fetch endpoint.' });
  const research = getStoredResearch(request.body.verificationId);
  if (!research) return response.status(404).json({ error: 'Fetched research has expired. Fetch the sources again before saving.' });
  if (research.question.trim().length < 3) return response.status(422).json({ error: 'This research session has no valid question to save.' });
  try {
    const session = createResearchSession(db, request.params.projectId, {
      question: research.question,
      sources: research.pages,
      claims: research.claims,
      verifications: verifyClaims(research.claims, research.pages),
      comparisons: compareStoredResearch(research.claims, research.pages),
    });
    return session ? response.status(201).json({ session }) : response.status(404).json({ error: 'Project not found.' });
  } catch (error) { return databaseFailure(error, response); }
});

router.get('/projects/:projectId/sessions/:sessionId', (request, response) => {
  if (!PROJECT_ID.test(request.params.projectId) || !PROJECT_ID.test(request.params.sessionId)) return response.status(400).json({ error: 'Invalid project or session ID.' });
  try {
    const session = getResearchSession(db, request.params.projectId, request.params.sessionId);
    return session ? response.json({ session: { ...session, verificationId: createVerificationRecord(session.claims, session.sources, session.question) } }) : response.status(404).json({ error: 'Research session not found.' });
  } catch (error) { return databaseFailure(error, response); }
});

export default router;
