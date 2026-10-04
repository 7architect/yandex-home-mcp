import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type HomeClient } from '../../src/mcp/server.js';

const mockHome = (): HomeClient => ({ getUserInfo: vi.fn().mockResolvedValue({ devices: [], rooms: [], groups: [], scenarios: [] }), getDevice: vi.fn().mockResolvedValue({ id: 'lamp' }), getGroup: vi.fn(), controlDevices: vi.fn().mockResolvedValue({ devices: [{ id: 'lamp', status: 'ERROR' }] }), controlGroup: vi.fn(), runScenario: vi.fn() });
async function connect(home: HomeClient, options = {}, scopes?: string[]) {
  const server = createMcpServer(home, options);
  const client = new Client({ name: 'test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  if (scopes) {
    const send = right.send.bind(right);
    right.send = (message, options) => send(message, { ...options, authInfo: { token: 'mcp-test-token', clientId: 'test', scopes } });
  }
  await server.connect(left);
  await client.connect(right);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
describe('MCP tools', () => {
  it('negotiates SDK protocol and exposes only reads in read-only mode', async () => {
    const { client, close } = await connect(mockHome(), { readOnly: true });
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(t => t.name)).toEqual(['get_home', 'get_device', 'get_group']);
      expect(tools.tools.every(t => t.annotations?.readOnlyHint)).toBe(true);
      expect((await client.callTool({ name: 'get_home', arguments: {} })).isError).not.toBe(true);
    } finally { await close(); }
  });
  it('maps device capabilities to documented actions and preserves partial failure', async () => {
    const home = mockHome(); const { client, close } = await connect(home);
    try {
      const capabilities = [{ type: 'devices.capabilities.on_off', state: { instance: 'on', value: true } }];
      const result = await client.callTool({ name: 'control_devices', arguments: { devices: [{ id: 'lamp', capabilities }] } });
      expect(home.controlDevices).toHaveBeenCalledWith([{ id: 'lamp', actions: capabilities }]);
      expect(JSON.stringify(result)).toContain('ERROR');
      const tools = await client.listTools();
      expect(tools.tools.find(t => t.name === 'run_scenario')?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
    } finally { await close(); }
  });
  it('rejects unknown arguments and sanitizes thrown upstream errors', async () => {
    const home = mockHome(); vi.mocked(home.getDevice).mockRejectedValue(new Error('secret-token'));
    const { client, close } = await connect(home);
    try {
      const invalid = await client.callTool({ name: 'get_device', arguments: { device_id: 'lamp', extra: true } });
      expect(invalid.isError).toBe(true);
      expect(home.getDevice).not.toHaveBeenCalled();
      const result = await client.callTool({ name: 'get_device', arguments: { device_id: 'lamp' } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('secret-token');
    } finally { await close(); }
  });
  it('fails closed when HTTP auth scopes are absent', async () => {
    const home = mockHome(); const { client, close } = await connect(home, { requireScopes: true });
    try {
      expect((await client.callTool({ name: 'get_home', arguments: {} })).isError).toBe(true);
      expect(home.getUserInfo).not.toHaveBeenCalled();
    } finally { await close(); }
  });
  it('permits scoped reads but denies controls with read-only access token', async () => {
    const home = mockHome(); const { client, close } = await connect(home, { requireScopes: true }, ['mcp:read']);
    try {
      expect((await client.callTool({ name: 'get_home', arguments: {} })).isError).not.toBe(true);
      expect((await client.callTool({ name: 'run_scenario', arguments: { scenario_id: 'scene' } })).isError).toBe(true);
      expect(home.runScenario).not.toHaveBeenCalled();
    } finally { await close(); }
  });
});
