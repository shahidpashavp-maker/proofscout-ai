import { useEffect, useState } from 'react';
import ComparisonPanel, { type ComparisonResult } from './components/ComparisonPanel';
import Dashboard from './pages/Dashboard';
import History, { type SavedSession } from './pages/History';
import Monitoring from './pages/Monitoring';
import Reports from './pages/Reports';
import { apiFetch } from './api';

type Result = { title: string; url: string; snippet: string };
type Evidence = { id: string; claim: string; sourceUrl: string; sourceTitle: string; conflict: boolean };
type Page = { url: string; title: string; text: string; error?: string };
type Verdict = 'SUPPORTED' | 'PARTIALLY SUPPORTED' | 'CONTRADICTED' | 'INSUFFICIENT EVIDENCE';
type Verification = Evidence & { verdict: Verdict; explanation: string; passages: { text: string; sourceUrl: string; sourceTitle: string; stance: 'supports' | 'contradicts' }[]; basis: string };
type View = 'dashboard' | 'research' | 'evidence' | 'comparison' | 'history' | 'reports' | 'monitoring';
type AuthStatus = { mode: 'oauth' | 'api_key' | null; configured: boolean; connected: boolean; error?: string };

const navigation: { id: View; label: string; mark: string; group: 'workspace' | 'library' }[] = [
  { id: 'dashboard', label: 'Dashboard', mark: 'D', group: 'workspace' },
  { id: 'research', label: 'Research workspace', mark: 'R', group: 'workspace' },
  { id: 'evidence', label: 'Evidence explorer', mark: 'E', group: 'workspace' },
  { id: 'comparison', label: 'Source comparison', mark: 'C', group: 'workspace' },
  { id: 'history', label: 'Research history', mark: 'H', group: 'library' },
  { id: 'reports', label: 'Reports', mark: 'P', group: 'library' },
  { id: 'monitoring', label: 'Monitoring', mark: 'M', group: 'library' },
];

const viewTitles: Record<View, string> = {
  dashboard: 'Dashboard', research: 'Research workspace', evidence: 'Evidence explorer', comparison: 'Comparison workspace',
  history: 'Research history', reports: 'Research reports', monitoring: 'Monitoring',
};

