import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvidenceClaim } from '../evidence.js';
import type { FetchResult } from '../tinyfish.js';
import { compareClaims } from '../services/comparison.js';

const urlA = 'https://source-a.example/report';
const urlB = 'https://source-b.example/report';
const page = (url: string, title: string, text: string): FetchResult => ({ url, title, text });
const claim = (text: string, sourceUrl = urlA, sourceTitle = 'Report A'): EvidenceClaim => ({ id: `${sourceUrl}-claim`, claim: text, sourceUrl, sourceTitle, conflict: false });

test('similar claims from independent sources show agreement with both provenances', () => {
  const textA = 'The city installed 120 public electric vehicle charging stations by 2024.';
  const textB = 'By 2024, the city had installed 120 public electric vehicle charging stations.';
  const result = compareClaims([claim(textA), claim(textB, urlB, 'Report B')], [page(urlA, 'Report A', textA), page(urlB, 'Report B', textB)]);
  assert.equal(result.length, 1);
  assert.equal(result[0].verdict, 'AGREEMENT');
  assert.equal(result[0].independentSourceCount, 2);
  assert.deepEqual(result[0].passages.map(({ sourceUrl, sourceTitle }) => ({ sourceUrl, sourceTitle })), [
    { sourceUrl: urlA, sourceTitle: 'Report A' },
    { sourceUrl: urlB, sourceTitle: 'Report B' },
  ]);
});

test('different numeric findings about the same topic are contradictory', () => {
  const textA = 'The city installed 120 public electric vehicle charging stations.';
  const textB = 'The city installed 70 public electric vehicle charging stations.';
  const result = compareClaims([claim(textA), claim(textB, urlB, 'Report B')], [page(urlA, 'Report A', textA), page(urlB, 'Report B', textB)]);
  assert.equal(result[0].verdict, 'CONTRADICTORY EVIDENCE');
  assert.match(result[0].explanation, /conflicting claims/);
  assert.equal(result[0].passages[1].text, textB);
});

test('different reporting dates produce partial agreement, not a direct contradiction', () => {
  const textA = 'In 2022, the city installed 120 public electric vehicle charging stations.';
  const textB = 'In 2024, the city installed 180 public electric vehicle charging stations.';
  const result = compareClaims([claim(textA), claim(textB, urlB, 'Report B')], [page(urlA, 'Report A', textA), page(urlB, 'Report B', textB)]);
  assert.equal(result[0].verdict, 'PARTIAL AGREEMENT');
  assert.match(result[0].explanation, /different dates/);
});

test('population and definition differences are called partial agreement with context', () => {
  const adults = 'Among adults, the city installed 120 public electric vehicle charging stations.';
  const children = 'Among children, the city installed 120 public electric vehicle charging stations.';
  const populationResult = compareClaims([claim(adults), claim(children, urlB, 'Report B')], [page(urlA, 'Report A', adults), page(urlB, 'Report B', children)]);
  assert.equal(populationResult[0].verdict, 'PARTIAL AGREEMENT');
  assert.match(populationResult[0].explanation, /different populations/);

  const definitionA = 'The report defines a charging station as a public electric vehicle outlet.';
  const definitionB = 'The report defines a charging station as any private or public electric vehicle outlet.';
  const definitionResult = compareClaims([claim(definitionA), claim(definitionB, urlB, 'Report B')], [page(urlA, 'Report A', definitionA), page(urlB, 'Report B', definitionB)]);
  assert.equal(definitionResult[0].verdict, 'PARTIAL AGREEMENT');
});

test('different geographic contexts are not labeled a direct contradiction', () => {
  const india = 'In India, the city installed 120 public electric vehicle charging stations.';
  const canada = 'In Canada, the city installed 120 public electric vehicle charging stations.';
  const result = compareClaims([claim(india), claim(canada, urlB, 'Report B')], [page(urlA, 'Report A', india), page(urlB, 'Report B', canada)]);
  assert.equal(result[0].verdict, 'PARTIAL AGREEMENT');
  assert.match(result[0].explanation, /different regions/);
});

test('identical article copies count as one source and cannot manufacture agreement', () => {
  const text = 'The city installed 120 public electric vehicle charging stations by 2024.';
  const result = compareClaims([claim(text), claim(text, urlB, 'Copied report')], [page(urlA, 'Report A', text), page(urlB, 'Copied report', text)]);
  assert.equal(result[0].verdict, 'INSUFFICIENT EVIDENCE');
  assert.equal(result[0].independentSourceCount, 0);
  assert.match(result[0].explanation, /copies/);
  assert.ok(result[0].passages.every((passage) => !passage.independent));
});

test('copied pages do not inflate the independent source count when another source agrees', () => {
  const text = 'The city installed 120 public electric vehicle charging stations by 2024.';
  const sourceC = 'By 2024, the city had installed 120 public electric vehicle charging stations.';
  const result = compareClaims(
    [claim(text), claim(text, urlB, 'Copied report'), claim(sourceC, 'https://source-c.example/report', 'Report C')],
    [page(urlA, 'Report A', text), page(urlB, 'Copied report', text), page('https://source-c.example/report', 'Report C', sourceC)],
  );
  assert.equal(result[0].verdict, 'AGREEMENT');
  assert.equal(result[0].independentSourceCount, 2);
  assert.equal(result[0].passages.find((passage) => passage.sourceUrl === urlB)?.independent, false);
});

test('unrelated claims are not grouped and each remains insufficient', () => {
  const textA = 'The city installed 120 public electric vehicle charging stations.';
  const textB = 'Coral reefs support fish populations and protect tropical coastlines.';
  const result = compareClaims([claim(textA), claim(textB, urlB, 'Report B')], [page(urlA, 'Report A', textA), page(urlB, 'Report B', textB)]);
  assert.equal(result.length, 2);
  assert.ok(result.every((item) => item.verdict === 'INSUFFICIENT EVIDENCE'));
});

test('single-source claim has insufficient evidence for cross-source comparison', () => {
  const text = 'The city installed 120 public electric vehicle charging stations.';
  const result = compareClaims([claim(text)], [page(urlA, 'Report A', text)]);
  assert.equal(result[0].verdict, 'INSUFFICIENT EVIDENCE');
  assert.equal(result[0].independentSourceCount, 0);
});

test('missing source provenance is surfaced without inventing a citation', () => {
  const result = compareClaims([claim('The city installed 120 public electric vehicle charging stations.', '', '')], [page(urlA, 'Report A', 'The city installed 120 public electric vehicle charging stations.')]);
  assert.equal(result[0].verdict, 'INSUFFICIENT EVIDENCE');
  assert.match(result[0].explanation, /provenance is missing/);
  assert.equal(result[0].passages[0].sourceUrl, '');
  assert.equal(result[0].passages[0].sourceTitle, 'Source provenance unavailable');
});
