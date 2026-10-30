import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTinyFishOAuthProvider, getOAuthConfig, hasOAuthTokens, type TinyFishOAuthSession } from './tinyfish-oauth.js';
import { resolveTinyFishAuthSelection, TinyFishAuthConfigurationError, tinyFishApiKeyHeaders, type TinyFishAuthMode } from './tinyfish-auth.js';

type McpResult = { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
type FailureKind = 'configuration' | 'authentication' | 'upstream';

export class TinyFishError extends Error {
  constructor(message: string, readonly kind: FailureKind) {
    super(message);
    this.name = 'TinyFishError';
  }
}

export type SearchResult = { title: string; url: string; snippet: string };
export type FetchResult = { url: string; title: string; text: string; error?: string };

function getText(result: McpResult): string {
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return result.content?.map((part) => part.text ?? '').filter(Boolean).join('\n') ?? '';
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function collectObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(collectObjects);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  const own = ('url' in object || 'link' in object) ? [object] : [];
  return [...own, ...Object.values(object).flatMap(collectObjects)];
}

function extractSearchResults(raw: string): SearchResult[] {
  const objects = collectObjects(parseJson(raw));
  if (objects.length) {
    const seen = new Set<string>();
    return objects.flatMap((item) => {
      const url = String(item.url ?? item.link ?? '');
      if (!/^https?:\/\//i.test(url) || seen.has(url)) return [];
      seen.add(url);
      return [{ title: String(item.title ?? item.name ?? url), url, snippet: String(item.snippet ?? item.description ?? item.content ?? '') }];
    }).slice(0, 10);
  }
  const urls = [...raw.matchAll(/https?:\/\/[^\s<>"\])}]+/g)].map((match) => match[0].replace(/[.,;]$/, ''));
  return [...new Set(urls)].slice(0, 10).map((url) => ({ title: url, url, snippet: '' }));
}

function isAuthenticationFailure(error: unknown): boolean {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  const status = Number(candidate?.status ?? candidate?.code);
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  return status === 401 || status === 403 || isAuthenticationMessage(message);
}

function isAuthenticationMessage(message: string): boolean {
  return /\b401\b|\b403\b|unauthori[sz]ed|forbidden|authentication required|invalid (?:api )?key/i.test(message);
}

function safeErrorText(error: unknown, secrets: string[]): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  let safe = raw;
  for (const secret of secrets) if (secret.length >= 4) safe = safe.replaceAll(secret, '[redacted]');
  return safe
    .replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/(TINYFISH_[A-Z0-9_]*(?:TOKEN|SECRET|KEY)|(?:access|refresh)_token|client_secret)\s*[:=]\s*[^\s,;"']+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
}

export function normalizeTinyFishFailure(error: unknown, mode: TinyFishAuthMode, secrets: string[] = []): TinyFishError {
  if (error instanceof TinyFishError) return error;
  if (error instanceof TinyFishAuthConfigurationError) return new TinyFishError(error.message, 'configuration');
  const candidate = error as { status?: unknown; code?: unknown };
  const status = Number(candidate?.status ?? candidate?.code);
  const safe = safeErrorText(error, secrets);
  if (isAuthenticationFailure(error)) {
    const httpStatus = status === 401 || status === 403 ? ` (HTTP ${status})` : '';
    return new TinyFishError(
      mode === 'api_key'
        ? `TinyFish MCP rejected API-key authentication${httpStatus}${safe ? `: ${safe}` : '.'} Check TINYFISH_AUTH_MODE and the server-side API key, or explicitly configure OAuth mode.`
        : `TinyFish OAuth authentication failed${httpStatus}${safe ? `: ${safe}` : '. Sign in with TinyFish and retry.'}`,
      'authentication',
    );
  }
  return new TinyFishError(safe ? `TinyFish MCP request failed: ${safe}` : 'TinyFish request failed. Check the endpoint and server availability, then try again.', 'upstream');
}

function throwToolFailure(result: McpResult, tool: 'Search' | 'Fetch', mode: TinyFishAuthMode, secrets: string[]): never {
  const providerMessage = result.content?.map((part) => part.text ?? '').join('\n') ?? '';
  if (isAuthenticationMessage(providerMessage)) {
    const safe = safeErrorText(providerMessage, secrets);
    throw new TinyFishError(mode === 'api_key'
      ? `TinyFish MCP rejected API-key authentication: ${safe || 'unauthorized'}. Check the server-side API key or explicitly configure OAuth mode.`
      : `TinyFish OAuth authentication failed: ${safe || 'sign in again and retry.'}`, 'authentication');
  }
  throw new TinyFishError(`TinyFish ${tool} rejected the request. Check the input and endpoint permissions.`, 'upstream');
}

function getMcpUrl(): URL {
  const value = process.env.TINYFISH_MCP_URL?.trim() || 'https://agent.tinyfish.ai/mcp';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error();
    return url;
  } catch {
    throw new TinyFishAuthConfigurationError(process.env.NODE_ENV === 'production'
      ? 'TINYFISH_MCP_URL must be a valid HTTPS URL in production.'
      : 'TINYFISH_MCP_URL must be a valid HTTP or HTTPS URL.');
  }
}

function createClient(session: TinyFishOAuthSession | undefined, mode: TinyFishAuthMode) {
  const client = new Client({ name: 'proofscout-ai', version: '0.1.0' });
  if (mode === 'api_key') {
    const selection = resolveTinyFishAuthSelection();
    if (selection.mode !== 'api_key') throw new TinyFishAuthConfigurationError('API-key mode selection changed during the request.');
    const transport = new StreamableHTTPClientTransport(getMcpUrl(), { requestInit: { headers: tinyFishApiKeyHeaders(selection.apiKey) } });
    return { client, transport };
  }
  if (!session) throw new TinyFishError('Sign in with TinyFish OAuth before using Search or Fetch.', 'authentication');
  const config = getOAuthConfig();
  const provider = createTinyFishOAuthProvider(session, config);
  const transport = new StreamableHTTPClientTransport(config.mcpUrl, { authProvider: provider });
  return { client, transport };
}

async function withClient<T>(session: TinyFishOAuthSession | undefined, operation: (client: Client) => Promise<T>): Promise<T> {
  let mode: TinyFishAuthMode = 'oauth';
  let pair: ReturnType<typeof createClient> | undefined;
  let secrets = [
    process.env.TINYFISH_MCP_TOKEN,
    process.env.TINYFISH_OAUTH_CLIENT_SECRET,
    session?.tokens?.access_token,
    session?.tokens?.refresh_token,
    session?.clientInformation && 'client_secret' in session.clientInformation ? session.clientInformation.client_secret : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  try {
    const selection = resolveTinyFishAuthSelection();
    mode = selection.mode;
    if (selection.mode === 'oauth' && !hasOAuthTokens(session)) throw new TinyFishError('Sign in with TinyFish OAuth before using Search or Fetch.', 'authentication');
    pair = createClient(session, selection.mode);
    await pair.client.connect(pair.transport);
    return await operation(pair.client);
  } catch (error) {
    throw normalizeTinyFishFailure(error, mode, secrets);
  } finally {
    await pair?.client.close().catch(() => undefined);
  }
}

async function findTool(client: Client, suffix: string): Promise<string> {
  const { tools } = await client.listTools();
  const match = tools.find((tool) => tool.name === suffix) ?? tools.find((tool) => tool.name.endsWith(`__${suffix}`));
  if (!match) throw new TinyFishError(`TinyFish MCP server does not expose the required ${suffix} tool.`, 'upstream');
  return match.name;
}

export async function checkTinyFishHealth(session: TinyFishOAuthSession | undefined): Promise<{ configured: true; authenticated: true; tools: string[] }> {
  return withClient(session, async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    const hasTool = (suffix: string) => names.some((name) => name === suffix || name.endsWith(`__${suffix}`));
    const missing = ['search', 'fetch_content'].filter((tool) => !hasTool(tool));
    if (missing.length) throw new TinyFishError(`TinyFish MCP server is reachable but is missing required tool(s): ${missing.join(', ')}.`, 'upstream');
    return { configured: true, authenticated: true, tools: ['search', 'fetch_content'] };
  });
}

export async function beginTinyFishAuthorization(session: TinyFishOAuthSession): Promise<{ authorizationUrl?: URL; connected?: true }> {
  const selection = resolveTinyFishAuthSelection();
  if (selection.mode !== 'oauth') throw new TinyFishError('OAuth sign-in is unavailable while API-key mode is selected.', 'configuration');
  const { client, transport } = createClient(session, selection.mode);
  try {
    await client.connect(transport);
    if (!hasOAuthTokens(session)) throw new TinyFishError('TinyFish MCP did not require sign-in and issued no OAuth token; no authenticated connection was established.', 'authentication');
    await verifyExpectedTools(client);
    return { connected: true };
  } catch (error) {
    if (session.authorizationUrl) return { authorizationUrl: session.authorizationUrl };
    throw normalizeTinyFishFailure(error, selection.mode, [session.tokens?.access_token, session.tokens?.refresh_token, session.clientInformation && 'client_secret' in session.clientInformation ? session.clientInformation.client_secret : undefined].filter((value): value is string => typeof value === 'string'));
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function verifyExpectedTools(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  const missing = ['search', 'fetch_content'].filter((tool) => !names.some((name) => name === tool || name.endsWith(`__${tool}`)));
  if (missing.length) throw new TinyFishError(`TinyFish MCP is authenticated but missing required tool(s): ${missing.join(', ')}.`, 'upstream');
}

export async function completeTinyFishAuthorization(session: TinyFishOAuthSession, code: string): Promise<void> {
  const selection = resolveTinyFishAuthSelection();
  if (selection.mode !== 'oauth') throw new TinyFishError('OAuth callback is unavailable while API-key mode is selected.', 'configuration');
  const { client, transport } = createClient(session, selection.mode);
  try {
    await transport.finishAuth(code);
    session.codeVerifier = undefined;
    if (!hasOAuthTokens(session)) throw new TinyFishError('TinyFish OAuth returned no access token.', 'authentication');
    await client.connect(transport);
    await verifyExpectedTools(client);
  } catch (error) {
    throw normalizeTinyFishFailure(error, selection.mode, [process.env.TINYFISH_OAUTH_CLIENT_SECRET, session.tokens?.access_token, session.tokens?.refresh_token, session.clientInformation && 'client_secret' in session.clientInformation ? session.clientInformation.client_secret : undefined].filter((value): value is string => typeof value === 'string' && value.length > 0));
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function searchWeb(query: string, session: TinyFishOAuthSession | undefined, signal?: AbortSignal): Promise<SearchResult[]> {
  return withClient(session, async (client) => {
    const toolName = await findTool(client, 'search');
    const result = await client.callTool({ name: toolName, arguments: { query, purpose: 'Find relevant live webpages to support a research question.' } }, undefined, signal ? { signal } : undefined) as McpResult;
    if (result.isError) throwToolFailure(result, 'Search', resolveTinyFishAuthSelection().mode, [process.env.TINYFISH_MCP_TOKEN ?? '', session?.tokens?.access_token ?? '', session?.tokens?.refresh_token ?? '']);
    const results = extractSearchResults(getText(result));
    if (!results.length) throw new TinyFishError('TinyFish Search returned no usable webpage URLs. Try a more specific question.', 'upstream');
    return results;
  });
}

export function associateFetchedPages(urls: string[], result: McpResult): FetchResult[] {
  const raw = result.structuredContent !== undefined
    ? JSON.stringify(result.structuredContent)
    : result.content?.map((part) => part.text ?? '').join('\n') ?? '';
  const rows = collectObjects(result.structuredContent ?? parseJson(raw));
  return urls.map((url) => {
    const row = rows.find((item) => String(item.url ?? item.source_url ?? '') === url);
    if (!row) return { url, title: url, text: '', error: 'TinyFish response did not include a reliably matched result for this URL.' };
    const text = String(row.content ?? row.text ?? row.markdown ?? row.body ?? '');
    const error = row.error ? String(row.error) : row.status === 'error' ? 'This source could not be fetched.' : !text.trim() ? 'TinyFish returned no content for this URL.' : undefined;
    return { url, title: String(row.title ?? url), text: error ? '' : text.slice(0, 12000), ...(error ? { error } : {}) };
  });
}

export async function fetchPagesForQuery(query: string, urls: string[], request: (arguments_: Record<string, unknown>) => Promise<McpResult>, signal?: AbortSignal): Promise<FetchResult[]> {
  const result = await request({
    query, urls, format: 'markdown', links: false, image_links: false, iframe_links: false, page_metadata: true,
    purpose: 'Extract factual evidence relevant to the user’s research question.',
  });
  if (signal?.aborted) throw new TinyFishError('TinyFish Fetch request was cancelled.', 'upstream');
  if (result.isError) throw new TinyFishError('TinyFish Fetch rejected the request.', 'upstream');
  return associateFetchedPages(urls, result);
}

export async function fetchPages(query: string, urls: string[], session: TinyFishOAuthSession | undefined, signal?: AbortSignal): Promise<FetchResult[]> {
  return withClient(session, async (client) => {
    const toolName = await findTool(client, 'fetch_content');
    return fetchPagesForQuery(query, urls, async (arguments_) => client.callTool({ name: toolName, arguments: arguments_ }, undefined, signal ? { signal } : undefined) as Promise<McpResult>, signal);
  });
}

export function tinyFishHttpStatus(error: unknown): number {
  const normalized = normalizeTinyFishFailure(error, 'oauth');
  return normalized.kind === 'configuration' ? 503 : normalized.kind === 'authentication' ? 401 : 502;
}
