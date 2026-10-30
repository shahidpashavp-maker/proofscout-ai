import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../database/db.js';
import { createProject, createResearchSession, deleteProject, getResearchSession, listProjectSessions, listProjects, renameProject } from '../services/project.js';

const exampleResearch = {
  question: 'How many public charging stations were installed?',
  sources: [{ url: 'https://source.example/report', title: 'Infrastructure report', text: 'The city installed 120 charging stations.' }],
  claims: [{ id: '0-0', claim: 'The city installed 120 charging stations.', sourceUrl: 'https://source.example/report', sourceTitle: 'Infrastructure report', conflict: false }],
  verifications: [{ id: '0-0', claim: 'The city installed 120 charging stations.', sourceUrl: 'https://source.example/report', sourceTitle: 'Infrastructure report', conflict: false, verdict: 'SUPPORTED' as const, explanation: 'The source states the claim.', passages: [], basis: 'source support, not independent confirmation of objective truth' as const }],
  comparisons: [],
};

test('projects can be created, listed, renamed and safely deleted with sessions', () => {
  const database = openDatabase(':memory:');
  try {
    const project = createProject(database, 'Transport research');
    assert.equal(listProjects(database)[0].name, 'Transport research');

    const saved = createResearchSession(database, project.id, exampleResearch);
    assert.ok(saved);
    assert.equal(listProjects(database)[0].sessionCount, 1);
    assert.equal(getResearchSession(database, project.id, saved.id)?.question, exampleResearch.question);

    const renamed = renameProject(database, project.id, 'Transit evidence');
    assert.equal(renamed?.name, 'Transit evidence');
    assert.equal(renameProject(database, randomUUID(), 'Missing'), undefined);

    assert.equal(deleteProject(database, project.id), true);
    assert.equal(deleteProject(database, project.id), false);
    assert.equal(listProjects(database).length, 0);
    assert.equal(getResearchSession(database, project.id, saved.id), undefined);
  } finally { database.close(); }
});

test('saved research survives closing and reopening the SQLite database', () => {
  const file = join(tmpdir(), `proofscout-${randomUUID()}.sqlite`);
  let database = openDatabase(file);
  const project = createProject(database, 'Persistent project');
  const saved = createResearchSession(database, project.id, exampleResearch);
  assert.ok(saved);
  database.close();

  database = openDatabase(file);
  try {
    const restored = getResearchSession(database, project.id, saved.id);
    assert.ok(restored);
    assert.equal(restored.question, exampleResearch.question);
    assert.deepEqual(restored.sources, exampleResearch.sources);
    assert.deepEqual(restored.claims, exampleResearch.claims);
    assert.deepEqual(restored.verifications, exampleResearch.verifications);
    assert.deepEqual(restored.comparisons, exampleResearch.comparisons);
    assert.equal(listProjectSessions(database, project.id)?.[0].sourceCount, 1);
  } finally {
    database.close();
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  }
});
