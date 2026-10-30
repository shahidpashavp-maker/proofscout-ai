import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';

type Page = { url: string; title: string; text: string; error?: string };
type Claim = { id: string; claim: string; sourceUrl: string; sourceTitle: string };
type Changes = { newSources: Page[]; changedSources: { url: string; title: string; previousExcerpt: string; currentExcerpt: string }[]; newClaims: Claim[]; changedClaims: { previous: Claim; current: Claim }[]; claimComparisons: { verdict: string; explanation: string; passages: { text: string; sourceUrl: string; sourceTitle: string; relation: string }[] }[] };
type Run = { id: string; taskId: string; checkedAt: string; success: boolean; sources: Page[]; claims: Claim[]; changes: Changes; error?: string };
type Task = { id: string; question: string; intervalMinutes: number; status: 'active' | 'paused'; createdAt: string; updatedAt: string; lastCheckedAt: string | null; lastError: string | null; runCount: number; latestRun: Run | null };

const emptyChanges: Changes = { newSources: [], changedSources: [], newClaims: [], changedClaims: [], claimComparisons: [] };
const time = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not checked yet';
const intervalLabel = (minutes: number) => minutes === 60 ? 'Every hour' : minutes === 360 ? 'Every 6 hours' : 'Daily';

export default function Monitoring() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [question, setQuestion] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(360);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadTasks = useCallback(async () => {
    try {
      const response = await apiFetch('/api/monitoring');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load monitoring tasks.');
      setTasks(data.tasks);
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load monitoring tasks.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadTasks(); }, [loadTasks]);

  async function createTask(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setNotice('');
    try {
      const response = await apiFetch('/api/monitoring', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, intervalMinutes }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save monitoring task.');
      setQuestion(''); setNotice('Monitoring task saved. Run a check now to capture its first baseline.'); await loadTasks();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save monitoring task.'); }
    finally { setSaving(false); }
  }

  async function action(task: Task, kind: 'check' | 'pause' | 'resume' | 'cancel' | 'delete') {
    setError(''); setNotice('');
    if (kind === 'delete' && !window.confirm('Delete this monitoring task and its saved snapshots?')) return;
    if (kind === 'check') setBusyId(task.id);
    try {
      const response = await apiFetch(kind === 'delete' ? `/api/monitoring/${task.id}` : `/api/monitoring/${task.id}/${kind}`, { method: kind === 'delete' ? 'DELETE' : 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Could not ${kind} this task.`);
      if (kind === 'check') setNotice(data.run.success ? 'Check complete. New sources and content changes are shown below.' : data.run.error || 'The check could not complete. Previous snapshots are preserved.');
      if (kind === 'delete') setNotice('Monitoring task and its saved snapshots deleted.');
      await loadTasks();
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Could not ${kind} this task.`); }
    finally { if (kind === 'check') setBusyId(''); }
  }

  return <section className="page-panel monitoring-page" aria-labelledby="monitoring-heading">
    <div className="page-heading"><div><p className="eyebrow">ONGOING RESEARCH</p><h1 id="monitoring-heading">Monitoring</h1><p>Recheck important questions over time and review meaningful changes in their sources.</p></div><span className="page-heading-count">{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</span></div>
    {error && <div className="page-error" role="alert"><strong>Monitoring needs attention.</strong><p>{error}</p><button className="text-button" onClick={() => setError('')}>Dismiss</button></div>}
    {notice && <div className="monitor-notice" role="status"><span aria-hidden="true">✓</span>{notice}<button className="text-button" onClick={() => setNotice('')}>Dismiss</button></div>}
    <form className="monitor-create" onSubmit={createTask}>
      <div><p className="eyebrow">SAVE A RESEARCH QUESTION</p><h2>Keep an eye on a changing topic</h2><p>Checks use the existing TinyFish search and fetch workflow. Each run keeps the retrieved source pages as its evidence snapshot.</p></div>
      <label htmlFor="monitor-question">Research question</label><textarea id="monitor-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="e.g. What new regulations have been proposed for..." maxLength={500} minLength={3} rows={3} required />
      <div className="monitor-form-footer"><label htmlFor="monitor-interval">Check interval<select id="monitor-interval" value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))}><option value={60}>Every hour</option><option value={360}>Every 6 hours</option><option value={1440}>Daily</option></select></label><button className="primary-button" type="submit" disabled={saving || question.trim().length < 3}>{saving ? <><span className="spinner"/> Saving…</> : <>Save monitoring task <span aria-hidden="true">→</span></>}</button></div>
      <small className="monitor-method">Automatic checks run on the server. A first manual check establishes the baseline; API credentials remain server-side.</small>
    </form>
    <div className="monitor-list-heading"><div><p className="eyebrow">SAVED TARGETS</p><h2>Monitoring tasks</h2></div><button className="secondary-button" onClick={() => { setLoading(true); void loadTasks(); }} disabled={loading}>Refresh</button></div>
    {loading ? <div className="monitor-skeleton" role="status" aria-label="Loading monitoring tasks"><i/><i/><i/></div> : tasks.length === 0 ? <div className="monitor-empty"><span className="monitor-pulse" aria-hidden="true">M</span><h2>No monitoring tasks saved</h2><p>Save a question above, then run a check to capture its first research snapshot.</p></div> : <div className="monitor-task-list">{tasks.map((task) => {
      const run = task.latestRun; const changes = run?.changes ?? emptyChanges; const changedCount = changes.newSources.length + changes.changedSources.length + changes.newClaims.length + changes.changedClaims.length + changes.claimComparisons.length;
      return <article className="monitor-task" key={task.id}>
        <div className="monitor-task-header"><div><span className={`monitor-status ${task.status}`}>{task.status === 'active' ? 'ACTIVE' : 'PAUSED'}</span><span className="monitor-interval">{intervalLabel(task.intervalMinutes)}</span></div><small>Created {time(task.createdAt)}</small></div>
        <h3>{task.question}</h3>
        <div className="monitor-meta"><span><b>Last checked</b>{time(task.lastCheckedAt)}</span><span><b>Checks saved</b>{task.runCount}</span><span><b>Latest run</b>{!run ? 'Baseline pending' : run.success ? (changedCount ? `${changedCount} changes found` : 'No meaningful changes') : 'Check failed'}</span></div>
        {task.lastError && <p className="monitor-inline-error" role="status">Latest check issue: {task.lastError}</p>}
        {busyId === task.id && <div className="monitor-running" role="status"><span className="spinner"/> Searching and fetching sources through TinyFish…<button className="text-button" onClick={() => void action(task, 'cancel')}>Cancel check</button></div>}
        {run?.success && <details className="monitor-evidence" open={changedCount > 0}><summary>{changedCount ? `Review ${changedCount} detected changes` : 'Review latest evidence snapshot'}</summary>
          {changes.newSources.map((source) => <div className="monitor-change" key={`new-${source.url}`}><span className="change-label new">NEW SOURCE</span><h4>{source.title}</h4><p>{source.text.slice(0, 350)}{source.text.length > 350 ? '…' : ''}</p><a href={source.url} target="_blank" rel="noreferrer">Open original source ↗</a></div>)}
          {changes.changedSources.map((change) => <div className="monitor-change" key={`changed-${change.url}`}><span className="change-label updated">CONTENT UPDATED</span><h4>{change.title}</h4><div className="monitor-diff"><blockquote><b>Previous snapshot</b>{change.previousExcerpt || 'No text available.'}</blockquote><blockquote><b>Latest snapshot</b>{change.currentExcerpt || 'No text available.'}</blockquote></div><a href={change.url} target="_blank" rel="noreferrer">Open original source ↗</a></div>)}
          {changes.newClaims.map((claim) => <div className="monitor-claim" key={`claim-${claim.id}-${claim.sourceUrl}`}><span className="change-label new">NEW CLAIM EXTRACTED</span><blockquote>“{claim.claim}”</blockquote><a href={claim.sourceUrl} target="_blank" rel="noreferrer">{claim.sourceTitle} ↗</a></div>)}
          {changes.changedClaims.map((change, index) => <div className="monitor-claim" key={`claim-change-${index}`}><span className="change-label updated">CLAIM SOURCE CHANGED</span><blockquote>“{change.current.claim}”</blockquote><a href={change.current.sourceUrl} target="_blank" rel="noreferrer">{change.current.sourceTitle} ↗</a></div>)}
          {changes.claimComparisons.map((comparison, index) => <div className="monitor-claim" key={`comparison-${index}`}><span className={`change-label ${comparison.verdict === 'CONTRADICTORY EVIDENCE' ? 'updated' : 'new'}`}>{comparison.verdict} · PREVIOUS VS CURRENT</span><p>{comparison.explanation}</p>{comparison.passages.map((passage, passageIndex) => <blockquote key={`passage-${passageIndex}`}>“{passage.text}”<a href={passage.sourceUrl} target="_blank" rel="noreferrer">{passage.sourceTitle} ↗</a></blockquote>)}</div>)}
          {run.sources.map((source) => <div className="monitor-source" key={source.url}><div><strong>{source.title}</strong><small>{source.error ? source.error : `${source.text.length.toLocaleString()} characters saved`}</small></div><a href={source.url} target="_blank" rel="noreferrer" aria-label={`Open ${source.title}`}>↗</a></div>)}
        </details>}
        <div className="monitor-actions"><button className="primary-button" onClick={() => void action(task, 'check')} disabled={!!busyId || task.status === 'paused'}>{busyId === task.id ? <><span className="spinner"/> Checking…</> : 'Check now'}</button><button className="secondary-button" onClick={() => void action(task, task.status === 'active' ? 'pause' : 'resume')}>{task.status === 'active' ? 'Pause' : 'Resume'}</button><button className="text-button danger-text" onClick={() => void action(task, 'delete')}>Delete</button></div>
      </article>;
    })}</div>}
  </section>;
}
