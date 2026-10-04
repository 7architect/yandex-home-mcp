import { TokenStore } from './token-store.js';
import { YandexOAuth, type YandexTokens } from './yandex-oauth.js';

export interface TokenProviderOptions { store: TokenStore; oauth: YandexOAuth; envToken?: string }
export class TokenProvider {
  private refreshing?: Promise<YandexTokens>;
  constructor(readonly options: TokenProviderOptions) {}
  async getAccessToken(): Promise<string> {
    if (this.options.envToken) return this.options.envToken;
    const tokens = await this.options.store.read();
    if (!tokens) throw new Error('Yandex account is not connected. Run auth login.');
    if (!tokens.expiresAt || tokens.expiresAt > Date.now() + 30_000) return tokens.accessToken;
    if (!tokens.refreshToken || !this.options.oauth.options.clientSecret) throw new Error('Yandex token expired. Run auth login again.');
    if (!this.refreshing) {
      this.refreshing = this.options.oauth.refresh(tokens.refreshToken).then(async refreshed => {
        const merged = { ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken, scope: refreshed.scope ?? tokens.scope };
        await this.options.store.write(merged); return merged;
      });
      this.refreshing.finally(() => { this.refreshing = undefined; }).catch(() => {});
    }
    return (await this.refreshing).accessToken;
  }
  async status() {
    if (this.options.envToken) return { connected: true, source: 'env' as const };
    const tokens = await this.options.store.read();
    return tokens ? { connected: !tokens.expiresAt || tokens.expiresAt > Date.now(), source: 'store' as const, expiresAt: tokens.expiresAt } : { connected: false, source: 'none' as const };
  }
  async logout(): Promise<void> { await this.options.store.clear(); }
}
