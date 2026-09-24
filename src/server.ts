import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './tools/context.js';
import { registerAllTools } from './tools/index.js';

/** Builds the MCP server and registers every tool module. See SPEC.md §3. */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: 'wp-fleet-mcp',
    version: '0.1.0',
  });

  registerAllTools(server, ctx);

  return server;
}
