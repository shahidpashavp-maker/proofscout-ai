import { useEffect, useState } from 'react';
import { apiFetch } from '../api';

type SavedProject = { id: string; name: string; sessionCount: number };
type SavedSession = {
  id: string; projectId: string; question: string; createdAt: string; updatedAt: string;
  sources: { url: string; title: string; text: string; error?: string }[];
  claims: { id: string; claim: string; sourceUrl: string; sourceTitle: string; conflict: boolean }[];
  verifications: { id: string; verdict: string; explanation: string; passages?: { text: string; sourceUrl: string; sourceTitle: string }[] }[];
  comparisons: { id: string; statement: string; verdict: string; explanation: string; passages: { text: string; sourceUrl: string; sourceTitle: string; independent: boolean }[] }[];
};
type Props = { onError: (message: string) => void };

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const safeUrl = (value: string) => /^https?:\/\//i.test(value) ? value : '';

function reportMarkdown(session: SavedSession): string {
  const date = new Date().toISOString().slice(0, 10);
  const verdictCount = (verdict: string) => session.verifications.filter((item) => item.verdict === verdict).length;
  const sections = [
    `# Research Report\n\n**Generated:** ${date}  \n**Research question:** ${session.question}`,
    `## Executive summary\n\nThis report records ${session.sources.length} retrieved sources, ${session.claims.length} extracted claims, ${verdictCount('SUPPORTED')} supported claims, ${verdictCount('PARTIALLY SUPPORTED')} partially supported claims, ${verdictCount('CONTRADICTED')} contradicted claims, and ${verdictCount('INSUFFICIENT EVIDENCE')} claims with insufficient evidence. These are source-based results, not confirmation of objective truth.`,
    '## Research methodology\n\nThe research question was submitted to the existing TinyFish Search workflow. The selected webpages were fetched, sentence-level factual claims were extracted, and the saved verification and comparison results were calculated against the retrieved source text. No new findings were generated for this report.',
    `## Sources examined\n\n${session.sources.length ? session.sources.map((source, index) => `${index + 1}. [${source.title}](${source.url})${source.error ? ` — Fetch issue: ${source.error}` : ''}`).join('\n') : 'No sources were saved.'}`,
    `## Extracted factual claims\n\n${session.claims.length ? session.claims.map((item, index) => `${index + 1}. ${item.claim} — [${item.sourceTitle}](${item.sourceUrl})`).join('\n') : 'No claims were extracted.'}`,
    `## Claim verification results\n\n${session.verifications.length ? session.verifications.map((item) => `- **${item.verdict}** — ${item.explanation || 'No explanation was saved.'}`).join('\n') : 'No verification results were saved.'}`,
    `## Cross-source comparisons\n\n${session.comparisons.length ? session.comparisons.map((item) => `- **${item.verdict}** — ${item.statement}\n  ${item.explanation}\n${item.passages.map((passage) => `  - “${passage.text}” — [${passage.sourceTitle}](${passage.sourceUrl})${passage.independent ? '' : ' (duplicate source)'}`).join('\n')}`).join('\n') : 'No cross-source comparisons were saved.'}`,
    `## Contradictory findings\n\n${session.verifications.filter((item) => item.verdict === 'CONTRADICTED').length ? session.verifications.filter((item) => item.verdict === 'CONTRADICTED').map((item) => `- ${item.explanation}`).join('\n') : 'No claims were marked contradicted in the saved results.'}`,
    `## Key conclusions\n\n${session.verifications.some((item) => item.verdict === 'SUPPORTED') ? `${verdictCount('SUPPORTED')} claim(s) received source support in the saved verification results.` : 'No claims were marked supported in the saved verification results.'} Conflicting and insufficient evidence remains visible above; the source-level classifications do not establish objective truth.`,
    '## Research limitations\n\nThis report reflects only the pages fetched for this session. Claim extraction and verification use heuristic methods; source coverage, paraphrase, context, and page quality can affect results. Independent verification outside these sources was not performed.',
    `## References\n\n${session.sources.length ? session.sources.map((source, index) => `${index + 1}. [${source.title}](${source.url})`).join('\n') : 'No references available.'}`,
  ];
  return sections.join('\n\n---\n\n');
}

