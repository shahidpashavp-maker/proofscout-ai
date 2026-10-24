import assert from 'node:assert/strict';
import test from 'node:test';
import { associateFetchedPages, fetchPagesForQuery } from './tinyfish.js';
import { buildEvidence } from './evidence.js';

const coralUrl = 'https://reef.example/coral';
const climateUrl = 'https://climate.example/trends';
const coralText = 'Coral reefs support many marine species and provide important coastal protection.';
const climateText = 'Ocean temperatures rose by 1.2 degrees during the measured period across the region.';

test('fetch request propagates the original query and selected URLs', async () => {
  let args: Record<string, unknown> | undefined;
  const pages = await fetchPagesForQuery('latest coral reef trends', [coralUrl], async (request) => {
    args = request;
    return { structuredContent: { results: [{ url: coralUrl, title: 'Coral report', content: coralText }] } };
  });
  assert.equal(args?.query, 'latest coral reef trends');
  assert.deepEqual(args?.urls, [coralUrl]);
  assert.equal(pages[0].text, coralText);
  assert.equal(pages[0].url, coralUrl);
});

test('reordered response rows are associated by exact URL, not array position', () => {
  const pages = associateFetchedPages([coralUrl, climateUrl], { structuredContent: { results: [
    { url: climateUrl, title: 'Climate trends', content: climateText },
    { url: coralUrl, title: 'Reef report', content: coralText },
  ] } });
  assert.deepEqual(pages.map(({ url, title, text }) => ({ url, title, text })), [
    { url: coralUrl, title: 'Reef report', text: coralText },
    { url: climateUrl, title: 'Climate trends', text: climateText },
  ]);
});

test('unmatched and unstructured response text becomes an error, never page content', () => {
  const pages = associateFetchedPages([coralUrl], { content: [{ type: 'text', text: 'PASHA is a word found in a dictionary.' }] });
  assert.equal(pages[0].text, '');
  assert.match(pages[0].error ?? '', /reliably matched/);
  assert.deepEqual(buildEvidence(pages), []);
});

test('per-source fetch failures produce empty pages with no claims', () => {
  const pages = associateFetchedPages([coralUrl], { structuredContent: { results: [
    { url: coralUrl, title: 'Failed reef report', status: 'error', content: coralText, error: 'HTTP 503' },
  ] } });
  assert.equal(pages[0].text, '');
  assert.equal(pages[0].error, 'HTTP 503');
  assert.deepEqual(buildEvidence(pages), []);
});

test('claims retain each page URL and title and IDs use unique page indexes', () => {
  const duplicatePage = { url: coralUrl, title: 'Coral report', text: coralText };
  const evidence = buildEvidence([duplicatePage, duplicatePage]);
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map(({ id }) => id), ['0-0', '1-0']);
  assert.deepEqual(evidence.map(({ sourceUrl, sourceTitle }) => ({ sourceUrl, sourceTitle })), [
    { sourceUrl: coralUrl, sourceTitle: 'Coral report' },
    { sourceUrl: coralUrl, sourceTitle: 'Coral report' },
  ]);
});

test('a failed fetch tool response is rejected and cannot reuse previous content', async () => {
  await assert.rejects(
    fetchPagesForQuery('latest coral reef trends', [coralUrl], async () => ({ isError: true, content: [{ type: 'text', text: coralText }] })),
    /Fetch rejected/,
  );
});
