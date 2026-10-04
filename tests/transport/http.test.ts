import { afterEach, describe, expect, it } from 'vitest';
import { request, type Server } from 'node:http';
import express from 'express';
import { createHttpApp } from '../../src/transports/http.js';
import { loadConfig } from '../../src/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const bearer = 'a'.repeat(40);
const listeners: Server[] = [];
afterEach(async () => { await Promise.all(listeners.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function listen() {
  const config = loadConfig({ MCP_BEARER_TOKEN: bearer });
  const wrapper = express();
  const server = wrapper.listen(0, '127.0.0.1'); listeners.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listener');
  config.port = address.port;
  wrapper.use(createHttpApp(config, async () => 'yandex-token'));
  return { url: `http://127.0.0.1:${address.port}`, host: `127.0.0.1:${config.port}` };
}
describe('HTTP boundary', () => {
  it('requires authentication and rejects hostile hosts/origins before MCP', async () => {
    const { url, host } = await listen();
    expect((await fetch(`${url}/health`, { headers: { host } })).status).toBe(200);
    expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { host } })).status).toBe(401);
    const badHost = await new Promise<number>(resolve => { const req = request(`${url}/mcp`, { method: 'POST', headers: { host: 'evil.test', authorization: `Bearer ${bearer}` } }, res => { res.resume(); resolve(res.statusCode!); }); req.end(); });
    expect(badHost).toBe(403);
    expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { host, origin: 'https://evil.test', authorization: `Bearer ${bearer}` } })).status).toBe(403);
    expect((await fetch(`${url}/mcp`, { headers: { host, authorization: `Bearer ${bearer}` } })).status).toBe(405);
  });
  it('negotiates Streamable HTTP and lists tools without fetching Yandex', async () => {
    const { url, host } = await listen();
    const client = new Client({ name: 'smoke', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { host, authorization: `Bearer ${bearer}` } } });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['get_home', 'get_device', 'get_group']);
    } finally { await client.close(); }
  });
  it('refuses unauthenticated and remotely exposed configurations', () => {
    expect(() => createHttpApp(loadConfig({}), async () => 'token')).toThrow('HTTP requires');
    expect(() => createHttpApp(loadConfig({ HOST: '0.0.0.0', MCP_BEARER_TOKEN: bearer }), async () => 'token')).toThrow('Remote HTTP requires');
  });
});
