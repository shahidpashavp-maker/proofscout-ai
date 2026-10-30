import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { beginTinyFishAuthorization, checkTinyFishHealth, completeTinyFishAuthorization, fetchPages, searchWeb, tinyFishHttpStatus } from './tinyfish.js';
import { buildEvidence } from './evidence.js';
import verificationRouter from './routes/verification.js';
import { createVerificationRecord } from './services/verification.js';
import comparisonRouter from './routes/comparison.js';
import projectsRouter from './routes/projects.js';
import monitoringRouter from './routes/monitoring.js';
import { db } from './database/db.js';
import { startMonitoringScheduler } from './services/monitor-scheduler.js';
import { createRequestLimiter } from './middleware/request-limits.js';
import { fetchClientKey, isRecentSearchResult, isSafePublicWebUrl, rememberSearchResults } from './services/fetch-policy.js';
import { consumeOAuthState, createSession, getOAuthConfig, hasOAuthTokens, readSession } from './tinyfish-oauth.js';
import { getSelectedTinyFishAuthMode, resolveTinyFishAuthSelection } from './tinyfish-auth.js';

const app = express();
const appOriginValue = process.env.PROOFSCOUT_APP_URL?.trim() || 'http://localhost:5173';
let configuredAppOrigin = 'http://localhost:5173';
try { configuredAppOrigin = new URL(appOriginValue).origin; } catch { /* OAuth configuration validation reports malformed deployment URLs. */ }
const allowedOrigins = new Set([configuredAppOrigin]);
if (process.env.NODE_ENV !== 'production' && configuredAppOrigin === 'http://localhost:5173') allowedOrigins.add('http://127.0.0.1:5173');
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Cross-origin request denied.'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '32kb' }));
app.use('/api', createRequestLimiter('api', 300, 60_000));
app.use('/api/search', createRequestLimiter('search', 20, 60_000));
app.use('/api/fetch', createRequestLimiter('fetch', 12, 60_000));
app.use('/api/auth', createRequestLimiter('auth', 12, 60_000));
app.use('/api/monitoring', createRequestLimiter('monitoring', 40, 60_000));
app.use('/api', verificationRouter);
app.use('/api', comparisonRouter);
app.use('/api', projectsRouter);
app.use('/api', monitoringRouter);

app.get('/api/auth/tinyfish/status', async (request, response) => {
  let mode;
  try { mode = getSelectedTinyFishAuthMode(); }
  catch (error) { return response.status(503).json({ mode: null, configured: false, connected: false, error: error instanceof Error ? error.message : 'TinyFish authentication mode is invalid.' }); }
  try { resolveTinyFishAuthSelection(); }
  catch (error) { return response.json({ mode, configured: false, connected: false, error: error instanceof Error ? error.message : 'TinyFish authentication credentials are incomplete.' }); }
  if (mode === 'oauth') {
    try { getOAuthConfig(); }
    catch (error) { return response.json({ mode, configured: false, connected: false, error: error instanceof Error ? error.message : 'TinyFish OAuth configuration is incomplete.' }); }
  }
  if (mode === 'api_key') {
    try {
      const tinyfish = await checkTinyFishHealth(undefined);
      return response.json({ mode, configured: true, connected: true, tools: tinyfish.tools });
    } catch (error) {
      return response.status(tinyFishHttpStatus(error)).json({ mode, configured: true, connected: false, error: error instanceof Error ? error.message : 'TinyFish MCP verification failed.' });
    }
  }
  const session = readSession(request.headers.cookie);
  if (!hasOAuthTokens(session)) return response.json({ mode, configured: true, connected: false });
  try {
    const tinyfish = await checkTinyFishHealth(session);
    return response.json({ mode, configured: true, connected: true, tools: tinyfish.tools });
  } catch (error) {
    return response.status(tinyFishHttpStatus(error)).json({ mode, configured: true, connected: false, error: error instanceof Error ? error.message : 'TinyFish MCP verification failed.' });
  }
});

app.get('/api/auth/tinyfish', async (request, response) => {
  const jsonResponse = request.query.format === 'json';
  try {
    if (getSelectedTinyFishAuthMode() === 'api_key') {
      const error = 'TinyFish API-key mode is selected. OAuth sign-in is disabled; set TINYFISH_AUTH_MODE=oauth to use OAuth.';
      return response.status(409).json({ error });
    }
    resolveTinyFishAuthSelection();
    const session = readSession(request.headers.cookie) ?? createSession(response);
    const result = await beginTinyFishAuthorization(session);
    if (result.authorizationUrl) return jsonResponse
      ? response.json({ authorizationUrl: result.authorizationUrl.href })
      : response.redirect(302, result.authorizationUrl.href);
    if (result.connected) return jsonResponse
      ? response.json({ connected: true })
      : response.redirect(302, '/?tinyfish=connected');
    return response.status(502).json({ error: 'TinyFish did not start an OAuth authorization flow.' });
  } catch (error) {
    return response.status(tinyFishHttpStatus(error)).json({ error: error instanceof Error ? error.message : 'Could not start TinyFish OAuth sign-in.' });
  }
});

