import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RuntimeConfig } from '../config.js';
import { YandexClient } from '../yandex/client.js';
import { createMcpServer } from '../mcp/server.js';

export async function startStdio(config: RuntimeConfig, getAccessToken: () => Promise<string>) {
  const server = createMcpServer(new YandexClient({ getAccessToken, readOnly: config.readOnly }), { readOnly: config.readOnly });
  await server.connect(new StdioServerTransport());
  return server;
}
