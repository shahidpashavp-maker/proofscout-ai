import { useEffect, useState } from 'react';

type Result = { title: string; url: string; snippet: string };
type Evidence = { id: string; claim: string; sourceUrl: string; sourceTitle: string; conflict: boolean };
type Page = { url: string; title: string; text: string; error?: string };

function apiErrorMessage(message: unknown, fallback: string): string {
  if (typeof message !== 'string' || !message) return fallback;
  if (/TinyFish authentication failed/i.test(message)) {
    return 'TinyFish OAuth sign-in is required. Use “Sign in with TinyFish” above, then retry.';
  }
  return message;
}

type AuthStatus = { mode: 'oauth' | 'api_key' | null; configured: boolean; connected: boolean; error?: string };

export default function App() {
  const [query, setQuery] = useState('');
  const [researchQuery, setResearchQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'search' | 'fetch'>('search');
  const [error, setError] = useState('');
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ mode: null, configured: false, connected: false });
  const [authStarting, setAuthStarting] = useState(false);

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
    }
    if (params.has('tinyfish') || params.has('tinyfish_error')) window.history.replaceState({}, document.title, window.location.pathname);

    let active = true;
    fetch('/api/auth/tinyfish/status')
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (active) setAuthStatus({ mode: data.mode === 'oauth' || data.mode === 'api_key' ? data.mode : null, configured: Boolean(data.configured), connected: Boolean(response.ok && data.connected), ...(typeof data.error === 'string' ? { error: data.error } : !response.ok ? { error: `Could not check TinyFish status (HTTP ${response.status}).` } : {}) });
      })
      .catch(() => { if (active) setAuthStatus({ mode: null, configured: false, connected: false, error: 'Could not check TinyFish connection status.' }); });
    return () => { active = false; };
  }, []);

  async function startTinyFishSignIn() {
    if (authStatus.mode === 'api_key') {
      setError('API-key mode is selected. To use OAuth, set TINYFISH_AUTH_MODE=oauth and remove TINYFISH_MCP_TOKEN from the server configuration.');
      return;
    }
    if (!authStatus.configured) {
      setError(authStatus.error || 'TinyFish OAuth is not configured on the server.');
      return;
    }
    setAuthStarting(true);
    setError('');
    try {
      const response = await fetch('/api/auth/tinyfish?format=json', { method: 'GET', headers: { Accept: 'application/json' } });
      const raw = await response.text();
      let data: { authorizationUrl?: unknown; connected?: unknown; error?: unknown } = {};
      try { data = JSON.parse(raw); } catch { /* Preserve non-JSON backend errors below. */ }
      if (!response.ok) {
        const message = typeof data.error === 'string' ? data.error : raw || `TinyFish sign-in could not start (HTTP ${response.status}).`;
        throw new Error(message);
      }
      if (data.connected === true) {
        setAuthStatus((current) => ({ ...current, connected: true }));
        return;
      }
      if (typeof data.authorizationUrl !== 'string') throw new Error('The server did not return a TinyFish authorization URL. Check the backend configuration.');
      const authorizationUrl = new URL(data.authorizationUrl);
      if (authorizationUrl.protocol !== 'https:' || authorizationUrl.username || authorizationUrl.password) {
        throw new Error('The server returned an invalid TinyFish authorization URL.');
      }
      window.location.assign(authorizationUrl.href);
    } catch (cause) {
      setError(cause instanceof Error ? `Could not start TinyFish sign-in: ${cause.message}` : 'Could not start TinyFish sign-in because of a network error.');
    } finally {
      setAuthStarting(false);
    }
  }

  async function search(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setResearchQuery(query.trim()); setResults([]); setSelected([]); setEvidence([]); setPages([]);
    try {
      const response = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
      const data = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(data.error, 'Search failed.'));
      setResults(data.results); setSelected(data.results.slice(0, 4).map((item: Result) => item.url)); setStage('fetch');
    } catch (e) { setError(e instanceof Error ? e.message : 'Search failed.'); }
    finally { setBusy(false); }
  }

  async function fetchSelected() {
    setBusy(true); setError(''); setEvidence([]); setPages([]);
    try {
      const response = await fetch('/api/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: researchQuery, urls: selected }) });
      const data = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(data.error, 'Fetch failed.'));
      setEvidence(data.evidence); setPages(data.pages);
    } catch (e) { setError(e instanceof Error ? e.message : 'Fetch failed.'); }
    finally { setBusy(false); }
  }

  function reset() { setResults([]); setSelected([]); setEvidence([]); setPages([]); setResearchQuery(''); setError(''); setStage('search'); }
  const conflictCount = evidence.filter((item) => item.conflict).length;

  return <main className="shell">
    <header className="topbar"><a className="brand" href="#" onClick={(e) => { e.preventDefault(); reset(); }}><span className="brand-mark">P</span> proofscout<span className="brand-ai">AI</span></a><div className="auth-controls"><span className={`live ${authStatus.connected ? 'connected' : 'disconnected'}`}><i />{authStatus.mode === 'api_key' ? `API KEY · ${authStatus.connected ? 'CONNECTED' : authStatus.configured ? 'NOT CONNECTED' : 'CONFIGURATION REQUIRED'}` : authStatus.mode === 'oauth' ? `OAUTH 2.1 · ${authStatus.connected ? 'CONNECTED' : authStatus.configured ? 'SIGN IN REQUIRED' : 'CONFIGURATION REQUIRED'}` : 'AUTH STATUS UNAVAILABLE'}</span><button type="button" className="auth-button" onClick={startTinyFishSignIn} disabled={!authStatus.configured || authStarting || authStatus.mode !== 'oauth'} aria-busy={authStarting} title={authStatus.error}>{authStarting ? 'Starting sign-in…' : authStatus.mode === 'api_key' ? 'API-key mode selected' : authStatus.connected ? 'Verify TinyFish' : 'Sign in with TinyFish'}</button></div></header>
    <section className="hero">
      <p className="eyebrow">RESEARCH, WITH RECEIPTS</p>
      <h1>Good questions deserve<br /><em>strong evidence.</em></h1>
      <p className="intro">Search the live web, inspect your sources, and see where the evidence agrees or diverges.</p>
      <form className="question-form" onSubmit={search}><label htmlFor="question">YOUR RESEARCH QUESTION</label><div className="input-row"><input id="question" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. What are the latest global coral reef trends?" maxLength={500} required minLength={3} /><button disabled={busy || query.trim().length < 3}>{busy && stage === 'search' ? <><span className="spinner" /> Searching</> : <>Search the web <span>↗</span></>}</button></div></form>
      {authStatus.error && !error && <div className="error-banner auth-error" role="status"><span>!</span>{authStatus.error}</div>}
      {error && <div className="error-banner" role="alert"><span>!</span>{error}</div>}
    </section>

    {results.length > 0 && <section className="results-section"><div className="section-heading"><div><p className="eyebrow">STEP 01 / DISCOVER</p><h2>Choose your sources <span className="count">{results.length}</span></h2></div><p className="section-note">We preselected a few results. Choose up to 10 to inspect.</p></div>
      <div className="source-grid">{results.map((result, index) => <label className={`source-card ${selected.includes(result.url) ? 'chosen' : ''}`} key={result.url}><input type="checkbox" checked={selected.includes(result.url)} onChange={(e) => setSelected(e.target.checked ? [...selected, result.url].slice(-10) : selected.filter((url) => url !== result.url))} disabled={!selected.includes(result.url) && selected.length >= 10} /><span className="source-number">0{index + 1}</span><span className="source-title">{result.title}</span>{result.snippet && <span className="source-snippet">{result.snippet}</span>}<span className="source-domain">{new URL(result.url).hostname}</span></label>)}</div>
      <button className="fetch-button" onClick={fetchSelected} disabled={busy || selected.length === 0}>{busy && stage === 'fetch' ? <><span className="spinner" /> Reading sources</> : <>Fetch selected sources <span>→</span></>}</button>
    </section>}

    {pages.length > 0 && <section className="evidence-section"><div className="section-heading"><div><p className="eyebrow">STEP 02 / EVIDENCE</p><h2>What the sources say</h2></div><div className="evidence-summary"><span>{evidence.length} claims</span>{conflictCount > 0 && <span className="conflict-count">{conflictCount} flagged</span>}</div></div>
      <div className="evidence-layout"><div className="claim-list">{evidence.length === 0 && <div className="empty-state">No claim-like sentences were extracted. Review the fetched source text for details.</div>}{evidence.map((item) => <article className={`claim-card ${item.conflict ? 'has-conflict' : ''}`} key={item.id}><div className="claim-topline"><span>{item.conflict ? 'POSSIBLE CONFLICT' : 'SOURCE CLAIM'}</span><span className="claim-index">{item.id.split('-').at(-1)?.padStart(2, '0')}</span></div><p>{item.claim}</p><a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.sourceTitle} <span>↗</span></a></article>)}</div>
        <aside className="source-status"><h3>Source status</h3>{pages.map((page) => <div className="status-row" key={page.url}><span className={page.error ? 'status-dot failed' : 'status-dot'} /><div><strong>{page.title}</strong><small>{page.error ? `Could not fetch · ${page.error}` : `${page.text.length.toLocaleString()} characters extracted`}</small><a href={page.url} target="_blank" rel="noreferrer">{new URL(page.url).hostname} ↗</a></div></div>)}<p className="method-note"><b>Conflict flags are heuristic.</b> Both claims remain visible so you can judge the sources yourself.</p></aside></div>
    </section>}
    <footer><span>ProofScout AI</span><span>Evidence first. Conclusions are yours.</span></footer>
  </main>;
}
