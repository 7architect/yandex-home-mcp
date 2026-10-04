import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RuntimeConfig } from '../config.js';
import { createMcpAuth } from '../auth/mcp.js';
import { createMcpServer } from '../mcp/server.js';
import { YandexClient } from '../yandex/client.js';

const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
export function createHttpApp(config: RuntimeConfig, getAccessToken: () => Promise<string>) {
  const app = express();
  app.disable('x-powered-by');
  const publicUrl = config.mcpOAuth?.baseUrl ?? config.publicUrl;
  const external = publicUrl ? new URL(publicUrl) : undefined;
  if (external && (external.username || external.password || external.search || external.hash || external.pathname !== '/' || external.protocol !== 'https:')) throw new Error('Public URL must be an HTTPS origin');
  if (!loopback.has(config.host) && !external) throw new Error('Remote HTTP requires a public HTTPS URL');
  const localHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  const allowedHosts = new Set([`${localHost}:${config.port}`, ...(external ? [external.host] : [])]);
  const allowedOrigins = new Set([`http://${localHost}:${config.port}`, ...(external ? [external.origin] : [])]);
  const healthHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`]);
  app.use((req, res, next) => {
    const health = req.method === 'GET' && req.path === '/health';
    if (!req.headers.host || !(allowedHosts.has(req.headers.host.toLowerCase()) || (health && healthHosts.has(req.headers.host.toLowerCase())))) { res.status(403).json({ error: 'Invalid host' }); return; }
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) { res.status(403).json({ error: 'Invalid origin' }); return; }
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  let authenticate: RequestHandler;
  if (config.mcpOAuth) {
    const auth = createMcpAuth(config.mcpOAuth);
    app.use(auth.router);
    authenticate = auth.authenticate;
  } else {
    if (!config.mcpBearerToken || config.mcpBearerToken.length < 32) throw new Error('HTTP requires MCP OAuth or MCP_BEARER_TOKEN with at least 32 characters');
    const expected = Buffer.from(config.mcpBearerToken);
    authenticate = (req, res, next) => {
      const value = req.headers.authorization;
      const token = value?.startsWith('Bearer ') ? value.slice(7) : '';
      const actual = Buffer.from(token);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        res.status(401).json({ error: 'Unauthorized' }); return;
      }
      req.auth = { token, clientId: 'owner', scopes: ['mcp:read', ...(config.readOnly ? [] : ['mcp:control'])] };
      next();
    };
  }
  app.all('/mcp', authenticate, express.json({ limit: '256kb' }), async (req, res) => {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); res.status(405).end(); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer(new YandexClient({ getAccessToken, readOnly: config.readOnly }), { readOnly: config.readOnly, requireScopes: true });
    res.on('close', () => { void server.close().catch(() => undefined); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
      await server.close();
    }
  });
  app.use(((error, _req, res, _next) => {
    const status = error && typeof error === 'object' && 'status' in error && error.status === 413 ? 413 : 400;
    res.status(status).json({ error: 'Invalid request' });
  }) as express.ErrorRequestHandler);
  return app;
}

export async function startHttp(config: RuntimeConfig, getAccessToken: () => Promise<string>): Promise<Server> {
  const app = createHttpApp(config, getAccessToken);
  return await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(config.port, config.host, () => resolve(listener));
    listener.once('error', reject);
  });
}
