# ProofScout AI

Evidence-backed live web research using TinyFish MCP Search and Fetch.

## Requirements

- Node.js 20 or newer
- Research history is stored in `data/proofscout.sqlite` using SQLite. Set `PROOFSCOUT_DB_PATH` to change its location.
- A TinyFish MCP endpoint that exposes `search` and `fetch_content`
- An authentication method supported by that endpoint

## Run on Windows

Open PowerShell in this folder:

```powershell
npm install
Copy-Item .env.example .env
```

The example uses TinyFish's documented MCP endpoint, `https://agent.tinyfish.ai/mcp`. Replace it only if your environment provides a different endpoint. The selected auth mode and credentials are server-side; `.env` is ignored by Git. `TINYFISH_AUTH_MODE` selects one auth path: `oauth` (default) or `api_key`. The app never falls back between them.

The standard MCP auth mode is TinyFish OAuth 2.1. TinyFish's published docs describe browser sign-in but do not publish a client-registration process, authorization or token endpoint URLs, or supported token endpoint authentication methods. This app therefore uses a pre-registered client ID and does not attempt dynamic client registration.

### Required TinyFish-side setup

1. Ask TinyFish support to register an OAuth client for ProofScout; the published docs do not identify a self-service registration page.
2. Provide this exact local redirect URI: `http://localhost:3001/api/auth/tinyfish/callback`.
3. Ask TinyFish to confirm that the client supports the authorization-code flow with S256 PKCE, and whether token requests use `none`, `client_secret_basic`, or `client_secret_post`. The MCP SDK generates S256 PKCE; the provider must support it.
4. Obtain the client ID and, only if the provider registers a confidential client, its client secret. Do not proceed if TinyFish does not support the configured callback or client authentication method.

After TinyFish provides the registration details, copy `.env.example` to `.env` and set `TINYFISH_OAUTH_CLIENT_ID`, `TINYFISH_OAUTH_TOKEN_ENDPOINT_AUTH_METHOD` (`none`, `client_secret_basic`, or `client_secret_post` as confirmed by TinyFish), and `TINYFISH_OAUTH_CLIENT_SECRET` only if the registered method requires it. Keep all values in the ignored server-side `.env` file. For deployment, use HTTPS for the MCP URL, app URL, and registered redirect URI; set `PROOFSCOUT_APP_URL` and `TINYFISH_OAUTH_REDIRECT_URI` to the deployment's exact origins and callback path.

The SDK performs OAuth metadata discovery, authorization code exchange, PKCE, and refresh when the authorization server publishes a refresh token. ProofScout validates the returned state against its server-side session, keeps OAuth tokens and PKCE material in server memory, and only reports connected after an authenticated `listTools` MCP request confirms both `search` and `fetch_content`. Sessions are cleared when the API process restarts.

### Optional API-key mode

TinyFish's MCP Integration guide documents Command Code connecting to `https://agent.tinyfish.ai/mcp` with `Authorization: Bearer <API key>`. This is an API key in a Bearer header, not an OAuth access token, and TinyFish does not guarantee that every custom MCP client accepts this mode. ProofScout sends `TINYFISH_MCP_TOKEN` as that Bearer header only when `TINYFISH_AUTH_MODE=api_key`; it never sends `X-API-Key` to the MCP endpoint. TinyFish documents `X-API-Key` for REST API requests instead. Verify compatibility using the app status, which performs an authenticated MCP `listTools` request and requires both `search` and `fetch_content` before reporting connected.

To select API-key mode, set `TINYFISH_AUTH_MODE=api_key` and `TINYFISH_MCP_TOKEN` in the ignored `.env` file. Keep `TINYFISH_MCP_TOKEN` empty in `.env.example` and never put a real key in frontend variables or source control. If API-key mode is selected without a key, the app reports a configuration error. If the key is rejected, it reports a sanitized MCP error and does not start OAuth automatically. To switch back, set `TINYFISH_AUTH_MODE=oauth`, remove `TINYFISH_MCP_TOKEN`, configure the OAuth client values above, and restart the backend. A token present while OAuth mode is selected is treated as a configuration conflict rather than ignored.

Start both the API and UI in development:

```powershell
npm run dev
```

Open Vite's local URL (normally `http://localhost:5173`). The Express API listens on `http://localhost:3001`.

For a no-Search/no-Fetch connectivity check, request:

```powershell
Invoke-RestMethod http://localhost:3001/api/health
```

This endpoint reports API availability only. Use the app's connection status to check the current browser session; it performs an authenticated MCP `listTools` request and reports connected only when the required tools are present.

If PowerShell blocks `npm.ps1`, use the Windows command shim:

```powershell
npm.cmd install
npm.cmd run dev
```

## API flow and schemas

The browser sends `POST /api/search` with `{ "query": "..." }`. The server discovers the MCP `search` tool and calls it with `query` and `purpose`; it returns `{ "results": [{ "title": "...", "url": "https://...", "snippet": "..." }] }`.

The user selects up to ten URLs. The browser sends `POST /api/fetch` with `{ "urls": ["https://..."] }`. The server discovers `fetch_content` and calls it with `urls`, `format: "markdown"`, extraction flags, and `purpose`; it returns `{ "pages": [{ "url": "...", "title": "...", "text": "...", "error": "optional" }], "evidence": [...] }`. Tool arguments and extraction options follow the TinyFish MCP tool schemas; the server accepts structured MCP results and maps them to the UI's response shape.

The fetch response also includes a short-lived `verificationId`. `POST /api/verify` accepts `{ "verificationId": "..." }` and returns `{ "results": [...] }`. The server verifies its stored extracted claims against the fetched page text, preserving each claim's source URL/title and each evidence passage's own URL/title. Verification records expire after 20 minutes and are held in process memory.

`POST /api/compare` accepts the same `{ "verificationId": "..." }` and returns `{ "comparisons": [...] }`. It compares related claims across the fetched pages, retains each passage's provenance, and treats detected copies as a single source. Its agreement and disagreement labels are heuristic comparisons, not conclusions about objective truth.

Research history is managed through `GET /api/projects`, `POST /api/projects` (`{ "name": "..." }`), `PATCH /api/projects/:projectId` (`{ "name": "..." }`), and `DELETE /api/projects/:projectId`. Project sessions are listed at `GET /api/projects/:projectId/sessions`; save the current fetched research with `POST /api/projects/:projectId/sessions` (`{ "verificationId": "..." }`) and reopen one with `GET /api/projects/:projectId/sessions/:sessionId`. Saved sessions include the question, fetched source text and provenance, extracted claims, verification results, comparison results, and creation/update timestamps. SQLite uses parameterized statements and project deletion cascades to its saved sessions.

Configuration and authentication errors are reported without returning OAuth tokens, authorization headers, or client secrets. The browser receives only connection state and safe error text.

## How evidence is presented

1. The UI submits a question to the local Express API.
2. The server connects to TinyFish over MCP and calls `search`.
3. The user chooses up to ten discovered pages; the server calls `fetch_content` for them.
4. Extracted sentences appear with their source links. Possible conflicts are heuristic flags based on differing numeric or date-like evidence among claims with similar leading words. Both claims remain visible.
5. Per-page extraction failures appear in Source status while successfully fetched pages and claims remain available.
