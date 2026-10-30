import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';

const SEARCH_RESULT_TTL_MS = 20 * 60_000;
const MAX_SEARCH_CLIENTS = 500;
const MAX_SEARCH_URLS_PER_CLIENT = 200;
const searchedUrls = new Map<string, { expiresAt: number; urls: Set<string> }>();

export function isSafePublicWebUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  if (url.port && !((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443'))) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) !== 0) return false;
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return false;
  if (['localhost', 'local', 'internal', 'test', 'invalid', 'example'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return false;
  return true;
}

export function fetchClientKey(request: Pick<Request, 'ip' | 'headers'>): string {
  return createHash('sha256').update(`${request.ip}\n${request.headers['user-agent'] ?? ''}`).digest('hex');
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

export function rememberSearchResults(clientKey: string, urls: string[], now = Date.now()): void {
  for (const [key, value] of searchedUrls) if (value.expiresAt <= now) searchedUrls.delete(key);
  while (searchedUrls.size >= MAX_SEARCH_CLIENTS) {
    const oldest = searchedUrls.keys().next().value;
    if (!oldest) break;
    searchedUrls.delete(oldest);
  }
  const existing = searchedUrls.get(clientKey);
  const combined = new Set([...(existing && existing.expiresAt > now ? existing.urls : []), ...urls.filter(isSafePublicWebUrl).map(canonicalUrl)]);
  while (combined.size > MAX_SEARCH_URLS_PER_CLIENT) combined.delete(combined.values().next().value!);
  searchedUrls.set(clientKey, { expiresAt: now + SEARCH_RESULT_TTL_MS, urls: combined });
}

export function isRecentSearchResult(clientKey: string, url: string, now = Date.now()): boolean {
  const record = searchedUrls.get(clientKey);
  if (!record || record.expiresAt <= now) {
    searchedUrls.delete(clientKey);
    return false;
  }
  return isSafePublicWebUrl(url) && record.urls.has(canonicalUrl(url));
}
