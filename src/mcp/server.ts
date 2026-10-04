import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capabilityActionSchema, type CapabilityAction, type DeviceAction } from '../yandex/types.js';

export interface HomeClient {
  getUserInfo(): Promise<unknown>;
  getDevice(id: string): Promise<unknown>;
  getGroup(id: string): Promise<unknown>;
  controlDevices(devices: DeviceAction[]): Promise<unknown>;
  controlGroup(id: string, capabilities: CapabilityAction[]): Promise<unknown>;
  runScenario(id: string): Promise<unknown>;
}
const id = z.string().min(1).max(256);
const capability = capabilityActionSchema;
const capabilities = z.array(capability).min(1).max(100);

/** Tools deliberately omit unsupported create/delete operations. */
export function createMcpServer(client: HomeClient, options: { readOnly?: boolean; requireScopes?: boolean } = {}) {
  const server = new McpServer({ name: 'yandex-home-mcp', version: '0.1.0' });
  function register<T extends z.ZodRawShape>(name: string, description: string, schema: T, write: boolean, operation: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>) {
    server.registerTool<z.ZodRawShape, z.ZodObject<T>>(name, {
      description,
      inputSchema: z.strictObject(schema),
      annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: true },
    }, async (args, extra) => {
      const requiredScope = write ? 'mcp:control' : 'mcp:read';
      if (options.requireScopes && !extra.authInfo?.scopes.includes(requiredScope)) {
        return { isError: true, content: [{ type: 'text', text: `Access denied: ${requiredScope} scope required.` }] };
      }
      try {
        const result = await operation(args as z.infer<z.ZodObject<T>>);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } };
      } catch (error) {
        // Never return upstream error bodies, URLs, stack traces, or OAuth tokens.
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        const known = ['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED', 'TIMEOUT', 'OUTCOME_UNKNOWN', 'INVALID_ARGUMENT', 'INVALID_RESPONSE', 'NETWORK_ERROR', 'READ_ONLY'];
        const safeCode = known.includes(code) ? code : 'UPSTREAM_ERROR';
        return { isError: true, content: [{ type: 'text', text: safeCode === 'OUTCOME_UNKNOWN' ? 'Action result is unknown. Check device state before attempting it again.' : `Yandex request failed (${safeCode}).` }] };
      }
    });
  }
  register('get_home', 'Discover Yandex homes, rooms, devices, groups and existing scenarios.', {}, false, () => client.getUserInfo());
  register('get_device', 'Read device information and its current capabilities and properties.', { device_id: id }, false, args => client.getDevice(args.device_id));
  register('get_group', 'Read group information and its current capabilities.', { group_id: id }, false, args => client.getGroup(args.group_id));
  if (!options.readOnly) {
    register('control_devices', 'Apply capabilities to devices. Discover supported types and instances first. Commands may have physical effects; partial failures are returned per action.', { devices: z.array(z.strictObject({ id, capabilities })).min(1).max(100) }, true, args => client.controlDevices(args.devices.map(device => ({ id: device.id, actions: device.capabilities }))));
    register('control_group', 'Apply capabilities to a group. Discover supported types and instances first; commands may have physical effects.', { group_id: id, capabilities }, true, args => client.controlGroup(args.group_id, args.capabilities));
    register('run_scenario', 'Run an existing Yandex scenario. It may change several devices.', { scenario_id: id }, true, args => client.runScenario(args.scenario_id));
  }
  return server;
}
