import { z } from 'zod';
import { YandexApiError } from './errors.js';
import { actionResponseSchema, capabilityActionSchema, deviceActionSchema, deviceInfoSchema, groupInfoSchema, operationResponseSchema, userInfoSchema, type CapabilityAction, type DeviceAction } from './types.js';

export interface YandexClientOptions {
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
  baseUrl?: string;
  readOnly?: boolean;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export class YandexClient {
  private readonly options: YandexClientOptions;
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  constructor(options: YandexClientOptions) {
    this.options = options;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? 'https://api.iot.yandex.net').replace(/\/$/, '');
  }
  getUserInfo() { return this.request('GET', '/v1.0/user/info', userInfoSchema); }
  getDevice(id: string) { return this.request('GET', `/v1.0/devices/${this.id(id)}`, deviceInfoSchema); }
  getGroup(id: string) { return this.request('GET', `/v1.0/groups/${this.id(id)}`, groupInfoSchema); }
  controlDevices(devices: DeviceAction[]) {
    this.writable();
    return this.request('POST', '/v1.0/devices/actions', actionResponseSchema, { devices: this.parse(z.array(deviceActionSchema).min(1), devices) });
  }
  controlGroup(id: string, actions: CapabilityAction[]) {
    this.writable();
    return this.request('POST', `/v1.0/groups/${this.id(id)}/actions`, actionResponseSchema, { actions: this.parse(z.array(capabilityActionSchema).min(1), actions) });
  }
  runScenario(id: string) {
    this.writable();
    return this.request('POST', `/v1.0/scenarios/${this.id(id)}/actions`, operationResponseSchema);
  }
  private writable() { if (this.options.readOnly) throw new YandexApiError('READ_ONLY'); }
  private id(id: string) {
    if (typeof id !== 'string' || !id.trim() || id.length > 1024) throw new YandexApiError('INVALID_ARGUMENT');
    return encodeURIComponent(id);
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new YandexApiError('INVALID_ARGUMENT');
    return result.data;
  }
  private async request<T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const attempts = method === 'GET' ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let token: string;
      try { token = await this.options.getAccessToken(); } catch { throw new YandexApiError('AUTH_REQUIRED'); }
      if (!token || /[\r\n]/.test(token)) throw new YandexApiError('AUTH_REQUIRED');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
      let retry = false;
      try {
        const response = await this.fetcher(`${this.baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: 'error' });
        let data: unknown;
        try { data = await response.json(); } catch {
          if (response.ok) throw new YandexApiError(method === 'POST' ? 'OUTCOME_UNKNOWN' : 'INVALID_RESPONSE');
        }
        const requestId = this.requestId(data, token);
        if (!response.ok) {
          retry = method === 'GET' && (response.status === 429 || response.status >= 500) && attempt + 1 < attempts;
          if (!retry) {
            const code = response.status >= 500 && method === 'POST' ? 'OUTCOME_UNKNOWN' : response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'FORBIDDEN' : response.status === 404 ? 'NOT_FOUND' : response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR';
            throw new YandexApiError(code, { httpStatus: response.status, requestId });
          }
        } else {
          const result = schema.safeParse(data);
          if (!result.success) throw new YandexApiError(method === 'POST' ? 'OUTCOME_UNKNOWN' : 'INVALID_RESPONSE', { requestId });
          return this.sanitize(result.data, token) as T;
        }
      } catch (error) {
        if (error instanceof YandexApiError) throw error;
        if (method === 'POST') throw new YandexApiError('OUTCOME_UNKNOWN');
        if (attempt + 1 >= attempts) throw new YandexApiError('NETWORK_ERROR');
        retry = true;
      } finally { clearTimeout(timer); }
      if (retry) await new Promise(resolve => setTimeout(resolve, (this.options.retryDelayMs ?? 200) * 2 ** attempt));
    }
    throw new YandexApiError('UPSTREAM_ERROR');
  }
  private requestId(data: unknown, token: string): string | undefined {
    if (!data || typeof data !== 'object' || !('request_id' in data)) return undefined;
    const id = data.request_id;
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) && !id.includes(token) ? id : undefined;
  }
  private sanitize(value: unknown, token: string): unknown {
    if (typeof value === 'string') return value.split(token).join('[REDACTED]');
    if (Array.isArray(value)) return value.map(item => this.sanitize(item, token));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(access_token|refresh_token|authorization|client_secret)$/i.test(key)).map(([key, item]) => [key, this.sanitize(item, token)]));
    return value;
  }
}
