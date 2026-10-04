import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { TokenStore } from './token-store.js';
import type { YandexOAuth } from './yandex-oauth.js';

export interface LoginOptions { oauth: YandexOAuth; store: TokenStore; redirectUri: string; scopes?: string[]; timeoutMs?: number; openBrowser?: boolean }
export async function login(options: LoginOptions): Promise<void> {
  const callback = new URL(options.redirectUri);
  if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port || callback.pathname !== '/callback' || callback.search || callback.hash || callback.username || callback.password) throw new Error('Login callback must be an exact http://127.0.0.1:PORT/callback URI registered with Yandex OAuth.');
  const authorization = options.oauth.authorization(callback.toString(), options.scopes);
  let finish!: (code: string) => void;
  let fail!: (error: Error) => void;
  let consumed = false;
  const code = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (request.method !== 'GET' || request.headers.host !== callback.host) { response.writeHead(400).end('Invalid callback.'); return; }
    const url = new URL(request.url ?? '/', callback);
    if (url.pathname !== callback.pathname) { response.writeHead(404).end('Not found.'); return; }
    const states = url.searchParams.getAll('state');
    const state = states[0];
    if (states.length !== 1 || !state || Buffer.byteLength(state) !== Buffer.byteLength(authorization.state) || !timingSafeEqual(Buffer.from(state), Buffer.from(authorization.state))) { response.writeHead(400).end('Invalid authorization state.'); return; }
    if (consumed) { response.writeHead(400).end('Callback already used.'); return; }
    const codes = url.searchParams.getAll('code');
    consumed = true;
    if (url.searchParams.has('error') || codes.length !== 1 || !codes[0]) { response.writeHead(400).end('Authorization was not completed.'); fail(new Error('Yandex authorization was denied or returned an invalid callback.')); return; }
    response.writeHead(200).end('Authorization received. You can close this window and return to the terminal.');
    finish(codes[0]);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(callback.port), '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', () => fail(new Error('OAuth callback listener failed.')));
    timer = setTimeout(() => fail(new Error('Yandex login timed out. Run login again.')), options.timeoutMs ?? 300_000);
    process.stderr.write(`Open this URL to authorize Yandex (do not share this temporary link):\n${authorization.url}\n`);
    if (options.openBrowser) {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
      const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', authorization.url] : [authorization.url];
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {}); child.unref();
    }
    const tokens = await options.oauth.exchange(await code, authorization.verifier, callback.toString());
    await options.store.write(tokens);
    process.stderr.write('Yandex account connected.\n');
  } finally {
    if (timer) clearTimeout(timer);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
