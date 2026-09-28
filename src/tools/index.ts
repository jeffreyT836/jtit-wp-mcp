import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import * as sites from './sites.js';
import * as plugins from './plugins.js';
import * as themes from './themes.js';
import * as updates from './updates.js';
import * as users from './users.js';
import * as content from './content.js';
import * as settings from './settings.js';
import * as fleet from './fleet.js';
import * as network from './network.js';

/** Calls `register(server, ctx)` on every tool module. See SPEC.md §3. */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  sites.register(server, ctx);
  plugins.register(server, ctx);
  themes.register(server, ctx);
  updates.register(server, ctx);
  users.register(server, ctx);
  content.register(server, ctx);
  settings.register(server, ctx);
  fleet.register(server, ctx);
  network.register(server, ctx);
}
