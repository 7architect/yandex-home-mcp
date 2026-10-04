import { expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { login } from '../src/auth/login.js';
import { YandexOAuth } from '../src/auth/yandex-oauth.js';
import { TokenStore } from '../src/auth/token-store.js';

async function port() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
it('rejects invalid state and duplicate code, never exchanging attacker code', async () => {
  const oauth = new YandexOAuth({ clientId: 'test' });
  const flow = oauth.authorization(`http://127.0.0.1:1/callback`);
  vi.spyOn(oauth, 'authorization').mockReturnValue(flow);
  const exchange = vi.spyOn(oauth, 'exchange');
  const store = new TokenStore({ path: '/unused-store', keyPath: '/unused-key' });
  const callback = `http://127.0.0.1:${await port()}/callback`;
  let published!: () => void;
  const ready = new Promise<void>(resolve => { published = resolve; });
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => { published(); return true; });
  const result = login({ oauth, store, redirectUri: callback, timeoutMs: 1000 });
  const assertion = expect(result).rejects.toThrow('invalid callback');
  try {
    await ready;
    expect((await fetch(`${callback}?state=attacker&code=attacker`)).status).toBe(400);
    expect((await fetch(`${callback}?state=${flow.state}&code=one&code=two`)).status).toBe(400);
    await assertion;
    expect(exchange).not.toHaveBeenCalled();
  } finally { output.mockRestore(); }
});
it('rejects non-loopback and nonexact callback configuration before binding', async () => {
  const oauth = new YandexOAuth({ clientId: 'test' });
  const store = new TokenStore({ path: '/unused-store', keyPath: '/unused-key' });
  for (const redirectUri of ['https://example.com/callback', 'http://localhost:8123/callback', 'http://127.0.0.1:8123/other', 'http://127.0.0.1:8123/callback?extra=1']) {
    await expect(login({ oauth, store, redirectUri })).rejects.toThrow('exact');
  }
});
it('exchanges the verified code once and rejects replay while storing the token', async () => {
  const oauth = new YandexOAuth({ clientId: 'test' });
  const flow = oauth.authorization('http://127.0.0.1:1/callback');
  vi.spyOn(oauth, 'authorization').mockReturnValue(flow);
  let complete!: () => void;
  const paused = new Promise<void>(resolve => { complete = resolve; });
  const exchange = vi.spyOn(oauth, 'exchange').mockImplementation(async () => { await paused; return { accessToken: 'saved' }; });
  const store = new TokenStore({ path: '/unused-store', keyPath: '/unused-key' });
  const write = vi.spyOn(store, 'write').mockResolvedValue();
  const callback = `http://127.0.0.1:${await port()}/callback`;
  let published!: () => void;
  const ready = new Promise<void>(resolve => { published = resolve; });
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => { published(); return true; });
  const result = login({ oauth, store, redirectUri: callback, timeoutMs: 1000 });
  try {
    await ready;
    const uri = `${callback}?state=${flow.state}&code=verified`;
    expect((await fetch(uri)).status).toBe(200);
    expect((await fetch(uri)).status).toBe(400);
    complete(); await result;
    expect(exchange).toHaveBeenCalledExactlyOnceWith('verified', flow.verifier, callback);
    expect(write).toHaveBeenCalledExactlyOnceWith({ accessToken: 'saved' });
  } finally { complete(); output.mockRestore(); }
});
