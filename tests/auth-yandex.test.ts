import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TokenStore } from '../src/auth/token-store.js';
import { TokenProvider } from '../src/auth/token-provider.js';
import { YandexOAuth } from '../src/auth/yandex-oauth.js';

const directories: string[] = [];
async function store() { const directory = await mkdtemp(join(tmpdir(), 'yandex-auth-')); directories.push(directory); return new TokenStore({ path: join(directory, 'tokens'), keyPath: join(directory, 'key') }); }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('Yandex authorization and persistence', () => {
  it('uses unique state and S256 PKCE, excluding the client secret', () => {
    const oauth = new YandexOAuth({ clientId: 'client', clientSecret: 'secret' });
    const first = oauth.authorization('http://127.0.0.1:8123/callback');
    const second = oauth.authorization('http://127.0.0.1:8123/callback');
    const url = new URL(first.url);
    expect(first.state).not.toBe(second.state);
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(first.verifier).digest('base64url'));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(first.url).not.toContain('secret');
  });
  it('stores ciphertext with restrictive permissions, detects tampering, and clears tokens', async () => {
    const value = await store();
    await value.write({ accessToken: 'sensitive-access', refreshToken: 'sensitive-refresh', expiresAt: Date.now() + 60_000 });
    const raw = await readFile(value.options.path, 'utf8');
    expect(raw).not.toContain('sensitive');
    expect((await value.read())?.accessToken).toBe('sensitive-access');
    expect((await stat(value.options.path)).mode & 0o077).toBe(0);
    expect((await stat(value.options.keyPath)).mode & 0o077).toBe(0);
    const envelope = JSON.parse(raw); envelope.tag = Buffer.alloc(16).toString('base64');
    await writeFile(value.options.path, JSON.stringify(envelope));
    await expect(value.read()).rejects.toThrow('Cannot decrypt');
    await value.clear(); expect(await value.read()).toBeUndefined();
  });
  it('does not print upstream error descriptions or tokens', async () => {
    const oauth = new YandexOAuth({ clientId: 'client', fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ error_description: 'secret-token' }), { status: 400 })) });
    await expect(oauth.exchange('code', 'verifier', 'http://127.0.0.1:8123/callback')).rejects.toThrow('Yandex OAuth rejected');
  });
  it('refreshes concurrent requests once and persists rotated credentials', async () => {
    const value = await store(); await value.write({ accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: Date.now() - 100 });
    const oauth = new YandexOAuth({ clientId: 'client', clientSecret: 'secret' });
    const refresh = vi.spyOn(oauth, 'refresh').mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { accessToken: 'fresh', refreshToken: 'rotated', expiresAt: Date.now() + 60_000 }; });
    const provider = new TokenProvider({ store: value, oauth });
    expect(await Promise.all(Array.from({ length: 8 }, () => provider.getAccessToken()))).toEqual(Array(8).fill('fresh'));
    expect(refresh).toHaveBeenCalledTimes(1); expect((await value.read())?.refreshToken).toBe('rotated');
  });
  it('requires relogin for expired public clients, but permits environment credentials', async () => {
    const value = await store(); await value.write({ accessToken: 'expired', refreshToken: 'refresh', expiresAt: 1 });
    const oauth = new YandexOAuth({ clientId: 'public' });
    await expect(new TokenProvider({ store: value, oauth }).getAccessToken()).rejects.toThrow('Run auth login');
    expect(await new TokenProvider({ store: value, oauth, envToken: 'environment' }).getAccessToken()).toBe('environment');
  });
});
