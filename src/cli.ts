#!/usr/bin/env node
/**
 * ADI Chain MCP server entry point.
 *
 * Run: bun i -g . && adi-mcp-server
 * Env: ADI_MCP_PRIVATE_KEY (optional) enables write tools (bridge_deposit,
 *      bridge_withdraw, ccip_transfer). The server never stores keys.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { accountFromEnv, registerTools } from "./tools.ts";

const server = new McpServer({
  name: "adi-mcp-server",
  version: "0.1.0",
});

const account = accountFromEnv();
registerTools(server, account);

if (!account) {
  process.stderr.write(
    "adi-mcp-server: read-only mode (no ADI_MCP_PRIVATE_KEY). Write tools (bridge_deposit, bridge_withdraw, ccip_transfer) are disabled.\n",
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
