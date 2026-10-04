import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createHash, createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { createMcpAuth, type McpOAuthConfig } from '../src/auth/mcp.js';
const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });
const config: McpOAuthConfig = { baseUrl: 'https://mcp.example', ownerSecret: 'owner-secret-with-sufficient-entropy', signingSecret: 'signing-secret-with-sufficient-entropy-separate', clients: [{ clientId: 'desktop', redirectUris: ['http://127.0.0.1:1234/callback'] }] };
const verifier = 'a'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
async function setup() {
 const auth = createMcpAuth(config), app = express();
 app.use(auth.router);
 app.get('/mcp', auth.authenticate, (req, res) => res.json({ scopes: req.auth?.scopes }));
 const server = app.listen(0, '127.0.0.1'); servers.push(server);
 await new Promise<void>(resolve => server.on('listening', resolve));
 const address = server.address(); if (!address || typeof address === 'string') throw Error();
 const url = `http://127.0.0.1:${address.port}`;
 return { ...auth, url };
}
const params = () => new URLSearchParams({ client_id: 'desktop', redirect_uri: config.clients[0]!.redirectUris[0]!, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://mcp.example/mcp', state: 'client-state', scope: 'mcp:read' });
async function authorize(url: string) {
 const response = await fetch(`${url}/authorize?${params()}`, { redirect: 'manual' });
 expect(response.status).toBe(200);
 const html = await response.text();
 const formChallenge = /name="challenge" value="([^"]+)"/.exec(html)![1]!;
 const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
 return { formChallenge, cookie };
}
async function approve(url: string) {
 const { formChallenge, cookie } = await authorize(url);
 const response = await fetch(`${url}/consent`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ challenge: formChallenge, owner_secret: config.ownerSecret, decision: 'approve' }), redirect: 'manual' });
 expect(response.status).toBe(302);
 const redirect = new URL(response.headers.get('location')!);
 expect(redirect.searchParams.get('state')).toBe('client-state');
 return redirect.searchParams.get('code')!;
}
const exchange = (url: string, code: string, overrides: Record<string,string> = {}) => fetch(`${url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'desktop', redirect_uri: config.clients[0]!.redirectUris[0]!, code, code_verifier: verifier, resource: 'https://mcp.example/mcp', ...overrides }) });
describe('MCP OAuth owner authorization', () => {
 it('exposes accurate discovery and a resource-specific bearer challenge without DCR', async () => {
  const {url} = await setup();
  const metadata = await (await fetch(`${url}/.well-known/oauth-authorization-server`)).json();
  expect(metadata.registration_endpoint).toBeUndefined(); expect(metadata.grant_types_supported).toEqual(['authorization_code']);
  const protectedMetadata = await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json();
  expect(protectedMetadata.resource).toBe('https://mcp.example/mcp');
  const response = await fetch(`${url}/mcp`); expect(response.status).toBe(401); expect(response.headers.get('www-authenticate')).toContain('resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"');
 });
 it('requires owner secret and same-browser CSRF proof before issuing a code', async () => {
  const {url} = await setup(); const {formChallenge,cookie} = await authorize(url);
  const body = new URLSearchParams({ challenge: formChallenge, owner_secret: config.ownerSecret, decision: 'approve' });
  expect((await fetch(`${url}/consent`, {method:'POST', body})).status).toBe(400);
  body.set('owner_secret','wrong');
  expect((await fetch(`${url}/consent`, {method:'POST',headers:{cookie},body})).status).toBe(403);
 });
 it('binds code to verifier, redirect and resource and consumes it once; access survives restart', async () => {
  const {url} = await setup(); const code = await approve(url);
  expect((await exchange(url, code, {code_verifier:'b'.repeat(64)})).status).toBe(400);
  expect((await exchange(url, code, {resource:'https://attacker.example/mcp'})).status).toBe(400);
  expect((await exchange(url, code, {redirect_uri:'http://127.0.0.1:9999/callback'})).status).toBe(400);
  const response = await exchange(url,code); expect(response.status).toBe(200);
  const token = (await response.json()).access_token;
  expect((await exchange(url,code)).status).toBe(400);
  expect((await fetch(`${url}/mcp`, {headers:{authorization:`Bearer ${token}`}})).status).toBe(200);
  const restarted = createMcpAuth(config); expect((await restarted.provider.verifyAccessToken(token)).scopes).toEqual(['mcp:read']);
  await expect(createMcpAuth({...config,signingSecret:'different-signing-key-with-sufficient-length'}).provider.verifyAccessToken(token)).rejects.toThrow();
  await expect(restarted.provider.verifyAccessToken(`${token}x`)).rejects.toThrow();
  const mutate = (patch: Record<string, unknown>) => {
   const [header,payload] = token.split('.');
   const claims = {...JSON.parse(Buffer.from(payload,'base64url').toString()),...patch};
   const input = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
   return `${input}.${createHmac('sha256',config.signingSecret).update(input).digest('base64url')}`;
  };
  await expect(restarted.provider.verifyAccessToken(mutate({exp:1}))).rejects.toThrow();
  await expect(restarted.provider.verifyAccessToken(mutate({aud:'https://attacker.example/mcp'}))).rejects.toThrow();
  await expect(restarted.provider.verifyAccessToken(mutate({scope:'admin'}))).rejects.toThrow();
 });
 it('rejects unknown clients, unknown scopes, mismatching audience and unregistered loopback ports', async () => {
  const {url} = await setup();
  for (const [key,value] of [['client_id','stranger'],['redirect_uri','http://127.0.0.1:4567/callback']] as const) { const p=params();p.set(key,value); const response=await fetch(`${url}/authorize?${p}`,{redirect:'manual'});expect(response.status).toBe(400); }
  const bad=params();bad.set('redirect_uri','http://127.0.0.1:4567/callback');bad.set('code_challenge_method','plain');expect((await fetch(`${url}/authorize?${bad}`,{redirect:'manual'})).status).toBe(400);
  for (const [key,value] of [['scope','admin'],['resource','https://attacker.example/mcp']] as const) { const p=params();p.set(key,value); const response=await fetch(`${url}/authorize?${p}`,{redirect:'manual'});expect(response.status).toBe(302);expect(response.headers.get('location')).toContain('error='); }
 });
});
