import { createHash, randomBytes } from 'node:crypto';

export interface YandexTokens { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string }
export interface YandexOAuthOptions { clientId: string; clientSecret?: string; fetch?: typeof fetch; timeoutMs?: number }
export class YandexOAuth {
  readonly options: YandexOAuthOptions;
  constructor(options: YandexOAuthOptions) { this.options = options; }
  authorization(redirectUri: string, scopes = ['iot:view', 'iot:control']) {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const url = new URL('https://oauth.yandex.ru/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.options.clientId, redirect_uri: redirectUri, scope: scopes.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return { url: url.toString(), verifier, state };
  }
  async exchange(code: string, verifier: string, redirectUri: string): Promise<YandexTokens> {
    return this.request({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
  }
  async refresh(refreshToken: string): Promise<YandexTokens> {
    if (!this.options.clientSecret) throw new Error('Yandex token expired. Run auth login again; refresh requires a configured client secret.');
    return this.request({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }
  private async request(parameters: Record<string, string>): Promise<YandexTokens> {
    const body = new URLSearchParams({ ...parameters, client_id: this.options.clientId });
    if (this.options.clientSecret) body.set('client_secret', this.options.clientSecret);
    let response: Response;
    try { response = await (this.options.fetch ?? fetch)('https://oauth.yandex.ru/token', { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000) }); }
    catch { throw new Error('Yandex OAuth request failed or timed out.'); }
    if (!response.ok) throw new Error(`Yandex OAuth rejected the request (${response.status}); run auth login again if credentials expired.`);
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('access_token' in data) || typeof data.access_token !== 'string' || !data.access_token) throw new Error('Invalid Yandex OAuth token response.');
    const value = data as Record<string, unknown>;
    return { accessToken: data.access_token, ...(typeof value.refresh_token === 'string' ? { refreshToken: value.refresh_token } : {}), ...(typeof value.expires_in === 'number' && Number.isFinite(value.expires_in) && value.expires_in > 0 ? { expiresAt: Date.now() + value.expires_in * 1000 } : {}), ...(typeof value.scope === 'string' ? { scope: value.scope } : {}) };
  }
}
