export type TinyFishAuthMode = 'oauth' | 'api_key';
export type TinyFishAuthSelection = { mode: 'oauth' } | { mode: 'api_key'; apiKey: string };

export class TinyFishAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TinyFishAuthConfigurationError';
  }
}

type AuthEnvironment = Readonly<Record<string, string | undefined>>;

export function getSelectedTinyFishAuthMode(environment: AuthEnvironment = process.env): TinyFishAuthMode {
  const configured = environment.TINYFISH_AUTH_MODE?.trim().toLowerCase();
  if (!configured) return 'oauth';
  if (configured === 'oauth' || configured === 'api_key') return configured;
  throw new TinyFishAuthConfigurationError('TINYFISH_AUTH_MODE must be either "oauth" or "api_key".');
}

export function resolveTinyFishAuthSelection(environment: AuthEnvironment = process.env): TinyFishAuthSelection {
  const mode = getSelectedTinyFishAuthMode(environment);
  const apiKey = environment.TINYFISH_MCP_TOKEN?.trim();

  if (mode === 'api_key') {
    if (!apiKey) throw new TinyFishAuthConfigurationError('API-key mode is selected, but TINYFISH_MCP_TOKEN is not configured.');
    return { mode, apiKey };
  }

  if (apiKey) {
    throw new TinyFishAuthConfigurationError('TINYFISH_MCP_TOKEN is set while OAuth mode is selected. Set TINYFISH_AUTH_MODE=api_key to use it, or remove the token to use OAuth.');
  }
  return { mode };
}

export function tinyFishApiKeyHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}
