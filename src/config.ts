import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RuntimeConfig {
  yandexClientId?: string;
  yandexClientSecret?: string;
  yandexRedirectUri: string;
  tokenFile: string;
  readOnly: boolean;
  host: string;
  port: number;
  mcpBearerToken?: string;
  publicUrl?: string;
  yandexAccessToken?: string;
  tokenEncryptionKeyFile: string;
  mcpOAuth?: { baseUrl: string; clients: Array<{clientId: string; redirectUris: string[]}>; ownerSecret: string; signingSecret: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const readOnly = env.YANDEX_READ_ONLY ?? 'true';
  if (!['true', 'false'].includes(readOnly)) throw new Error('YANDEX_READ_ONLY must be true or false');
  let mcpOAuth: RuntimeConfig["mcpOAuth"];
  if (env.PUBLIC_URL || env.MCP_OAUTH_CLIENTS || env.MCP_OWNER_SECRET || env.MCP_SIGNING_SECRET) {
    if (!env.PUBLIC_URL || !env.MCP_OAUTH_CLIENTS || !env.MCP_OWNER_SECRET || !env.MCP_SIGNING_SECRET) throw new Error("OAuth requires PUBLIC_URL, MCP_OAUTH_CLIENTS, MCP_OWNER_SECRET and MCP_SIGNING_SECRET");
    let clients: unknown;
    try { clients = JSON.parse(env.MCP_OAUTH_CLIENTS); } catch { throw new Error("MCP_OAUTH_CLIENTS must be valid JSON"); }
    if (!Array.isArray(clients) || clients.length === 0 || clients.some(c => !c || typeof c.clientId !== "string" || !Array.isArray(c.redirectUris) || c.redirectUris.length === 0 || c.redirectUris.some((u: unknown) => typeof u !== "string"))) throw new Error("MCP_OAUTH_CLIENTS must contain clientId and redirectUris");
    mcpOAuth = { baseUrl: env.PUBLIC_URL, clients, ownerSecret: env.MCP_OWNER_SECRET, signingSecret: env.MCP_SIGNING_SECRET };
  }
  return {
    yandexClientId: env.YANDEX_CLIENT_ID,
    yandexClientSecret: env.YANDEX_CLIENT_SECRET,
    yandexRedirectUri: env.YANDEX_REDIRECT_URI ?? 'http://127.0.0.1:8765/callback',
    tokenFile: env.YANDEX_TOKEN_FILE ?? join(homedir(), '.config', 'yandex-home-mcp', 'tokens.json'),
    readOnly: readOnly === 'true',
    host: env.HOST ?? '127.0.0.1',
    port,
    mcpBearerToken: env.MCP_BEARER_TOKEN,
    publicUrl: env.MCP_PUBLIC_URL,
    yandexAccessToken: env.YANDEX_ACCESS_TOKEN,
    tokenEncryptionKeyFile: env.YANDEX_TOKEN_ENCRYPTION_KEY_FILE ?? join(homedir(), '.config', 'yandex-home-mcp', 'token-key'),
    mcpOAuth,
  };
}