function apiErrorMessage(message: unknown, fallback: string): string {
  if (typeof message !== 'string' || !message) return fallback;
  if (/TinyFish authentication failed/i.test(message)) return 'TinyFish OAuth sign-in is required. Use “Sign in with TinyFish” in the top bar, then retry.';
  return message;
}

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const [query, setQuery] = useState('');
  const [researchQuery, setResearchQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [verificationId, setVerificationId] = useState('');
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [comparisons, setComparisons] = useState<ComparisonResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'search' | 'fetch'>('search');
  const [error, setError] = useState('');
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ mode: null, configured: false, connected: false });
  const [authStarting, setAuthStarting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get('tinyfish_error');
    if (authError) {
      const messages: Record<string, string> = {
        authorization_denied: 'TinyFish sign-in was cancelled or denied. You can try again.',
        missing_authorization_code: 'TinyFish did not return an authorization code. Start sign-in again.',
        oauth_or_mcp_verification_failed: 'TinyFish sign-in or MCP verification failed. Check the OAuth setup and try again.',
      };
      setError(messages[authError] ?? 'TinyFish sign-in failed. Try again.');
      setView('research');
    }
    if (params.has('tinyfish') || params.has('tinyfish_error')) window.history.replaceState({}, document.title, window.location.pathname);

    let active = true;
    apiFetch('/api/auth/tinyfish/status')
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (active) setAuthStatus({ mode: data.mode === 'oauth' || data.mode === 'api_key' ? data.mode : null, configured: Boolean(data.configured), connected: Boolean(response.ok && data.connected), ...(typeof data.error === 'string' ? { error: data.error } : !response.ok ? { error: `Could not check TinyFish status (HTTP ${response.status}).` } : {}) });
      })
      .catch(() => { if (active) setAuthStatus({ mode: null, configured: false, connected: false, error: 'Could not check TinyFish connection status.' }); });
    return () => { active = false; };
  }, []);

  async function startTinyFishSignIn() {
    if (authStatus.mode === 'api_key') { setError('API-key mode is selected. To use OAuth, set TINYFISH_AUTH_MODE=oauth and remove TINYFISH_MCP_TOKEN from the server configuration.'); return; }
    if (!authStatus.configured) { setError(authStatus.error || 'TinyFish OAuth is not configured on the server.'); return; }
    setAuthStarting(true); setError('');
    try {
      const response = await apiFetch('/api/auth/tinyfish?format=json', { method: 'GET', headers: { Accept: 'application/json' } });
      const raw = await response.text();
      let data: { authorizationUrl?: unknown; connected?: unknown; error?: unknown } = {};
      try { data = JSON.parse(raw); } catch { /* Preserve non-JSON backend errors below. */ }
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : raw || `TinyFish sign-in could not start (HTTP ${response.status}).`);
      if (data.connected === true) { setAuthStatus((current) => ({ ...current, connected: true })); return; }
      if (typeof data.authorizationUrl !== 'string') throw new Error('The server did not return a TinyFish authorization URL. Check the backend configuration.');
      const authorizationUrl = new URL(data.authorizationUrl);
      if (authorizationUrl.protocol !== 'https:' || authorizationUrl.username || authorizationUrl.password) throw new Error('The server returned an invalid TinyFish authorization URL.');
      window.location.assign(authorizationUrl.href);
    } catch (cause) { setError(cause instanceof Error ? `Could not start TinyFish sign-in: ${cause.message}` : 'Could not start TinyFish sign-in because of a network error.'); }
    finally { setAuthStarting(false); }
  }

  function clearResearch() {
    setResults([]); setSelected([]); setEvidence([]); setPages([]); setVerificationId(''); setVerifications([]); setComparisons([]);
    setResearchQuery(''); setQuery(''); setError(''); setStage('search');
  }

  function startResearch() { clearResearch(); setView('research'); }

  async function search(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setResearchQuery(query.trim()); setResults([]); setSelected([]); setEvidence([]); setPages([]); setVerificationId(''); setVerifications([]); setComparisons([]); setStage('search');
    try {
      const response = await apiFetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
      const data = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(data.error, 'Search failed.'));
      setResults(data.results); setSelected(data.results.slice(0, 4).map((item: Result) => item.url)); setStage('fetch');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Search failed.'); }
    finally { setBusy(false); }
  }

  async function fetchSelected() {
    setBusy(true); setStage('fetch'); setError(''); setEvidence([]); setPages([]); setVerificationId(''); setVerifications([]); setComparisons([]);
    try {
      const response = await apiFetch('/api/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: researchQuery, urls: selected }) });
      const data = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(data.error, 'Fetch failed.'));
      setEvidence(data.evidence); setPages(data.pages); setVerificationId(data.verificationId); setVerifications([]); setView('evidence');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Fetch failed.'); }
    finally { setBusy(false); }
  }

  async function verifyClaims() {
    setVerifying(true); setError('');
    try {
      const response = await apiFetch('/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verificationId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(data.error, 'Verification failed.'));
      setVerifications(data.results);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Verification failed.'); }
    finally { setVerifying(false); }
  }

  async function compareSources() {
    setComparing(true); setError('');
    try {
      const response = await apiFetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verificationId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(data.error, 'Source comparison failed.'));
      setComparisons(data.comparisons);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Source comparison failed.'); }
    finally { setComparing(false); }
  }

  function openSavedSession(session: SavedSession) {
    setQuery(session.question); setResearchQuery(session.question); setResults([]); setSelected([]);
    setEvidence(session.claims); setPages(session.sources); setVerificationId(session.verificationId);
    setVerifications(session.verifications as Verification[]); setComparisons(session.comparisons as ComparisonResult[]);
    setStage('fetch'); setError(''); setView('evidence');
  }

  const verificationsById = new Map(verifications.map((item) => [item.id, item]));
  const fetchedCount = pages.filter((page) => !page.error && page.text.trim()).length;

  function renderWorkspace() {
    if (view === 'dashboard') return <Dashboard onNavigate={setView} claimCount={evidence.length} />;
    if (view === 'research') return <section className="research-page" aria-labelledby="research-heading">
      <div className="page-heading research-heading"><div><p className="eyebrow">LIVE WEB RESEARCH</p><h1 id="research-heading">Research workspace</h1><p>Start with a question. Follow each finding back to its source.</p></div><div className="research-progress"><span className="progress-step current"><i>01</i> Ask</span><span className={`progress-line ${results.length ? 'complete' : ''}`}/><span className={`progress-step ${results.length ? 'current' : ''}`}><i>02</i> Discover</span><span className={`progress-line ${pages.length ? 'complete' : ''}`}/><span className={`progress-step ${pages.length ? 'current' : ''}`}><i>03</i> Inspect</span></div></div>
      <form className="workspace-question" onSubmit={search}><label htmlFor="question">YOUR RESEARCH QUESTION</label><textarea id="question" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. What changed in global coral reef coverage over the last decade?" maxLength={500} required minLength={3} rows={3}/><div className="question-footer"><small>{query.length}/500 characters</small><button className="primary-button" disabled={busy || query.trim().length < 3}>{busy && stage === 'search' ? <><span className="spinner"/> Searching the web…</> : <>Search the web <span aria-hidden="true">↗</span></>}</button></div></form>
      {busy && <div className="progress-callout" role="status"><span className="spinner"/><div><strong>{stage === 'search' ? 'Searching relevant webpages' : 'Reading selected sources'}</strong><small>{stage === 'search' ? 'TinyFish Search is finding candidate sources.' : `Fetching ${selected.length} selected ${selected.length === 1 ? 'source' : 'sources'} and preparing claims.`}</small></div></div>}
      {error && <div className="page-error" role="alert"><strong>Research could not continue.</strong><p>{error}</p><button className="text-button" onClick={() => setError('')}>Dismiss</button></div>}
      <div className="workspace-metrics"><article><span>DISCOVERED</span><strong>{results.length}</strong><small>Candidate sources</small></article><article><span>FETCHED</span><strong>{fetchedCount}</strong><small>Readable source pages</small></article><article><span>CLAIMS</span><strong>{evidence.length}</strong><small>Extracted statements</small></article></div>
      {results.length > 0 && <section className="workspace-sources"><header className="section-heading"><div><p className="eyebrow">STEP 01 · DISCOVERED SOURCES</p><h2>Choose pages to inspect <span className="count">{results.length}</span></h2></div><p className="section-note">Select up to ten. A few results are selected to get you started.</p></header><div className="source-grid">{results.map((result, index) => <label className={`source-card ${selected.includes(result.url) ? 'chosen' : ''}`} key={result.url}><input type="checkbox" checked={selected.includes(result.url)} onChange={(event) => setSelected(event.target.checked ? [...selected, result.url].slice(-10) : selected.filter((url) => url !== result.url))} disabled={!selected.includes(result.url) && selected.length >= 10}/><span className="source-number">{String(index + 1).padStart(2, '0')}</span><span className="source-title">{result.title}</span>{result.snippet && <span className="source-snippet">{result.snippet}</span>}<span className="source-domain">{new URL(result.url).hostname}</span></label>)}</div><button className="primary-button fetch-button" onClick={fetchSelected} disabled={busy || selected.length === 0}>{busy && stage === 'fetch' ? <><span className="spinner"/> Fetching sources</> : <>Fetch {selected.length} selected sources <span aria-hidden="true">→</span></>}</button></section>}
      {!results.length && !busy && <div className="workspace-empty"><span className="empty-mark">01</span><div><strong>Your research will take shape here</strong><p>Search to discover sources, then choose the pages you want to inspect.</p></div></div>}
      {pages.length > 0 && <div className="fetched-summary"><div><span className="eyebrow">SOURCE EXTRACTION COMPLETE</span><strong>{fetchedCount} sources fetched · {evidence.length} claims extracted</strong></div><button className="secondary-button" onClick={() => setView('evidence')}>Open evidence explorer →</button></div>}
    </section>;
    if (view === 'evidence') return <section className="evidence-page" aria-labelledby="evidence-heading"><div className="page-heading"><div><p className="eyebrow">SOURCE-LINKED FINDINGS</p><h1 id="evidence-heading">Evidence explorer</h1><p>{researchQuery ? <>Research question: <strong>{researchQuery}</strong></> : 'Inspect claims and source passages from a retrieved research session.'}</p></div><span className="page-heading-count">{pages.length} sources · {evidence.length} claims</span></div>
      {pages.length === 0 ? <div className="page-empty"><span className="empty-mark">E</span><h2>No fetched evidence yet</h2><p>Run a search and fetch selected sources to explore their claims.</p><button className="primary-button" onClick={startResearch}>Start research</button></div> : <><div className="evidence-actions"><div><span className="eyebrow">CLAIM VERIFICATION</span><p>Verdicts describe support in fetched sources; they do not establish objective truth.</p></div><button className="primary-button" onClick={verifyClaims} disabled={verifying || evidence.length === 0 || !verificationId}>{verifying ? <><span className="spinner"/> Verifying…</> : verifications.length ? 'Verify again' : 'Verify claims'}</button></div>
        <div className="evidence-layout"><div className="claim-list">{evidence.length === 0 && <div className="page-empty compact-empty"><h2>No claim-like sentences extracted</h2><p>Review fetched source text for details.</p></div>}{evidence.map((item) => { const verification = verificationsById.get(item.id); return <article className={`claim-card ${item.conflict ? 'has-conflict' : ''}`} key={item.id}><div className="claim-topline"><span>{item.conflict ? 'POSSIBLE CONFLICT' : 'EXTRACTED CLAIM'}</span><span className="claim-index">{item.id.split('-').at(-1)?.padStart(2, '0')}</span></div><p>{item.claim}</p><a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.sourceTitle} <span aria-hidden="true">↗</span></a>{verification && <div className="verification-result"><span className={`verdict-badge verdict-${verification.verdict.toLowerCase().replaceAll(' ', '-')}`}>{verification.verdict}</span><p>{verification.explanation}</p>{verification.passages.length > 0 && <details className="verification-details"><summary>View supporting or contradictory passages</summary>{verification.passages.map((passage, index) => <div className="verification-passage" key={`${item.id}-${index}`}><span className={`passage-stance ${passage.stance}`}>{passage.stance === 'supports' ? 'SUPPORTING PASSAGE' : 'CONTRADICTORY PASSAGE'}</span><blockquote>“{passage.text}”</blockquote><a href={passage.sourceUrl} target="_blank" rel="noreferrer">{passage.sourceTitle} ↗</a></div>)}</details>}</div>}</article>; })}</div>
          <aside className="source-status"><h3>Sources examined</h3>{pages.map((page) => <div className="status-row" key={page.url}><span className={page.error ? 'status-dot failed' : 'status-dot'}/><div><strong>{page.title}</strong><small>{page.error ? `Could not fetch · ${page.error}` : `${page.text.length.toLocaleString()} characters extracted`}</small><a href={page.url} target="_blank" rel="noreferrer">{new URL(page.url).hostname} ↗</a></div></div>)}<p className="method-note"><b>Source status</b> Individual fetch failures do not remove claims from other pages.</p></aside></div>
      </>}
    </section>;
    if (view === 'comparison') return <section className="page-panel comparison-page"><div className="page-heading"><div><p className="eyebrow">AGREEMENT · CONTEXT · DISAGREEMENT</p><h1>Comparison workspace</h1><p>Review related claims across independent retrieved sources.</p></div></div>{pages.length ? <ComparisonPanel results={comparisons} loading={comparing} disabled={!verificationId} onCompare={compareSources}/> : <div className="page-empty"><span className="empty-mark">C</span><h2>No sources to compare yet</h2><p>Fetch sources in the research workspace before comparing their evidence.</p><button className="primary-button" onClick={startResearch}>Start research</button></div>}</section>;
    if (view === 'history') return <History verificationId={verificationId} onOpenSession={openSavedSession}/>;
    if (view === 'reports') return <Reports onError={setError}/>;
    return <Monitoring/>;
  }

  const authLabel = authStatus.mode === 'api_key' ? `API KEY · ${authStatus.connected ? 'CONNECTED' : authStatus.configured ? 'NOT CONNECTED' : 'CONFIGURATION REQUIRED'}` : authStatus.mode === 'oauth' ? `OAUTH 2.1 · ${authStatus.connected ? 'CONNECTED' : authStatus.configured ? 'SIGN IN REQUIRED' : 'CONFIGURATION REQUIRED'}` : 'AUTH STATUS UNAVAILABLE';
  return <div className="app-frame"><aside className="app-sidebar"><a className="brand" href="#dashboard" onClick={(event) => { event.preventDefault(); setView('dashboard'); }}><span className="brand-mark">P</span><span>proofscout<span className="brand-ai">AI</span></span></a><button className="sidebar-new" onClick={startResearch}><span aria-hidden="true">＋</span> New research</button><nav className="side-nav" aria-label="Main navigation"><p className="nav-group-label">WORKSPACE</p>{navigation.filter((item) => item.group === 'workspace').map((item) => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}><span className="nav-mark" aria-hidden="true">{item.mark}</span>{item.label}</button>)}<p className="nav-group-label library-label">LIBRARY</p>{navigation.filter((item) => item.group === 'library').map((item) => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}><span className="nav-mark" aria-hidden="true">{item.mark}</span>{item.label}</button>)}</nav><div className="sidebar-footer"><span className={`connection-indicator ${authStatus.connected ? 'is-connected' : ''}`}/><div><strong>{authStatus.connected ? 'Research connected' : 'Connection status'}</strong><small>{authStatus.connected ? 'TinyFish MCP ready' : authStatus.configured ? 'Sign-in may be required' : 'Configuration needed'}</small></div></div></aside>
    <div className="app-main"><header className="app-topbar"><div><span className="topbar-kicker">PROOFSCOUT AI</span><h2>{viewTitles[view]}</h2></div><div className="topbar-actions"><span className={`live ${authStatus.connected ? 'connected' : 'disconnected'}`}><i/>{authLabel}</span><button type="button" className="auth-button" onClick={startTinyFishSignIn} disabled={!authStatus.configured || authStarting || authStatus.mode !== 'oauth'} aria-busy={authStarting} title={authStatus.error}>{authStarting ? 'Starting…' : authStatus.mode === 'api_key' ? 'API-key mode' : authStatus.connected ? 'Verify connection' : 'Sign in with TinyFish'}</button></div></header><main className={`view-container view-${view}`}>{error && view !== 'research' && <div className="page-error global-error" role="alert"><strong>Something needs attention.</strong><p>{error}</p><button className="text-button" onClick={() => setError('')}>Dismiss</button></div>}{renderWorkspace()}</main><footer className="app-footer"><span>ProofScout AI</span><span>Evidence first. Conclusions are yours.</span></footer></div></div>;
}
