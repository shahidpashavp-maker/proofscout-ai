import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeOAuthState, validateOAuthState } from './tinyfish-oauth.js';

test('OAuth callback rejects a missing state', () => {
  assert.equal(validateOAuthState('state-from-start', undefined), false);
});

test('OAuth callback rejects a mismatched state', () => {
  assert.equal(validateOAuthState('state-from-start', 'attacker-state'), false);
});

test('OAuth callback accepts only the matching one-time state value', () => {
  const expected = 'bC1xX0jR7ERmP5j_fmvGKGWX0kFQfC-eC8N_tSZbhxA';
  const session = { id: 'test-session', touchedAt: Date.now(), expectedState: expected };
  assert.equal(consumeOAuthState(session, expected), true);
  assert.equal(session.expectedState, undefined);
  assert.equal(consumeOAuthState(session, expected), false);
});
