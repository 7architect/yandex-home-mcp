import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTokenError, UnsupportedGrantTypeError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export interface McpOAuthConfig {
  baseUrl: string;
  clients: Array<{ clientId: string; redirectUris: string[] }>;
  ownerSecret: string;
  signingSecret: string;
}
const SCOPES = ['mcp:read', 'mcp:control'];
const random = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
type Grant = { clientId: string; params: AuthorizationParams; expires: number };
type Pending = Grant & { browser: string; attempts: number };

/** Fixed registered clients, explicit owner approval, PKCE and resource-bound short-lived tokens.
 * Pending consents and codes intentionally expire on restart; signed access tokens survive it.
 */
export function createMcpAuth(config: McpOAuthConfig) {
  const issuer = new URL(config.baseUrl);
  if (issuer.pathname !== '/' || issuer.search || issuer.hash || issuer.username || issuer.password ||
      (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(issuer.hostname)))) {
    throw new Error('MCP OAuth baseUrl must be an HTTPS origin (HTTP loopback is allowed for development)');
  }
  if (config.signingSecret.length < 32 || config.ownerSecret.length < 24 || config.signingSecret === config.ownerSecret) {
    throw new Error('MCP OAuth requires separate signing secret (32+ characters) and owner secret (24+ characters)');
  }
  const resource = new URL('/mcp', issuer);
  const clients = new Map<string, OAuthClientInformationFull>();
  for (const client of config.clients) {
    if (!client.clientId || clients.has(client.clientId) || !client.redirectUris.length) throw new Error('Invalid or duplicate MCP OAuth client');
    for (const uri of client.redirectUris) {
      const url = new URL(uri);
      if (url.hash || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('OAuth redirects must use HTTPS or HTTP loopback');
    }
    clients.set(client.clientId, { client_id: client.clientId, redirect_uris: [...client.redirectUris], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: SCOPES.join(' ') });
  }
  if (!clients.size) throw new Error('At least one pre-registered MCP OAuth client is required');
  const codes = new Map<string, Grant>();
  const pending = new Map<string, Pending>();
  const cleanup = () => { for (const store of [codes, pending]) for (const [key, value] of store) if (value.expires < Date.now()) store.delete(key); };
  const signature = (input: string) => createHmac('sha256', config.signingSecret).update(input).digest('base64url');
  const findCode = (client: OAuthClientInformationFull, code: string) => {
    cleanup();
    const grant = codes.get(code);
    if (!grant || grant.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
    return grant;
  };
  const provider: OAuthServerProvider = {
    clientsStore: { getClient: id => clients.get(id) },
    async authorize(client, params, res) {
      cleanup();
      // The SDK permits variable loopback ports; this deployment deliberately uses exact registered URIs.
      if (!client.redirect_uris.includes(params.redirectUri)) { res.status(400).json({ error: 'invalid_request' }); return; }
      if (!params.resource || params.resource.href !== resource.href) throw new InvalidRequestError('resource must identify this MCP server');
      if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('Invalid S256 challenge');
      const scopes = params.scopes?.length ? params.scopes : ['mcp:read'];
      if (scopes.some(scope => !SCOPES.includes(scope))) throw new InvalidScopeError('Unsupported scope');
      if (pending.size + codes.size >= 1000) throw new InvalidRequestError('Too many pending authorizations');
      const challenge = random(), browser = random();
      pending.set(challenge, { clientId: client.client_id, params: { ...params, scopes }, browser, attempts: 0, expires: Date.now() + 300_000 });
      res.cookie('mcp_consent', browser, { httpOnly: true, secure: issuer.protocol === 'https:', sameSite: 'strict', path: '/consent', maxAge: 300_000 });
      res.set({ 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
      res.type('html').send(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>MCP: разрешение доступа</title><h1>Разрешить доступ к умному дому</h1><p>Клиент: ${escapeHtml(client.client_id)}</p><p>Права: ${escapeHtml(scopes.join(', '))}</p><form method="post" action="/consent"><input type="hidden" name="challenge" value="${challenge}"><label>Секрет владельца <input type="password" name="owner_secret" autocomplete="off" required></label><button name="decision" value="approve">Разрешить</button><button name="decision" value="deny">Отказать</button></form></html>`);
    },
    async challengeForAuthorizationCode(client, code) { return findCode(client, code).params.codeChallenge; },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, requestedResource) {
      const grant = findCode(client, code);
      if (redirectUri !== grant.params.redirectUri || requestedResource?.href !== resource.href) throw new InvalidGrantError('Redirect URI or resource mismatch');
      codes.delete(code);
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iss: issuer.href, aud: resource.href, sub: 'owner', client_id: client.client_id, scope: grant.params.scopes!.join(' '), iat: now, exp: now + 3600, jti: random() })).toString('base64url');
      const input = `${header}.${payload}`;
      return { access_token: `${input}.${signature(input)}`, token_type: 'Bearer', expires_in: 3600, scope: grant.params.scopes!.join(' ') };
    },
    async exchangeRefreshToken() { throw new UnsupportedGrantTypeError('Refresh tokens are not supported; authorize again'); },
    async verifyAccessToken(token) {
      try {
        if (token.length > 8192) throw new Error();
        const pieces = token.split('.');
        if (pieces.length !== 3 || !equal(pieces[2]!, signature(`${pieces[0]}.${pieces[1]}`))) throw new Error();
        const header = JSON.parse(Buffer.from(pieces[0]!, 'base64url').toString());
        const claim = JSON.parse(Buffer.from(pieces[1]!, 'base64url').toString());
        if (header.alg !== 'HS256' || header.typ !== 'JWT' || claim.iss !== issuer.href || claim.aud !== resource.href || claim.sub !== 'owner' || !clients.has(claim.client_id) || !Number.isInteger(claim.exp) || claim.exp <= Date.now() / 1000 || typeof claim.scope !== 'string') throw new Error();
        const scopes = claim.scope.split(' ');
        if (scopes.some((scope: string) => !SCOPES.includes(scope))) throw new Error();
        return { token, clientId: claim.client_id, scopes, expiresAt: claim.exp, resource };
      } catch { throw new InvalidTokenError('Invalid or expired access token'); }
    }
  };
  const router = express.Router();
  router.post('/consent', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    cleanup();
    const challenge = typeof req.body.challenge === 'string' ? req.body.challenge : '';
    const consent = pending.get(challenge);
    const cookie = /(?:^|;\s*)mcp_consent=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    if (!consent || !equal(cookie, consent.browser) || ++consent.attempts > 5) { res.status(400).json({ error: 'invalid_request' }); return; }
    if (typeof req.body.owner_secret !== 'string' || !equal(req.body.owner_secret, config.ownerSecret)) { res.status(403).json({ error: 'access_denied' }); return; }
    pending.delete(challenge);
    res.clearCookie('mcp_consent', { path: '/consent', secure: issuer.protocol === 'https:', sameSite: 'strict' });
    const redirect = new URL(consent.params.redirectUri);
    if (consent.params.state !== undefined) redirect.searchParams.set('state', consent.params.state);
    if (req.body.decision === 'approve') {
      const code = random();
      codes.set(code, { ...consent, expires: Date.now() + 60_000 });
      redirect.searchParams.set('code', code);
    } else redirect.searchParams.set('error', 'access_denied');
    res.redirect(302, redirect.href);
  });
  router.use('/authorize', express.urlencoded({ extended: false, limit: '8kb' }), (req, res, next) => {
    // Apply exact redirect checks before SDK parsing, including its error redirects.
    const input = req.method === 'POST' ? req.body : req.query;
    const client = typeof input?.client_id === 'string' ? clients.get(input.client_id) : undefined;
    if (typeof input?.redirect_uri === 'string' && client && !client.redirect_uris.includes(input.redirect_uri)) {
      res.set('Cache-Control', 'no-store').status(400).json({ error: 'invalid_request' });
      return;
    }
    next();
  }, authorizationHandler({ provider }));
  router.use('/token', tokenHandler({ provider }));
  router.use(mcpAuthMetadataRouter({
    oauthMetadata: { issuer: issuer.href, authorization_endpoint: new URL('/authorize', issuer).href, token_endpoint: new URL('/token', issuer).href, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], grant_types_supported: ['authorization_code'], scopes_supported: SCOPES },
    resourceServerUrl: resource, scopesSupported: SCOPES, resourceName: 'Yandex Home MCP'
  }));
  const authenticate: RequestHandler = requireBearerAuth({ verifier: provider, expectedResource: resource, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) });
  return { router, authenticate, resource, provider };
}
export const createMcpAuthMiddleware = (config: McpOAuthConfig): RequestHandler => createMcpAuth(config).authenticate;
