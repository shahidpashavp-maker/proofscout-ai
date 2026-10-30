export type ComparisonVerdict = 'AGREEMENT' | 'PARTIAL AGREEMENT' | 'CONTRADICTORY EVIDENCE' | 'INSUFFICIENT EVIDENCE';
export type ComparisonResult = {
  id: string;
  statement: string;
  verdict: ComparisonVerdict;
  explanation: string;
  independentSourceCount: number;
  passages: { text: string; sourceUrl: string; sourceTitle: string; independent: boolean; relation: 'agrees' | 'disagrees' | 'context differs' | 'unassessed' }[];
};

type Props = { results: ComparisonResult[]; loading: boolean; disabled: boolean; onCompare: () => void };

export default function ComparisonPanel({ results, loading, disabled, onCompare }: Props) {
  return <section className="comparison-panel" aria-labelledby="comparison-heading">
    <div className="comparison-heading"><div><p className="eyebrow">CROSS-SOURCE CHECK</p><h3 id="comparison-heading">Compare the evidence</h3></div>
      <button className="comparison-button" onClick={onCompare} disabled={disabled || loading}>{loading ? 'Comparing sources…' : results.length ? 'Compare again' : 'Compare sources'}</button>
    </div>
    <p className="comparison-disclaimer">Independent source comparison is heuristic. Copies are grouped as one source, and differences in context are kept separate from direct contradictions.</p>
    {results.length > 0 && <div className="comparison-groups">{results.map((item) => <article className={`comparison-group comparison-${item.verdict.toLowerCase().replaceAll(' ', '-')}`} key={item.id}>
      <div className="comparison-result-head"><span className="comparison-badge">{item.verdict}</span><span className="independent-count">{item.independentSourceCount} independent {item.independentSourceCount === 1 ? 'source' : 'sources'}</span></div>
      <h4>{item.statement}</h4><p className="comparison-explanation">{item.explanation}</p>
      <div className="comparison-columns">{item.passages.map((passage, index) => <div className={`comparison-source comparison-relation-${passage.relation.replaceAll(' ', '-')}`} key={`${item.id}-${index}`}>
        <div className="comparison-source-label">{passage.relation === 'disagrees' ? 'CONTRADICTORY PASSAGE' : passage.relation === 'agrees' ? 'MATCHING PASSAGE' : passage.relation === 'context differs' ? 'DIFFERENT CONTEXT' : 'NOT ASSESSED'}</div>
        <blockquote>{passage.text}</blockquote>
        <a href={passage.sourceUrl || undefined} target="_blank" rel="noreferrer" aria-disabled={!passage.sourceUrl}>{passage.sourceTitle}</a>
        {!passage.independent && <small className="duplicate-note">This page appears to duplicate another source in this group.</small>}
      </div>)}</div>
    </article>)}</div>}
    {!results.length && !loading && <p className="comparison-empty">Compare the retrieved claims to see matching and conflicting source passages side by side.</p>}
  </section>;
}
