/**
 * Smoke test: spawn the MCP server, handshake, list tools, and exercise
 * read/advisory tools against live RPC. Run: bun run test/smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "src/cli.ts"],
  cwd: new URL("..", import.meta.url).pathname,
});

const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`TOOLS (${tools.tools.length}):`);
for (const t of tools.tools) console.log(`  - ${t.name}`);

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text?: string }[];
  const text = content.find((c) => c.type === "text")?.text ?? "";
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===`);
  console.log(text.slice(0, 1200));
}

await call("get_network_info", { network: "mainnet" });
await call("get_token_info", { token: "ADI", network: "mainnet" });
await call("get_token_info", { token: "USDC.e", network: "mainnet" });
await call("get_ccip_lanes", { network: "mainnet" });
await call("get_finality_status", { network: "mainnet" });
await call("plan_funding_path", { network: "mainnet", target: "native-ADI", source: "USDC" });
await call("get_bridge_options", { token: "USDC.e", direction: "to-adi", network: "mainnet" });
await call("get_balance", { address: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", network: "mainnet" });
await call("estimate_deposit", { network: "mainnet" });
await call("get_bridge_status", { tx_hash: "0x5f542b9eb972d6b3f2a698d2b97ddd1fde20c10c6c271fc3b5eb19fb61133903", network: "mainnet" });
await call("get_withdrawal_params", { tx_hash: "0xed7f67fab1c4e32d8399f255879c576cf7d0495a96d57950b685d2228d0d986a", network: "mainnet" });
await call("get_agent_profile", { agent_id: "1" });

await client.close();
console.log("\nSMOKE OK");
