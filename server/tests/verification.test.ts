import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvidenceClaim } from '../evidence.js';
import type { FetchResult } from '../tinyfish.js';
import { createVerificationRecord, isValidVerificationRequest, verifyClaim, verifyStoredClaims } from '../services/verification.js';

const url = 'https://reef.example/report';
const title = 'Reef report';
const claim = (text: string, sourceUrl = url, sourceTitle = title): EvidenceClaim => ({ id: '0-0', claim: text, sourceUrl, sourceTitle, conflict: false });
const page = (text: string): FetchResult => ({ url, title, text });

test('direct source passage supports the claim and is quoted exactly', () => {
  const result = verifyClaim(claim('Coral reefs support fish and provide important coastal protection.'), [page('Coral reefs support fish and provide important coastal protection.')]);
  assert.equal(result.verdict, 'SUPPORTED');
  assert.deepEqual(result.passages.map((passage) => passage.text), ['Coral reefs support fish and provide important coastal protection.']);
  assert.equal(result.sourceUrl, url);
  assert.equal(result.sourceTitle, title);
  assert.match(result.basis, /not independent confirmation/);
});

test('related passage that omits part of the claim is partially supported', () => {
  const result = verifyClaim(claim('Coral reefs support fish, provide coastal protection, and create jobs for nearby communities.'), [page('Coral reefs support fish and help protect coastal areas.')]);
  assert.equal(result.verdict, 'PARTIALLY SUPPORTED');
  assert.equal(result.passages.length, 1);
});

test('same details with a conflicting numeric value are contradicted', () => {
  const result = verifyClaim(claim('The region recorded 2.4 degrees of warming.'), [page('The region recorded 1.4 degrees of warming.')]);
  assert.equal(result.verdict, 'CONTRADICTED');
  assert.equal(result.passages[0].text, 'The region recorded 1.4 degrees of warming.');
});

test('a source with no relevant passage yields insufficient evidence', () => {
  const result = verifyClaim(claim('Coral reefs support fish.'), [page('Mountain forests contain many plant species.')]);
  assert.equal(result.verdict, 'INSUFFICIENT EVIDENCE');
  assert.deepEqual(result.passages, []);
});

test('a missing or unavailable original source yields insufficient evidence', () => {
  assert.equal(verifyClaim(claim('Coral reefs support fish.'), []).verdict, 'INSUFFICIENT EVIDENCE');
  assert.equal(verifyClaim(claim('Coral reefs support fish.'), [{ ...page('Coral reefs support fish.'), error: 'unavailable' }]).verdict, 'INSUFFICIENT EVIDENCE');
});

test('a related page with another URL or title is never substituted for the original source', () => {
  assert.equal(verifyClaim(claim('Coral reefs support fish.'), [{ ...page('Coral reefs support fish.'), url: 'https://other.example/report' }]).verdict, 'INSUFFICIENT EVIDENCE');
  assert.equal(verifyClaim(claim('Coral reefs support fish.'), [{ ...page('Coral reefs support fish.'), title: 'Different report' }]).verdict, 'INSUFFICIENT EVIDENCE');
});

test('other fetched sources may support or contradict a claim while preserving each passage URL', () => {
  const other: FetchResult = { url: 'https://reef.example/second', title: 'Second report', text: 'Coral reefs support fish and provide important coastal protection.' };
  const supported = verifyClaim(claim('Coral reefs support fish and provide important coastal protection.'), [page('Original source text.'), other]);
  assert.equal(supported.verdict, 'SUPPORTED');
  assert.equal(supported.passages[0].sourceUrl, other.url);

  const conflicting: FetchResult = { ...other, text: 'Coral reefs do not support fish and provide important coastal protection.' };
  const disputed = verifyClaim(claim('Coral reefs support fish and provide important coastal protection.'), [page('Original source text.'), conflicting]);
  assert.equal(disputed.verdict, 'CONTRADICTED');
  assert.equal(disputed.passages[0].stance, 'contradicts');
  assert.equal(disputed.passages[0].sourceTitle, conflicting.title);
});

test('malformed verification request is rejected and a valid ID uses server-stored fetched content', () => {
  assert.equal(isValidVerificationRequest({ claims: [claim('Forged claim.')], pages: [page('Forged content')] }), false);
  assert.equal(isValidVerificationRequest({ verificationId: 'bad' }), false);
  const verificationId = createVerificationRecord([claim('Coral reefs support fish.')], [page('Coral reefs support fish.')]);
  assert.equal(isValidVerificationRequest({ verificationId }), true);
  assert.equal(verifyStoredClaims(verificationId)?.[0].verdict, 'SUPPORTED');
  assert.equal(verifyStoredClaims('invalid-id'), undefined);
});
