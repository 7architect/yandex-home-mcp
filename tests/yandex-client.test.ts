import { describe, expect, it, vi } from 'vitest';
import { YandexClient } from '../src/yandex/client.js';
import { YandexApiError } from '../src/yandex/errors.js';

const info = { status: 'ok', request_id: 'req-1', rooms: [], groups: [], devices: [], scenarios: [], households: [] };
const action = { type: 'devices.capabilities.on_off' as const, state: { instance: 'on', value: true } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function client(fetcher: typeof fetch, extra: Partial<ConstructorParameters<typeof YandexClient>[0]> = {}) {
  return new YandexClient({ getAccessToken: async () => 'secret-token', fetch: fetcher, retryDelayMs: 0, ...extra });
}

describe('Yandex platform client', () => {
  it('reads all households, authenticates with Bearer, and rejects malformed contracts', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(info)).mockResolvedValueOnce(json({ status: 'ok' }));
    expect(await client(fetcher).getUserInfo()).toEqual(info);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.iot.yandex.net/v1.0/user/info');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer secret-token' });
    await expect(client(fetcher).getUserInfo()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('retries transient reads, but not authorization failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 503)).mockRejectedValueOnce(new Error('secret-token')).mockResolvedValueOnce(json(info));
    expect(await client(fetcher).getUserInfo()).toEqual(info);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const denied = vi.fn<typeof fetch>().mockResolvedValue(json({ message: 'secret-token' }, 401));
    await expect(client(denied).getUserInfo()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(denied).toHaveBeenCalledTimes(1);
  });
  it('preserves partial device action failures even with HTTP 200', async () => {
    const response = { status: 'ok', request_id: 'req-2', devices: [{ id: 'light', capabilities: [{ type: action.type, state: { instance: 'on', action_result: { status: 'ERROR', error_code: 'DEVICE_UNREACHABLE', error_message: 'secret-token' } } }] }] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(response));
    const result = await client(fetcher).controlDevices([{ id: 'light', actions: [action] }]);
    expect(result.devices[0]?.capabilities[0]?.state.action_result).toMatchObject({ status: 'ERROR', error_code: 'DEVICE_UNREACHABLE', error_message: '[REDACTED]' });
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({ devices: [{ id: 'light', actions: [action] }] });
  });
  it.each([401, 500, 503])('never repeats a scenario command after HTTP %s', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ message: 'secret-token' }, status));
    await expect(client(fetcher).runScenario('scene/a')).rejects.toMatchObject({ code: status === 401 ? 'AUTH_REQUIRED' : 'OUTCOME_UNKNOWN' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.iot.yandex.net/v1.0/scenarios/scene%2Fa/actions');
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
  it('treats command timeout and malformed success as unknown outcomes without leaking errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('secret-token')), { once: true })));
    await expect(client(fetcher, { timeoutMs: 5 }).runScenario('scene')).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', outcomeUnknown: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(json({ status: 'ok', request_id: 'secret-token' }));
    await expect(client(malformed).controlDevices([{ id: 'light', actions: [action] }])).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', requestId: undefined });
  });
  it('blocks writes and invalid actions before fetching', () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => client(fetcher, { readOnly: true }).runScenario('scene')).toThrow(YandexApiError);
    expect(() => client(fetcher).controlDevices([])).toThrow(YandexApiError);
    expect(() => client(fetcher).controlDevices([{ id: 'light', actions: [{ type: action.type, state: { instance: 'on', value: 1 } }] }])).toThrow(YandexApiError);
    expect(() => client(fetcher).getDevice('')).toThrow(YandexApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not expose secrets echoed by upstream errors or token acquisition', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ request_id: 'secret-token', message: 'secret-token', refresh_token: 'another-secret' }, 403));
    try { await client(fetcher).getUserInfo(); } catch (error) {
      expect(error).toBeInstanceOf(YandexApiError);
      expect(JSON.stringify(error)).not.toContain('secret-token');
      expect(String(error)).not.toContain('secret-token');
    }
    await expect(client(fetcher, { getAccessToken: async () => { throw new Error('secret-token'); } }).getUserInfo()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses group body rather than device batch body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ status: 'ok', request_id: 'req-3', devices: [] }));
    await client(fetcher).controlGroup('group', [action]);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.iot.yandex.net/v1.0/groups/group/actions');
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({ actions: [action] });
  });
});
