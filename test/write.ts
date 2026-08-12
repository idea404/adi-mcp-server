/**
 * Verify write-tool registration and deposit tx construction against live RPC.
 * Uses a throwaway private key (no funds) — nothing is sent.
 * Run: ADI_MCP_PRIVATE_KEY=0x... bun run test/write.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { decodeFunctionData } from "viem";
import { previewDepositTx } from "../src/tools.ts";
import { NETWORKS } from "../src/domain.ts";

// 1. Deposit tx construction (no signing)
const net = NETWORKS.mainnet;
const from = "0x0000000000000000000000000000000000000001" as const;
const to = "0x0000000000000000000000000000000000000002" as const;
const amount = 1000000000000000000n; // 1 ADI

const preview = await previewDepositTx("mainnet", net.l1Adi, amount, to, from);
console.log("=== ADI deposit tx preview ===");
console.log("to:", preview.to);
console.log("value:", preview.value.toString());
console.log("mintValue:", preview.mintValue.toString());
console.log("isAdi:", preview.isAdi);

const decoded = decodeFunctionData({
  abi: (await import("../src/abis/bridgehub.json", { with: { type: "json" } })).default,
  data: preview.data,
});
console.log("function:", decoded.functionName);
console.log("request:", JSON.stringify(decoded.args, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

// 2. Write-tool registration via MCP handshake
const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "src/cli.ts"],
  cwd: new URL("..", import.meta.url).pathname,
  env: { ADI_MCP_PRIVATE_KEY: process.env.ADI_MCP_PRIVATE_KEY ?? "" },
});
const client = new Client({ name: "write-smoke", version: "0.0.1" });
await client.connect(transport);
const tools = await client.listTools();
const writeTools = tools.tools.filter((t) => ["bridge_deposit", "bridge_withdraw", "ccip_transfer"].includes(t.name));
console.log("\n=== write tools registered ===");
for (const t of writeTools) console.log(`  - ${t.name}`);
await client.close();
console.log(writeTools.length === 3 ? "WRITE OK" : "WRITE FAIL");
