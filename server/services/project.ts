import { randomUUID } from 'node:crypto';
import type { EvidenceClaim } from '../evidence.js';
import type { FetchResult } from '../tinyfish.js';
import type { VerificationResult } from './verification.js';
import type { ComparisonGroup } from './comparison.js';
import type { DatabaseHandle } from '../database/db.js';

export type Project = { id: string; name: string; createdAt: string; updatedAt: string; sessionCount: number };
export type SavedSessionSummary = { id: string; projectId: string; question: string; createdAt: string; updatedAt: string; sourceCount: number };
export type SavedResearchSession = SavedSessionSummary & {
  sources: FetchResult[];
  claims: EvidenceClaim[];
  verifications: VerificationResult[];
  comparisons: ComparisonGroup[];
};
export type ResearchSessionInput = Omit<SavedResearchSession, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'sourceCount'>;

type ProjectRow = { id: string; name: string; created_at: string; updated_at: string; session_count: number };
type SessionRow = { id: string; project_id: string; question: string; sources_json: string; claims_json: string; verifications_json: string; comparisons_json: string; created_at: string; updated_at: string };

function mapProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at, sessionCount: row.session_count };
}

function mapSession(row: SessionRow): SavedResearchSession {
  const sources = JSON.parse(row.sources_json) as FetchResult[];
  return {
    id: row.id,
    projectId: row.project_id,
    question: row.question,
    sources,
    claims: JSON.parse(row.claims_json) as EvidenceClaim[],
    verifications: JSON.parse(row.verifications_json) as VerificationResult[],
    comparisons: JSON.parse(row.comparisons_json) as ComparisonGroup[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceCount: sources.length,
  };
}

export function listProjects(database: DatabaseHandle): Project[] {
  const rows = database.prepare(`SELECT p.id, p.name, p.created_at, p.updated_at, COUNT(s.id) AS session_count
    FROM projects p LEFT JOIN research_sessions s ON s.project_id = p.id
    GROUP BY p.id ORDER BY p.updated_at DESC`).all() as ProjectRow[];
  return rows.map(mapProject);
}

export function createProject(database: DatabaseHandle, name: string): Project {
  const now = new Date().toISOString();
  const id = randomUUID();
  database.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, now, now);
  return mapProject(database.prepare(`SELECT id, name, created_at, updated_at, 0 AS session_count FROM projects WHERE id = ?`).get(id) as ProjectRow);
}

export function renameProject(database: DatabaseHandle, id: string, name: string): Project | undefined {
  const now = new Date().toISOString();
  const result = database.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(name, now, id);
  if (result.changes === 0) return undefined;
  return mapProject(database.prepare(`SELECT p.id, p.name, p.created_at, p.updated_at, COUNT(s.id) AS session_count
    FROM projects p LEFT JOIN research_sessions s ON s.project_id = p.id WHERE p.id = ? GROUP BY p.id`).get(id) as ProjectRow);
}

export function deleteProject(database: DatabaseHandle, id: string): boolean {
  return database.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
}

export function listProjectSessions(database: DatabaseHandle, projectId: string): SavedSessionSummary[] | undefined {
  if (!database.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return undefined;
  const rows = database.prepare(`SELECT id, project_id, question, sources_json, created_at, updated_at
    FROM research_sessions WHERE project_id = ? ORDER BY updated_at DESC`).all(projectId) as Pick<SessionRow, 'id' | 'project_id' | 'question' | 'sources_json' | 'created_at' | 'updated_at'>[];
  return rows.map((row) => ({ id: row.id, projectId: row.project_id, question: row.question, createdAt: row.created_at, updatedAt: row.updated_at, sourceCount: (JSON.parse(row.sources_json) as FetchResult[]).length }));
}

export function createResearchSession(database: DatabaseHandle, projectId: string, session: ResearchSessionInput): SavedResearchSession | undefined {
  const id = randomUUID();
  const now = new Date().toISOString();
  const save = database.transaction(() => {
    if (!database.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return false;
    database.prepare(`INSERT INTO research_sessions
      (id, project_id, question, sources_json, claims_json, verifications_json, comparisons_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, projectId, session.question, JSON.stringify(session.sources), JSON.stringify(session.claims),
      JSON.stringify(session.verifications), JSON.stringify(session.comparisons), now, now,
    );
    database.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
    return true;
  });
  if (!save()) return undefined;
  return getResearchSession(database, projectId, id);
}

export function getResearchSession(database: DatabaseHandle, projectId: string, sessionId: string): SavedResearchSession | undefined {
  const row = database.prepare(`SELECT id, project_id, question, sources_json, claims_json, verifications_json, comparisons_json, created_at, updated_at
    FROM research_sessions WHERE project_id = ? AND id = ?`).get(projectId, sessionId) as SessionRow | undefined;
  return row ? mapSession(row) : undefined;
}