function reportHtml(session: SavedSession): string {
  const markdown = reportMarkdown(session);
  const paragraphs = markdown.split(/\n\n/).map((block) => {
    const text = escapeHtml(block);
    if (block.startsWith('# ')) return `<h1>${text.slice(2)}</h1>`;
    if (block.startsWith('## ')) return `<h2>${text.slice(3)}</h2>`;
    if (block === '---') return '<hr>';
    const withLinks = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, label: string, href: string) => `<a href="${escapeHtml(href)}">${label}</a>`);
    return `<p>${withLinks.replaceAll('\n', '<br>')}</p>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Research Report — ${escapeHtml(session.question)}</title><style>body{font:14px/1.65 Georgia,serif;color:#24352d;max-width:780px;margin:48px auto;padding:0 32px}h1{font:600 34px/1.15 Arial,sans-serif;letter-spacing:-1px}h2{font:600 18px Arial,sans-serif;margin:30px 0 8px;padding-bottom:6px;border-bottom:1px solid #deded5}p{white-space:normal}a{color:#315c48;overflow-wrap:anywhere}hr{border:0;border-top:1px solid #ddd;margin:25px 0}@media print{body{margin:14mm auto;padding:0;font-size:11pt}h1{font-size:27pt}h2{break-after:avoid}a{color:#315c48}}</style></head><body>${paragraphs}<script>window.onload=()=>window.print()</script></body></html>`;
}

