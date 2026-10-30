import { useEffect, useState } from 'react';
import { apiFetch } from '../api';

type Project = { id: string; name: string; createdAt: string; updatedAt: string; sessionCount: number };
type RecentSession = { id: string; projectId: string; projectName: string; question: string; createdAt: string; updatedAt: string; sourceCount: number };
type Props = { onNavigate: (view: 'research' | 'history' | 'reports' | 'monitoring') => void; claimCount: number };

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function Dashboard({ onNavigate, claimCount }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [recent, setRecent] = useState<RecentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning.' : hour < 17 ? 'Good afternoon.' : 'Good evening.';

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await apiFetch('/api/projects');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Projects are temporarily unavailable.');
        const projectItems = data.projects as Project[];
        const recentLists = await Promise.all(projectItems.map(async (project) => {
          const sessionsResponse = await apiFetch(`/api/projects/${project.id}/sessions`);
          const sessionsData = await sessionsResponse.json();
          if (!sessionsResponse.ok) throw new Error(sessionsData.error || 'Research history could not be loaded.');
          return (sessionsData.sessions as Array<Omit<RecentSession, 'projectName'>>).map((session) => ({ ...session, projectName: project.name }));
        }));
        if (active) {
          setProjects(projectItems);
          setRecent(recentLists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4));
        }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Dashboard data could not be loaded.'); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, []);

  const savedSessions = projects.reduce((total, project) => total + project.sessionCount, 0);
  return <section className="dashboard-page" aria-labelledby="dashboard-heading">
    <div className="dashboard-welcome"><div><p className="eyebrow">RESEARCH INTELLIGENCE · YOUR WORKSPACE</p><h1 id="dashboard-heading">{greeting}<br/><em>What are you investigating?</em></h1><p>Turn strong questions into evidence you can trace, compare, and revisit.</p></div><button className="primary-button dashboard-start" onClick={() => onNavigate('research')}><span aria-hidden="true">＋</span> Start new research</button></div>
    {error && <div className="page-error compact-error" role="alert"><strong>Workspace data could not be loaded.</strong><p>{error}</p><p>You can still start a new research session.</p></div>}
    <div className="stats-grid" aria-label="Research statistics">{loading ? <><div className="stat-skeleton"/><div className="stat-skeleton"/><div className="stat-skeleton"/></> : <><article className="stat-card"><span>PROJECTS</span><strong>{projects.length}</strong><small>Research collections</small></article><article className="stat-card"><span>SAVED SESSIONS</span><strong>{savedSessions}</strong><small>Questions preserved</small></article><article className="stat-card"><span>CLAIMS IN VIEW</span><strong>{claimCount}</strong><small>From the current session</small></article></>}</div>
    <div className="dashboard-content-grid">
      <section className="dashboard-card project-overview"><header><div><p className="eyebrow">ORGANIZED RESEARCH</p><h2>Recent projects</h2></div><button className="text-button" onClick={() => onNavigate('history')}>View history <span aria-hidden="true">↗</span></button></header>
        {loading ? <div className="list-skeleton"><i/><i/><i/></div> : projects.length ? <div className="recent-projects">{projects.slice(0, 4).map((project) => <button className="recent-project" key={project.id} onClick={() => onNavigate('history')}><span className="project-initial" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span><span className="recent-project-copy"><strong>{project.name}</strong><small>{project.sessionCount} saved {project.sessionCount === 1 ? 'session' : 'sessions'} · Updated {dateLabel(project.updatedAt)}</small></span><span aria-hidden="true">→</span></button>)}</div> : <div className="dashboard-empty"><span className="empty-mark">P</span><p>No projects yet. Save your first research session to build a project library.</p></div>}
      </section>
      <section className="dashboard-card quick-access"><p className="eyebrow">PICK UP WHERE YOU LEFT OFF</p><h2>Quick access</h2><button className="quick-link" onClick={() => onNavigate('reports')}><span className="quick-icon" aria-hidden="true">R</span><span><strong>Research reports</strong><small>Preview and export saved findings</small></span><span aria-hidden="true">↗</span></button><button className="quick-link" onClick={() => onNavigate('monitoring')}><span className="quick-icon" aria-hidden="true">M</span><span><strong>Monitoring</strong><small>Review saved monitoring tasks</small></span><span aria-hidden="true">↗</span></button></section>
    </div>
    <section className="dashboard-card recent-research"><header><div><p className="eyebrow">RECENT ACTIVITY</p><h2>Research sessions</h2></div><button className="text-button" onClick={() => onNavigate('history')}>All sessions <span aria-hidden="true">↗</span></button></header>
      {loading ? <div className="list-skeleton"><i/><i/><i/></div> : recent.length ? <div className="session-list">{recent.map((session) => <article className="recent-session" key={session.id}><span className="session-marker" aria-hidden="true"/><div><h3>{session.question}</h3><p>{session.projectName} · {session.sourceCount} sources · {dateLabel(session.updatedAt)}</p></div><button className="secondary-button" onClick={() => onNavigate('history')}>Open history</button></article>)}</div> : <div className="dashboard-empty compact-empty"><p>Saved research questions and dates will appear here.</p><button className="text-button" onClick={() => onNavigate('history')}>Open research history →</button></div>}
    </section>
  </section>;
}
