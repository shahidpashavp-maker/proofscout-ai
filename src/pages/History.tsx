import { useEffect, useState } from 'react';
import { apiFetch } from '../api';

type Project = { id: string; name: string; createdAt: string; updatedAt: string; sessionCount: number };
type SessionSummary = { id: string; projectId: string; question: string; createdAt: string; updatedAt: string; sourceCount: number };
export type SavedSession = SessionSummary & {
  sources: { url: string; title: string; text: string; error?: string }[];
  claims: { id: string; claim: string; sourceUrl: string; sourceTitle: string; conflict: boolean }[];
  verifications: Array<Record<string, unknown>>;
  comparisons: Array<Record<string, unknown>>;
  verificationId: string;
};

type Props = { verificationId: string; onOpenSession: (session: SavedSession) => void };

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export default function History({ verificationId, onOpenSession }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [newName, setNewName] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [editingId, setEditingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function loadProjects(preferredId?: string) {
    const response = await apiFetch('/api/projects');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load projects.');
    const items = data.projects as Project[];
    setProjects(items);
    setSelectedProject((current) => preferredId || (items.some((project) => project.id === current) ? current : items[0]?.id || ''));
  }

  async function loadSessions(projectId: string) {
    if (!projectId) { setSessions([]); return; }
    const response = await apiFetch(`/api/projects/${projectId}/sessions`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load saved sessions.');
    setSessions(data.sessions);
  }

  useEffect(() => { loadProjects().catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load projects.')).finally(() => setInitialLoading(false)); }, []);
  useEffect(() => { loadSessions(selectedProject).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load sessions.')); }, [selectedProject]);

  async function createNewProject(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const response = await apiFetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not create project.');
      setNewName(''); await loadProjects(data.project.id); setNotice('Project created.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create project.'); }
    finally { setBusy(false); }
  }

  async function saveCurrentSession() {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await apiFetch(`/api/projects/${selectedProject}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verificationId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save this research session.');
      await Promise.all([loadProjects(selectedProject), loadSessions(selectedProject)]);
      setNotice('Research session saved.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this session.'); }
    finally { setBusy(false); }
  }

  async function renameSelectedProject(event: React.FormEvent) {
    event.preventDefault(); if (!selectedProject) return;
    setBusy(true); setError('');
    try {
      const response = await apiFetch(`/api/projects/${selectedProject}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: renameValue }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not rename project.');
      setEditingId(''); await loadProjects(selectedProject); setNotice('Project renamed.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not rename project.'); }
    finally { setBusy(false); }
  }

  async function deleteSelectedProject() {
    if (!selectedProject || !window.confirm('Delete this project and all saved research sessions in it?')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await apiFetch(`/api/projects/${selectedProject}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not delete project.');
      setSelectedProject(''); setSessions([]); await loadProjects(); setNotice('Project and its saved sessions deleted.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete project.'); }
    finally { setBusy(false); }
  }

  async function openSavedSession(sessionId: string) {
    if (!selectedProject) return;
    setBusy(true); setError('');
    try {
      const response = await apiFetch(`/api/projects/${selectedProject}/sessions/${sessionId}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not open research session.');
      onOpenSession(data.session as SavedSession);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open research session.'); }
    finally { setBusy(false); }
  }

  const currentProject = projects.find((project) => project.id === selectedProject);
  return <section className="history-panel" aria-labelledby="history-heading">
    <div className="section-heading"><div><p className="eyebrow">YOUR WORKSPACE</p><h2 id="history-heading">Research history</h2></div><p className="section-note">Projects and saved research stay available after the server restarts.</p></div>
    {error && <p className="history-message history-error" role="alert">{error}</p>}{notice && <p className="history-message history-success" role="status">{notice}</p>}
    {initialLoading && <div className="history-skeleton" aria-label="Loading research history"><i/><i/><i/></div>}
    {!initialLoading && <div className="history-grid">
      <aside className="project-list"><h3>Projects</h3>{projects.length === 0 && <p className="history-empty">Create a project to organize saved research.</p>}{projects.map((project) => <button className={`project-choice ${selectedProject === project.id ? 'selected' : ''}`} key={project.id} onClick={() => { setSelectedProject(project.id); setEditingId(''); }}><strong>{project.name}</strong><small>{project.sessionCount} saved {project.sessionCount === 1 ? 'session' : 'sessions'}</small><small>Updated {formatDate(project.updatedAt)}</small></button>)}
        <form className="project-create" onSubmit={createNewProject}><label htmlFor="new-project-name">New project</label><input id="new-project-name" value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={100} placeholder="e.g. Climate policy" required /><button disabled={busy || !newName.trim()}>Create project</button></form>
      </aside>
      <div className="history-sessions">{currentProject ? <>
        <div className="history-project-head"><div><h3>{currentProject.name}</h3><small>Created {formatDate(currentProject.createdAt)} · Updated {formatDate(currentProject.updatedAt)}</small></div><div className="history-project-actions">{editingId === selectedProject ? <form className="rename-form" onSubmit={renameSelectedProject}><input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={100} required autoFocus /><button disabled={busy}>Save</button></form> : <button className="secondary-button" onClick={() => { setEditingId(selectedProject); setRenameValue(currentProject.name); }}>Rename</button>}<button className="danger-button" onClick={deleteSelectedProject} disabled={busy}>Delete project</button></div></div>
        <button className="fetch-button history-save" onClick={saveCurrentSession} disabled={!verificationId || busy}>Save current research session</button>
        <p className="history-save-note">Only fetched research with a valid research question can be saved.</p>
        <h3 className="saved-heading">Saved sessions</h3>
        {sessions.length === 0 ? <p className="history-empty">No sessions saved in this project yet.</p> : sessions.map((session) => <article className="saved-session" key={session.id}><div><h4>{session.question}</h4><p>{session.sourceCount} sources · Created {formatDate(session.createdAt)} · Updated {formatDate(session.updatedAt)}</p></div><button className="secondary-button" onClick={() => openSavedSession(session.id)} disabled={busy}>Open session</button></article>)}
      </> : <div className="history-empty history-welcome">Create or select a project to save and revisit research sessions.</div>}</div>
    </div>}
  </section>;
}
