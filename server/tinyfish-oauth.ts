import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { TinyFishAuthConfigurationError } from './tinyfish-auth.js';

export const SESSION_COOKIE = 'proofscout_session';
const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const sessions = new Map<string, TinyFishOAuthSession>();

export type TinyFishOAuthSession = {
  id: string;
  touchedAt: number;
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  expectedState?: string;
  authorizationUrl?: URL;
};

export type OAuthConfig = {
  mcpUrl: URL;
  redirectUri: URL;
  appUrl: URL;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
};

export function getOAuthConfig(): OAuthConfig {
  const clientId = process.env.TINYFISH_OAUTH_CLIENT_ID?.trim();
  const redirectValue = process.env.TINYFISH_OAUTH_REDIRECT_URI?.trim();
  const tokenEndpointAuthMethod = process.env.TINYFISH_OAUTH_TOKEN_ENDPOINT_AUTH_METHOD?.trim();
  const clientSecret = process.env.TINYFISH_OAUTH_CLIENT_SECRET?.trim() || undefined;
  const mcpValue = process.env.TINYFISH_MCP_URL?.trim() || 'https://agent.tinyfish.ai/mcp';
  const appValue = process.env.PROOFSCOUT_APP_URL?.trim() || 'http://localhost:5173';

  if (!clientId || !redirectValue || !tokenEndpointAuthMethod) {
    throw new TinyFishAuthConfigurationError('TinyFish OAuth is not configured. Set TINYFISH_OAUTH_CLIENT_ID, TINYFISH_OAUTH_REDIRECT_URI, and TINYFISH_OAUTH_TOKEN_ENDPOINT_AUTH_METHOD after registering an OAuth client with TinyFish.');
  }
  if (!['none', 'client_secret_basic', 'client_secret_post'].includes(tokenEndpointAuthMethod)) {
    throw new TinyFishAuthConfigurationError('TINYFISH_OAUTH_TOKEN_ENDPOINT_AUTH_METHOD must match the method registered for the TinyFish OAuth client.');
  }
  if (tokenEndpointAuthMethod !== 'none' && !clientSecret) {
    throw new TinyFishAuthConfigurationError('TinyFish OAuth client secret is required for the configured token endpoint authentication method.');
  }

  let mcpUrl: URL;
  let redirectUri: URL;
  let appUrl: URL;
  try {
    mcpUrl = new URL(mcpValue);
    redirectUri = new URL(redirectValue);
    appUrl = new URL(appValue);
    if (![mcpUrl, redirectUri, appUrl].every((url) => ['http:', 'https:'].includes(url.protocol))) throw new Error();
  } catch {
    throw new TinyFishAuthConfigurationError('TinyFish OAuth endpoint and redirect URI must be valid HTTP or HTTPS URLs.');
  }
  if (process.env.NODE_ENV === 'production' && [mcpUrl, redirectUri, appUrl].some((url) => url.protocol !== 'https:')) {
    throw new TinyFishAuthConfigurationError('TinyFish OAuth requires HTTPS MCP, callback, and app URLs in production.');
  }
  return { mcpUrl, redirectUri, appUrl, clientId, clientSecret, tokenEndpointAuthMethod: tokenEndpointAuthMethod as OAuthConfig['tokenEndpointAuthMethod'] };
}

function pruneSessions(now = Date.now()) {
  for (const [id, session] of sessions) if (now - session.touchedAt > SESSION_MAX_AGE_MS) sessions.delete(id);
}

export function readSession(cookieHeader?: string): TinyFishOAuthSession | undefined {
  const raw = cookieHeader?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!raw || !/^[A-Za-z0-9_-]{40,60}$/.test(raw)) return undefined;
  pruneSessions();
  const session = sessions.get(raw);
  if (session) session.touchedAt = Date.now();
  return session;
}

export function createSession(response: Response): TinyFishOAuthSession {
  pruneSessions();
  const id = randomBytes(32).toString('base64url');
  const session: TinyFishOAuthSession = { id, touchedAt: Date.now() };
  sessions.set(id, session);
  response.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  });
  return session;
}

export function getOrCreateSession(request: Request, response: Response): TinyFishOAuthSession {
  return readSession(request.headers.cookie) ?? createSession(response);
}

export function clearSession(response: Response, session: TinyFishOAuthSession) {
  sessions.delete(session.id);
  response.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
}

export function validateOAuthState(expected: string | undefined, supplied: unknown): boolean {
  if (!expected || typeof supplied !== 'string' || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export function consumeOAuthState(session: TinyFishOAuthSession, supplied: unknown): boolean {
  if (!validateOAuthState(session.expectedState, supplied)) return false;
  session.expectedState = undefined;
  return true;
}

export function createTinyFishOAuthProvider(session: TinyFishOAuthSession, config = getOAuthConfig()): OAuthClientProvider {
  const clientMetadata: OAuthClientMetadata = {
    client_name: 'ProofScout AI',
    redirect_uris: [config.redirectUri.href],
    response_types: ['code'],
    grant_types: ['authorization_code'],
    token_endpoint_auth_method: config.tokenEndpointAuthMethod,
  };
  return {
    get redirectUrl() { return config.redirectUri; },
    get clientMetadata() { return clientMetadata; },
    state: () => {
      session.expectedState = randomBytes(32).toString('base64url');
      session.authorizationUrl = undefined;
      return session.expectedState;
    },
    clientInformation: () => session.clientInformation ?? {
      client_id: config.clientId,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      token_endpoint_auth_method: config.tokenEndpointAuthMethod,
    },
    saveClientInformation: (information) => { session.clientInformation = information; },
    tokens: () => session.tokens,
    saveTokens: (tokens) => { session.tokens = tokens; },
    saveCodeVerifier: (verifier) => { session.codeVerifier = verifier; },
    codeVerifier: () => {
      if (!session.codeVerifier) throw new Error('TinyFish OAuth PKCE verifier is missing or expired. Start sign-in again.');
      return session.codeVerifier;
    },
    redirectToAuthorization: (url) => { session.authorizationUrl = url; },
  };
}

export function hasOAuthTokens(session: TinyFishOAuthSession | undefined): session is TinyFishOAuthSession & { tokens: OAuthTokens } {
  return Boolean(session?.tokens?.access_token);
}
