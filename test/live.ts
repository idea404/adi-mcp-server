/**
 * Live end-to-end write-path test: deposit ADI L1→L2, verify L2 balance,
 * withdraw back to L1. Requires a funded key. Run:
 * ADI_MCP_PRIVATE_KEY=0x... bun run test/live.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ADDRESS = "0x150f6189bc3C7FC54d4D8c670F2CE89c284B376F";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "src/cli.ts"],
  cwd: new URL("..", import.meta.url).pathname,
  env: { ADI_MCP_PRIVATE_KEY: process.env.ADI_MCP_PRIVATE_KEY ?? "" },
});
const client = new Client({ name: "live", version: "0.0.1" });
await client.connect(transport);

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text?: string }[];
  return content.find((c) => c.type === "text")?.text ?? "";
}

const depositAmount = process.env.DEPOSIT_AMOUNT ?? "0.5";
const withdrawAmount = process.env.WITHDRAW_AMOUNT ?? "0.1";

console.log("=== bridge_deposit ===");
const depositRes = await call("bridge_deposit", {
  network: "mainnet",
  token: "0x8b1484d57abbe239bb280661377363b03c89caea", // ADI ERC-20 L1
  amount: depositAmount,
  to: ADDRESS,
});
console.log(depositRes);
const deposit = JSON.parse(depositRes);
const l2Tx = deposit.canonicalTxHash;
if (!l2Tx || l2Tx === "0x") throw new Error("no canonicalTxHash in deposit result");

console.log("\n=== get_bridge_status (canonical L2 tx) ===");
console.log(await call("get_bridge_status", { tx_hash: l2Tx, network: "mainnet" }));

// Wait for the deposit to land on L2 (up to ~90s).
console.log("\n=== waiting for L2 balance ===");
let l2Balance = "0";
for (let i = 0; i < 30; i++) {
  const bal = await call("get_balance", { address: ADDRESS, network: "mainnet" });
  l2Balance = bal.match(/:\s*([\d.]+)\s*ADI/)?.[1] ?? "0";
  if (Number(l2Balance) > 0) break;
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 3000);
  await promise;
}
console.log("L2 native balance after deposit:", l2Balance, "ADI");
if (Number(l2Balance) <= 0) throw new Error("deposit did not land on L2");

console.log("\n=== bridge_withdraw ===");
const withdrawRes = await call("bridge_withdraw", {
  network: "mainnet",
  token: "ADI",
  amount: withdrawAmount,
  l1_receiver: ADDRESS,
});
console.log(withdrawRes);
const withdraw = JSON.parse(withdrawRes);

console.log("\n=== get_bridge_status (withdrawal tx) ===");
console.log(await call("get_bridge_status", { tx_hash: withdraw.txHash, network: "mainnet" }));

console.log("\n=== get_balance (L2 native, after withdrawal) ===");
console.log(await call("get_balance", { address: ADDRESS, network: "mainnet" }));

await client.close();
console.log("\nLIVE OK");
