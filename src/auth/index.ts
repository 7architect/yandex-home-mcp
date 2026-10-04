import { TokenStore } from './token-store.js';
import { TokenProvider } from './token-provider.js';
import { YandexOAuth } from './yandex-oauth.js';
import { login as performLogin } from './login.js';

export interface AuthConfig {
  yandexClientId?: string;
  yandexClientSecret?: string;
  yandexRedirectUri: string;
  tokenFile: string;
  tokenEncryptionKeyFile: string;
  yandexAccessToken?: string;
  readOnly: boolean;
}
function components(config: AuthConfig) {
  const store = new TokenStore({ path: config.tokenFile, keyPath: config.tokenEncryptionKeyFile });
  const oauth = new YandexOAuth({ clientId: config.yandexClientId ?? '', ...(config.yandexClientSecret ? { clientSecret: config.yandexClientSecret } : {}) });
  const provider = new TokenProvider({ store, oauth, ...(config.yandexAccessToken ? { envToken: config.yandexAccessToken } : {}) });
  return { store, oauth, provider };
}
export async function createTokenProvider(config: AuthConfig): Promise<() => Promise<string>> { const { provider } = components(config); return () => provider.getAccessToken(); }
export async function login(config: AuthConfig): Promise<void> {
  if (!config.yandexClientId) throw new Error('YANDEX_CLIENT_ID is required for login.');
  const { oauth, store } = components(config);
  await performLogin({ oauth, store, redirectUri: config.yandexRedirectUri, scopes: config.readOnly ? ['iot:view'] : ['iot:view', 'iot:control'], openBrowser: false });
}
export async function status(config: AuthConfig): Promise<unknown> { return components(config).provider.status(); }
export async function logout(config: AuthConfig): Promise<void> {
  await components(config).provider.logout();
  if (config.yandexAccessToken) process.stderr.write('Stored credentials removed. Unset YANDEX_ACCESS_TOKEN to disconnect the environment token.\n');
}
