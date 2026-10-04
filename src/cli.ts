#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createTokenProvider, login, status, logout } from './auth/index.js';
import { startStdio } from './transports/stdio.js';
import { startHttp } from './transports/http.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'stdio';
  if (['help', '--help', '-h'].includes(command)) {
    console.log('Usage: yandex-home-mcp [login|status|logout|stdio|http]\nConfiguration: environment variables; see README.md.');
    return;
  }
  const config = loadConfig();
  switch (command) {
    case 'login': await login(config); return;
    case 'status': console.log(JSON.stringify(await status(config), null, 2)); return;
    case 'logout': await logout(config); return;
    case 'stdio': await startStdio(config, await createTokenProvider(config)); return;
    case 'http': await startHttp(config, await createTokenProvider(config)); return;
    default: throw new Error(`Unknown command: ${command}. Run --help for usage.`);
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Operation failed');
  process.exitCode = 1;
});
