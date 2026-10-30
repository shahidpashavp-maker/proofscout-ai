import assert from 'node:assert/strict';
import test from 'node:test';
import { isRecentSearchResult, isSafePublicWebUrl, rememberSearchResults } from './services/fetch-policy.js';

test('fetch policy allows public HTTP(S) domains and rejects local, literal-IP, credential and unusual-port URLs', () => {
  assert.equal(isSafePublicWebUrl('https://www.statice.is/statistics/population/'), true);
  assert.equal(isSafePublicWebUrl('http://docs.example/resource'), false);
  assert.equal(isSafePublicWebUrl('http://localhost/admin'), false);
  assert.equal(isSafePublicWebUrl('http://127.0.0.1/'), false);
  assert.equal(isSafePublicWebUrl('http://2130706433/'), false);
  assert.equal(isSafePublicWebUrl('http://[::1]/'), false);
  assert.equal(isSafePublicWebUrl('https://metadata.google.internal/'), false);
  assert.equal(isSafePublicWebUrl('https://user:pass@public.example.com/'), false);
  assert.equal(isSafePublicWebUrl('https://public.example.com:8443/'), false);
  assert.equal(isSafePublicWebUrl('javascript:alert(1)'), false);
});

test('fetch policy permits only URLs returned by a recent search for the same client', () => {
  const client = `policy-test-${Math.random()}`;
  const now = 1_700_000_000_000;
  rememberSearchResults(client, ['https://www.statice.is/path#section'], now);
  rememberSearchResults(client, ['https://www.worldometers.info/country/iceland/'], now + 1);
  assert.equal(isRecentSearchResult(client, 'https://www.statice.is/path', now + 1), true);
  assert.equal(isRecentSearchResult(client, 'https://www.worldometers.info/country/iceland/', now + 1), true);
  assert.equal(isRecentSearchResult(client, 'https://www.unrelated.example.com/', now + 1), false);
  assert.equal(isRecentSearchResult(client, 'https://www.statice.is/path', now + 20 * 60_000 + 2), false);
});
