import assert from 'node:assert/strict';
import test from 'node:test';
import { getSelectedTinyFishAuthMode, resolveTinyFishAuthSelection, TinyFishAuthConfigurationError, tinyFishApiKeyHeaders } from './tinyfish-auth.js';
import { normalizeTinyFishFailure } from './tinyfish.js';

test('OAuth remains the default mode when no API key is configured', () => {
  assert.equal(getSelectedTinyFishAuthMode({}), 'oauth');
  assert.deepEqual(resolveTinyFishAuthSelection({}), { mode: 'oauth' });
});

test('API-key mode requires explicit selection and a configured key', () => {
  assert.throws(
    () => resolveTinyFishAuthSelection({ TINYFISH_AUTH_MODE: 'api_key' }),
    (error: unknown) => error instanceof TinyFishAuthConfigurationError && /TINYFISH_MCP_TOKEN is not configured/.test(error.message),
  );
  assert.deepEqual(
    resolveTinyFishAuthSelection({ TINYFISH_AUTH_MODE: 'api_key', TINYFISH_MCP_TOKEN: 'fake-test-key-123' }),
    { mode: 'api_key', apiKey: 'fake-test-key-123' },
  );
});

test('API-key mode uses Bearer Authorization and never X-API-Key on MCP', () => {
  const headers = tinyFishApiKeyHeaders('fake-test-key-123');
  assert.equal(headers.Authorization, 'Bearer fake-test-key-123');
  assert.equal('X-API-Key' in headers, false);
});

test('API key conflicts with the default or explicit OAuth mode instead of switching silently', () => {
  for (const environment of [
    { TINYFISH_MCP_TOKEN: 'fake-test-key-123' },
    { TINYFISH_AUTH_MODE: 'oauth', TINYFISH_MCP_TOKEN: 'fake-test-key-123' },
  ]) {
    assert.throws(
      () => resolveTinyFishAuthSelection(environment),
      (error: unknown) => error instanceof TinyFishAuthConfigurationError && /OAuth mode is selected/.test(error.message),
    );
  }
});

test('invalid authentication modes are rejected without echoing credentials', () => {
  const fakeKey = 'fake-test-key-123';
  assert.throws(
    () => resolveTinyFishAuthSelection({ TINYFISH_AUTH_MODE: 'fallback', TINYFISH_MCP_TOKEN: fakeKey }),
    (error: unknown) => error instanceof TinyFishAuthConfigurationError && !error.message.includes(fakeKey),
  );
});

test('API-key authentication failures preserve safe detail and redact bearer credentials', () => {
  const fakeKey = 'fake-test-key-123';
  const failure = normalizeTinyFishFailure(new Error(`HTTP 401 Unauthorized: Authorization: Bearer ${fakeKey}`), 'api_key', [fakeKey]);
  assert.equal(failure.kind, 'authentication');
  assert.match(failure.message, /HTTP 401/);
  assert.match(failure.message, /Bearer \[redacted\]/);
  assert.doesNotMatch(failure.message, /fake-test-key-123/);
});
