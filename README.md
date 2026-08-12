# ADI Chain MCP Server

MCP server for ADI Chain: canonical bridge, CCIP, and network tools for AI agents.

Agents can answer — and execute — "how do I get USDC from Ethereum onto ADI Chain?" instead of pointing a human at a bridge UI. The server encodes ADI's domain knowledge: which bridges exist, which tokens each supports, and the constraints (USDC.e is CCIP-only and stuck on ADI Mainnet; no DEX liquidity exists on ADI Mainnet).

## Install

Clone, audit, install globally. Reading the source is the point.

```bash
git clone <repo-url>
cd adi-mcp-server
bun i -g .          # installs globally from the audited clone
adi-mcp-server      # binary on PATH via package.json "bin"
```

Machines without bun: `npm i -g .` from the same clone. Update: `git pull && bun i -g .`.

## Configure

Add to your MCP client (Claude Desktop, Cursor, `.mcp.json`, …):

```json
{
  "mcpServers": {
    "adi": {
      "command": "adi-mcp-server",
      "env": { "ADI_MCP_PRIVATE_KEY": "0x..." }
    }
  }
}
```

`ADI_MCP_PRIVATE_KEY` is optional. Without it the server runs read-only: `bridge_deposit`, `bridge_withdraw`, and `ccip_transfer` are disabled. The server never stores keys.

## Tools

### Read / query

| Tool | What it returns |
|---|---|
| `get_network_info` | RPC, chain ID, explorer, bridge + CCIP contract addresses |
| `get_token_info` | Token addresses (L1/L2), decimals, which bridges can move it |
| `get_balance` | Native ADI or ERC-20 balance on ADI Chain |
| `get_bridge_options` | Which bridges support a token route, with constraints |
| `get_ccip_lanes` | CCIP lanes and supported tokens per lane |
| `get_bridge_status` | Finality of a tx: pending / committed / executed |
| `get_finality_status` | Node finality frontiers |
| `estimate_deposit` | L1 base cost of a canonical bridge deposit (in ADI) |
| `get_withdrawal_params` | Claim params for a withdrawal: batch, message index, message, Merkle proof |
| `get_agent_profile` | ERC-8004 agent identity + reputation + validation (mainnet) |

### Advisory

| Tool | What it returns |
|---|---|
| `plan_funding_path` | Best routes to get native ADI (or a token) onto ADI Chain, with steps, costs, caveats |
| `get_swap_services` | Non-custodial swap services that deliver ADI (advisory only) |

### Write (require `ADI_MCP_PRIVATE_KEY`)

| Tool | What it does |
|---|---|
| `bridge_deposit` | Canonical bridge deposit: ADI ERC-20 (L1) → native ADI (L2). Approves the L1 Asset Router, deposits, returns L1 + canonical L2 tx hashes |
| `bridge_withdraw` | L2 → L1 withdrawal (native ADI or bridged ERC-20). ~75 min + claim |
| `claim_withdrawal` | Claim a finalized withdrawal on L1 via the Nullifier (params from `get_withdrawal_params` or rebuilt from the tx hash) |
| `ccip_transfer` | CCIP token transfer (USDC.e, LINK on mainnet; CCIP-BnM on testnet) |

## Known constraints (encoded in the domain model)

- **ADI mainnet/testnet run `nativeTokenBridgingOnly`** — only ADI is registered in the canonical bridge's Native Token Vault. ERC-20 deposits via the Two Bridges pattern are protocol-supported but not configured; the server rejects them with a clear error pointing to CCIP.
- **USDC.e is a CCIP burn/mint token** — it can only move via CCIP lanes, never the canonical bridge.
- **No on-chain DEX with liquidity exists on ADI Mainnet** — USDC.e cannot be swapped to native ADI on-chain. The multi-hop path (CCIP back to Ethereum → Uniswap → canonical bridge) is the workaround.
- **CCIP on ADI testnet supports only CCIP-BnM** — USDC is not on ADI testnet CCIP.

## Development

```bash
bun i
bun run typecheck   # tsc --noEmit
bun test            # unit tests (routing, token resolution)
bun run test/smoke.ts   # live smoke test against mainnet RPC
bun run test/write.ts   # write-tool registration + deposit tx construction (needs ADI_MCP_PRIVATE_KEY)
```

## Architecture

```
src/
  cli.ts        MCP server entry (stdio)
  tools.ts      tool definitions + registration
  domain.ts     networks, tokens, bridges, constraints (source of truth)
  routing.ts    funding-path planning
  providers.ts  viem clients + Blockscout v1 API + zks_* RPC
  bridge.ts     canonical bridge deposit/withdraw/claim construction
  ccip.ts       CCIP ccipSend construction
  erc8004.ts    ERC-8004 registry reads (identity, reputation, validation)
  abis/         vendored ABIs (verified against live contracts)
```

All contract addresses and ABIs were verified against live RPC, the Chainlink CCIP directory, and the bridge UI bundle.

## License

MIT