export default function Reports({ onError }: Props) {
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exportNotice, setExportNotice] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const projectResponse = await apiFetch('/api/projects');
        const projectData = await projectResponse.json();
        if (!projectResponse.ok) throw new Error(projectData.error || 'Saved projects could not be loaded.');
        const projectItems = projectData.projects as SavedProject[];
        const sessionLists = await Promise.all(projectItems.map(async (project) => {
          const response = await apiFetch(`/api/projects/${project.id}/sessions`);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Saved sessions could not be loaded.');
          return (data.sessions as Array<{ id: string }>).map(async (summary) => {
            const fullResponse = await apiFetch(`/api/projects/${project.id}/sessions/${summary.id}`);
            const fullData = await fullResponse.json();
            if (!fullResponse.ok) throw new Error(fullData.error || 'A saved report could not be loaded.');
            return fullData.session as SavedSession;
          });
        }));
        const fullSessions = (await Promise.all(sessionLists.flat())).flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (active) { setProjects(projectItems); setSessions(fullSessions); setSelectedId(fullSessions[0]?.id || ''); }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Saved reports could not be loaded.');
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, []);

  const selected = sessions.find((session) => session.id === selectedId);
  const markdown = selected ? reportMarkdown(selected) : '';
  function downloadMarkdown() {
    if (!selected) return;
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `proofscout-report-${selected.id.slice(0, 8)}.md`; anchor.click(); URL.revokeObjectURL(url);
    setExportNotice('Markdown report downloaded.');
  }
  function printPdf() {
    if (!selected) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) { onError('The report window was blocked. Allow pop-ups for this app, then try PDF export again.'); return; }
    printWindow.document.open(); printWindow.document.write(reportHtml(selected)); printWindow.document.close();
    setExportNotice('Use the print dialog’s “Save as PDF” option to download the report.');
  }

  return <section className="page-panel reports-page" aria-labelledby="reports-heading">
    <div className="page-heading"><div><p className="eyebrow">EVIDENCE, READY TO SHARE</p><h1 id="reports-heading">Research reports</h1><p>Preview and export reports assembled from saved research data.</p></div><span className="page-heading-count">{projects.length} projects · {sessions.length} sessions</span></div>
    {loading ? <div className="report-skeleton" aria-label="Loading saved reports"><i/><i/><i/></div> : error ? <div className="page-error" role="alert"><strong>Saved reports could not be loaded.</strong><p>{error}</p><p>Check the history database connection and try opening Reports again.</p></div> : sessions.length === 0 ? <div className="page-empty"><span className="empty-mark">R</span><h2>No saved reports yet</h2><p>Save a fetched research session from Research history to create a report preview here.</p></div> : <>
      <div className="report-toolbar"><label htmlFor="report-session">Saved research</label><select id="report-session" value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setExportNotice(''); }}><option value="" disabled>Select a saved session</option>{projects.map((project) => <optgroup label={project.name} key={project.id}>{sessions.filter((session) => session.projectId === project.id).map((session) => <option value={session.id} key={session.id}>{session.question}</option>)}</optgroup>)}</select><button className="outline-button" onClick={downloadMarkdown} disabled={!selected}>Download Markdown</button><button className="primary-button" onClick={printPdf} disabled={!selected}>Print / save PDF</button></div>
      {exportNotice && <p className="export-notice" role="status">{exportNotice}</p>}
      {selected && <article className="report-preview"><header><span>PROOFSCOUT AI · RESEARCH DOSSIER</span><small>Generated {new Date().toLocaleDateString()}</small></header><h2>{selected.question}</h2><p className="report-deck">Evidence-backed research report · {selected.sources.length} sources · {selected.claims.length} extracted claims</p><div className="report-statline"><div><strong>{selected.verifications.filter((item) => item.verdict === 'SUPPORTED').length}</strong><small>Supported</small></div><div><strong>{selected.verifications.filter((item) => item.verdict === 'PARTIALLY SUPPORTED').length}</strong><small>Partial</small></div><div><strong>{selected.verifications.filter((item) => item.verdict === 'CONTRADICTED').length}</strong><small>Contradicted</small></div><div><strong>{selected.comparisons.length}</strong><small>Comparisons</small></div></div>
        <section><h3>Executive summary</h3><p>{selected.verifications.length} claims were checked against the fetched sources. These classifications indicate source support only and do not establish objective truth.</p></section>
        <section><h3>Research methodology</h3><p>The existing TinyFish Search and Fetch workflow retrieved these pages. Claims, verification results, and cross-source comparisons are saved from this research session; this preview adds no new findings.</p></section>
        <section><h3>Sources examined</h3>{selected.sources.length ? <ol>{selected.sources.map((source, index) => <li key={`${source.url}-${index}`}><a href={safeUrl(source.url) || undefined} target="_blank" rel="noreferrer">{source.title}</a>{source.error && <small className="source-issue">Fetch issue: {source.error}</small>}</li>)}</ol> : <p>No sources were saved.</p>}</section>
        <section><h3>Extracted claims &amp; verification</h3>{selected.claims.length ? <ol className="report-claim-list">{selected.claims.map((claim) => { const verification = selected.verifications.find((item) => item.id === claim.id); return <li key={claim.id}><p>{claim.claim}</p><span className={`report-verdict report-${(verification?.verdict || 'INSUFFICIENT EVIDENCE').toLowerCase().replaceAll(' ', '-')}`}>{verification?.verdict || 'INSUFFICIENT EVIDENCE'}</span><a href={safeUrl(claim.sourceUrl) || undefined} target="_blank" rel="noreferrer">{claim.sourceTitle}</a>{verification?.explanation && <small>{verification.explanation}</small>}</li>; })}</ol> : <p>No claims were extracted.</p>}</section>
        <section><h3>Cross-source comparisons</h3>{selected.comparisons.length ? selected.comparisons.map((comparison) => <div className="report-comparison" key={comparison.id}><strong>{comparison.verdict}</strong><p>{comparison.statement}</p><small>{comparison.explanation}</small>{comparison.passages.map((passage, index) => <blockquote key={`${comparison.id}-${index}`}>“{passage.text}” <a href={safeUrl(passage.sourceUrl) || undefined} target="_blank" rel="noreferrer">{passage.sourceTitle}</a></blockquote>)}</div>) : <p>No comparisons were saved.</p>}</section>
        <section><h3>Contradictory findings</h3>{selected.verifications.filter((item) => item.verdict === 'CONTRADICTED').length ? selected.verifications.filter((item) => item.verdict === 'CONTRADICTED').map((item) => <p key={item.id}>{item.explanation}</p>) : <p>No claims were marked contradicted in the saved verification results.</p>}</section>
        <section><h3>Key conclusions</h3><p>{selected.verifications.filter((item) => item.verdict === 'SUPPORTED').length} claim(s) received source support. Findings marked conflicting or insufficient remain visible above; no objective truth claim is made.</p></section>
        <section><h3>Research limitations</h3><p>The report covers only these fetched sources. Claim extraction, verification, and comparison use heuristic methods; results can miss paraphrases, context, or evidence outside this source set.</p></section>
        <section><h3>References</h3><ol>{selected.sources.map((source, index) => <li key={`${source.url}-ref-${index}`}><a href={safeUrl(source.url) || undefined} target="_blank" rel="noreferrer">{source.title} — {source.url}</a></li>)}</ol></section>
      </article>}
    </>}
  </section>;
}