app.get('/api/auth/tinyfish/callback', async (request, response) => {
  if (getSelectedTinyFishAuthMode() !== 'oauth') return response.status(409).send('TinyFish OAuth callback is unavailable while API-key mode is selected.');
  const session = readSession(request.headers.cookie);
  if (!session || !consumeOAuthState(session, request.query.state)) {
    return response.status(400).send('TinyFish OAuth state validation failed. Start sign-in again.');
  }
  const appUrl = getOAuthConfig().appUrl;
  if (typeof request.query.error === 'string') {
    session.codeVerifier = undefined;
    appUrl.searchParams.set('tinyfish_error', 'authorization_denied');
    return response.redirect(302, appUrl.href);
  }
  if (typeof request.query.code !== 'string' || !request.query.code || request.query.code.length > 4096) {
    session.codeVerifier = undefined;
    appUrl.searchParams.set('tinyfish_error', 'missing_authorization_code');
    return response.redirect(302, appUrl.href);
  }
  try {
    await completeTinyFishAuthorization(session, request.query.code);
    session.expectedState = undefined;
    session.authorizationUrl = undefined;
    appUrl.searchParams.set('tinyfish', 'connected');
    return response.redirect(302, appUrl.href);
  } catch {
    session.codeVerifier = undefined;
    session.authorizationUrl = undefined;
    appUrl.searchParams.set('tinyfish_error', 'oauth_or_mcp_verification_failed');
    return response.redirect(302, appUrl.href);
  }
});

app.get('/api/health', async (_request, response) => {
  return response.json({ status: 'ok', api: 'ok', tinyfish: { status: 'session_required' } });
});

app.post('/api/search', async (request, response) => {
  const query = typeof request.body?.query === 'string' ? request.body.query.trim() : '';
  if (query.length < 3 || query.length > 500) return response.status(400).json({ error: 'Enter a question between 3 and 500 characters.' });
  try {
    const results = (await searchWeb(query, readSession(request.headers.cookie))).filter((item) => isSafePublicWebUrl(item.url));
    if (!results.length) return response.status(502).json({ error: 'TinyFish Search returned no safe, usable public webpage URLs.' });
    rememberSearchResults(fetchClientKey(request), results.map((item) => item.url));
    return response.json({ results });
  }
  catch (error) { return response.status(tinyFishHttpStatus(error)).json({ error: error instanceof Error ? error.message : 'TinyFish Search failed.' }); }
});

app.post('/api/fetch', async (request, response) => {
  const query = typeof request.body?.query === 'string' ? request.body.query.trim() : '';
  const urls = Array.isArray(request.body?.urls) ? request.body.urls : [];
  if (query.length < 3 || query.length > 500) return response.status(400).json({ error: 'Include a question between 3 and 500 characters.' });
  if (!urls.length || urls.length > 10 || urls.some((item: unknown) => !isSafePublicWebUrl(item))) {
    return response.status(400).json({ error: 'Select between 1 and 10 valid webpage URLs.' });
  }
  const clientKey = fetchClientKey(request);
  if (urls.some((url: string) => !isRecentSearchResult(clientKey, url))) return response.status(400).json({ error: 'Select sources from a recent Search result before fetching content.' });
  try {
    const pages = await fetchPages(query, urls as string[], readSession(request.headers.cookie));
    const evidence = buildEvidence(pages);
    return response.json({ pages, evidence, verificationId: createVerificationRecord(evidence, pages, query) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'TinyFish Fetch failed.';
    return response.status(tinyFishHttpStatus(error)).json({ error: message });
  }
});

const port = Number(process.env.PORT) || 3001;
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const details = error as { message?: unknown; status?: unknown; type?: unknown };
  if (details?.message === 'Cross-origin request denied.') return response.status(403).json({ error: 'Origin not allowed.' });
  if (details?.type === 'entity.parse.failed') return response.status(400).json({ error: 'Request body must contain valid JSON.' });
  if (details?.type === 'entity.too.large') return response.status(413).json({ error: 'Request body exceeds the 32 KB limit.' });
  const status = Number(details?.status);
  return response.status(status >= 400 && status < 500 ? status : 500).json({ error: status === 413 ? 'Request body exceeds the configured limit.' : 'The API could not complete this request.' });
});
app.listen(port, () => {
  startMonitoringScheduler(db);
  console.log(`ProofScout API listening on http://localhost:${port}`);
});
