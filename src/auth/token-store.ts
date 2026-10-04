import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { YandexTokens } from './yandex-oauth.js';

export interface TokenStoreOptions { path: string; keyPath: string }
export class TokenStore {
  constructor(readonly options: TokenStoreOptions) {
    if (resolve(options.path) === resolve(options.keyPath)) throw new Error('Token encryption key must use a separate file.');
  }
  private async key(create: boolean): Promise<Buffer> {
    try {
      const info = await lstat(this.options.keyPath);
      if (!info.isFile()) throw new Error('Token key must be a regular file, not a symlink.');
      if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Token key permissions must be 0600.');
      const key = await readFile(this.options.keyPath);
      if (key.length !== 32) throw new Error('Invalid token encryption key.');
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      await mkdir(dirname(this.options.keyPath), { recursive: true, mode: 0o700 });
      try { await writeFile(this.options.keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      return this.key(false);
    }
  }
  async read(): Promise<YandexTokens | undefined> {
    let raw: string;
    try {
      const info = await lstat(this.options.path);
      if (!info.isFile()) throw new Error('Token store must be a regular file, not a symlink.');
      if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Token store permissions must be 0600.');
      raw = await readFile(this.options.path, 'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const envelope = JSON.parse(raw) as { version: number; iv: string; tag: string; data: string };
      if (envelope.version !== 1) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', await this.key(false), Buffer.from(envelope.iv, 'base64'));
      cipher.setAAD(Buffer.from('yandex-home-mcp:tokens:v1'));
      cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const tokens = JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString('utf8')) as YandexTokens;
      if (typeof tokens.accessToken !== 'string' || !tokens.accessToken) throw new Error();
      return tokens;
    } catch { throw new Error('Cannot decrypt token store; check the encryption key or run auth login again.'); }
  }
  async write(tokens: YandexTokens): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await this.key(true), iv);
    cipher.setAAD(Buffer.from('yandex-home-mcp:tokens:v1'));
    const data = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.options.path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async clear(): Promise<void> { await unlink(this.options.path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}
