# ADI Chain MCP Server — Design & Proposal

**Status:** Proposal · **Date:** 2026-08-07 · **Author:** Dennis

An MCP server that abstracts ADI Chain's supported services — canonical bridge, CCIP, and the ADI network itself — into tools an AI agent can call directly. The goal: agents can answer "how do I get USDC from Ethereum onto ADI Chain?" and then actually execute it, instead of pointing a human at a bridge UI.

---

## 1. Why this exists

ADI Chain is EVM-equivalent, so generic EVM MCP servers (`evm-mcp-server`, Blockscout MCP, etc.) already work against our RPC. What they do **not** know:

- Which bridges exist for ADI, which tokens each supports, and the constraints of each (e.g. USDC.e can only move via CCIP, never the canonical bridge).
- The canonical bridge's Two Bridges deposit pattern (ERC20 deposits need ADI on L1 for L2 gas).
- The real-world onboarding paths (CEX → ERC-20 → bridge) and their tradeoffs.
- ADI-specific contracts: Bridgehub, Asset Router, L2 system contracts (`0x800A`, `0x10003`, `0x10004`), ERC-8004 registries.

This server encodes that domain knowledge as tools, so agents get correct answers and correct transactions without re-researching the ecosystem each time.

**Funding use case (the one that motivated this):** an agent needs to fund itself with native ADI on ADI Mainnet. The correct path is: buy/withdraw ADI as ERC-20 on Ethereum → canonical bridge deposit → native ADI on L2. Bridging USDC from Ethereum lands as **USDC.e**, which is stuck (no DEX on ADI Mainnet) unless the agent multi-hops back out. The MCP should know this and steer the agent to the right path.

---

## 2. What the MCP knows (domain model)

### 2.1 Networks

| | Mainnet | Testnet (AB) |
|---|---|---|
| Chain ID | `36900` | `99999` |
| RPC | `https://rpc.adifoundation.ai` | `https://rpc.ab.testnet.adifoundation.ai` |
| Explorer | explorer.adifoundation.ai | explorer.ab.testnet.adifoundation.ai |
| Blockscout API | explorer.adifoundation.ai/api | explorer.ab.testnet.adifoundation.ai/api |
| Gas token | ADI (native) | ADI (native) |
| L1 ADI (ERC-20) | `0x8b1484d57abbe239bb280661377363b03c89caea` (Ethereum) | `0x2a98b46fe31ba8be05ef1ce3d36e1f80db04190d` (Sepolia) |
| Faucet | — | http://faucet.ab.testnet.adifoundation.ai |

### 2.2 Bridges

**A. Canonical bridge (L1 Ethereum ↔ ADI L2)** — ZK-proven, trustless, the "default bridge".

Mainnet L1 contracts (verified against docs.adi.foundation/network-contracts and on-chain code):

| Contract | Address |
|---|---|
| Bridgehub | `0x7a38c18a229ef8a0ae7104ba272a46280f2d59cb` |
| L1 Asset Router | `0xf25227efad2046d19777a4ca540b5c016df7fe7a` |
| L1 Nullifier | `0x5e5a72077dfb354dfe61200b8f31fa491f9b9cea` |
| Native Token Vault | `0x0a0f8912162ff83a036883dbada42eff647a3065` |
| Diamond Proxy (Mailbox/Executor) | `0x0583ef2b6416cb7b287406438b940e4d99680c5b` |

Testnet L1 (Sepolia): Bridgehub `0xFd3cE61C65dDd1039e6e9e07FB6D6e16388d1cc7`, Asset Router `0x5BA5B3a62745cD4eC5a59A22c988b2Dc2ae06573`.

L2 system contracts (both networks): L2 Base Token `0x0000...0000800A`, L2 Asset Router `0x0000...00010003`, L2 Native Token Vault `0x0000...00010004`, L1 Messenger `0x0000...00008008`.

- **Deposits (L1→L2):** ~15s. ADI base token → `requestL2TransactionDirect()` on Bridgehub. Any ERC-20 → `requestL2TransactionTwoBridges()` (Two Bridges pattern: locks ADI for L2 gas + locks the ERC-20; user must hold ADI on L1 for gas).
- **Withdrawals (L2→L1):** ~75min (commit → ZK prove → execute) + claim via Nullifier.
- **Supports:** ADI + any standard ERC-20. First-time tokens auto-deploy a `BridgedStandardERC20` (BeaconProxy, CREATE2) on L2.

**B. CCIP (Chainlink) — Transporter / xSwap / any CCIP app**

Mainnet (Chainlink CCIP directory, live):

| | Value |
|---|---|
| Router | `0x010771998A1F4736BD844939d0bf01ac5cA0f8fa` |
| Chain selector | `4059281736450291836` |
| Lanes | Ethereum, Arbitrum One, Base, Solana (all via onRamp `0xabd3F7722C178e42DB20065f063B1e758B19FDB6`, v1.6.0) |
| Tokens | **USDC.e** `0x9cb8142aEBBcdc60AF7c97Af897A67A8f3CA71C2` (burn/mint), **LINK** `0x76a443768A5e3B8d1AED0105FC250877841Deb40` |
| Fee tokens | LINK, WADI, ADI |

Testnet (AB Testnet):

| | Value |
|---|---|
| Router | `0x5D445DF89674096B6A138565cAE955FF816f352D` |
| Chain selector | `9418205736192840573` |
| Lanes | Ethereum Sepolia, Arbitrum Sepolia, Base Sepolia, Solana Devnet |
| Tokens | **CCIP-BnM only** (`0x23577b74c98325f9e70677EA8B72707F06625343`) — **USDC is NOT on ADI testnet CCIP** |

**C. Swap services (off-chain, non-custodial)** — SimpleSwap, LetsExchange, ChangeHero. Deliver ADI directly to an ADI Mainnet address from 2,800+ source assets. No on-chain integration; the MCP can only surface them as a recommendation, not execute.

### 2.3 Tokens (registry)

The ADI token is the primary bridging asset and has a **dual nature**: an ERC-20 on Ethereum L1, and the **native gas token** on ADI Chain L2. The canonical bridge converts between the two — this is the core flow the MCP exists to serve.

| Token | Network | Address | Role |
|---|---|---|---|
| **ADI** | Ethereum mainnet (L1) | `0x8b1484d57abbe239bb280661377363b03c89caea` | ERC-20, source for canonical bridge deposits |
| **tADI** | Ethereum Sepolia (L1) | `0x2a98b46fe31ba8be05ef1ce3d36e1f80db04190d` | Testnet ERC-20, same role |
| **ADI** | ADI Mainnet (L2) | native (`0x0000...0000800A` system contract) | Gas token; minted by bridge deposit, burned by withdrawal |
| **tADI** | ADI Testnet (L2) | native (`0x0000...0000800A`) | Gas token |
| **USDC.e** | ADI Mainnet (L2) | `0x9cb8142aEBBcdc60AF7c97Af897A67A8f3CA71C2` | CCIP burn/mint — **canonical bridge cannot move it** |
| **LINK** | ADI Mainnet (L2) | `0x76a443768A5e3B8d1AED0105FC250877841Deb40` | CCIP burn/mint |
| **CCIP-BnM** | ADI Testnet (L2) | `0x23577b74c98325f9e70677EA8B72707F06625343` | Only CCIP token on testnet |

The MCP's `get_token_info` and `get_bridge_options` tools resolve against this registry, so an agent asking "bridge ADI from Ethereum to ADI Chain" gets the L1 ERC-20 address, the native L2 representation, and the canonical-bridge route in one answer.

### 2.4 Token constraints (the critical knowledge)

- **USDC.e on ADI Mainnet is a CCIP burn/mint token.** It can only enter and exit via CCIP lanes. It **cannot** be withdrawn through the canonical bridge. (This is the "USDC.e is stuck" problem.)
- **No on-chain AMM/DEX with liquidity pools exists on ADI Mainnet** (DefiLlama: zero DEX TVL; ecosystem map DEX entries are P2P/aggregators/swap services). So USDC.e → native ADI is not swappable on-chain today.
- **Native ADI on ADI Mainnet can only be obtained by:** canonical bridge deposit of L1 ADI ERC-20, or a swap service delivering ADI, or (unconfirmed) CEX direct withdrawal.
- **USDC.e → native ADI workaround (multi-hop):** CCIP USDC.e back to Ethereum → swap USDC→ADI on Uniswap V3 (real pool, ~$2.7M) → canonical bridge ADI → ADI Mainnet.

---

## 3. Tool surface (proposal)

### 3.1 Read / query tools (no signing)

| Tool | Returns |
|---|---|
| `get_network_info(network)` | RPC, chain ID, explorer, gas token, faucet |
| `get_balance(address, network, token?)` | Native ADI and/or ERC-20 balance |
| `get_bridge_options(from_chain, to_chain, token)` | Which bridges support this route, token constraints, fees/timing, recommended path |
| `get_bridge_status(tx_hash)` | Deposit/withdrawal progress (L1→L2, batch commit/prove/execute, claimable) |
| `get_token_info(token_address, network)` | Symbol, decimals, bridged-vs-native, which bridge it can move through. For ADI: resolves the L1 ERC-20 ↔ L2 native duality |
| `get_ccip_lanes(network)` | Live CCIP lanes + supported tokens per lane |
| `get_erc8004_agent(agent_id)` | Agent identity/reputation/validation from the registries |
| `get_gas_price(network)` | Current L2 gas price (for cost estimates) |

### 3.2 Write / execute tools (signing via wallet)

| Tool | What it does |
|---|---|
| `bridge_deposit(token, amount, to_address, network)` | Canonical bridge deposit. Picks Direct vs Two Bridges automatically; handles approvals; estimates L2 gas cost in ADI. For ADI: `requestL2TransactionDirect()` (ERC-20 on L1 → native on L2) |
| `bridge_withdraw(token, amount, l1_receiver, network)` | L2→L1 withdrawal via L2 Base Token / L2 Asset Router |
| `claim_withdrawal(batch, index, proof, network)` | Claim a finalized withdrawal on L1 via Nullifier |
| `ccip_transfer(token, amount, destination_chain, receiver)` | CCIP token transfer via Router (USDC.e/LINK on mainnet; CCIP-BnM on testnet) |
| `send_transaction(to, value, data, network)` | Generic EVM tx (fallback for anything not covered) |

### 3.3 Planning / advisory tools

| Tool | What it does |
|---|---|
| `plan_funding_path(amount, target_network, source_assets)` | Returns the best route(s) to get native ADI (or a specific token) onto ADI Chain, with steps, costs, timing, and caveats. Encodes the onboarding-path knowledge from the PRYPCO research |
| `estimate_bridge_cost(route, amount)` | Gas + bridge fees for a candidate route |

**Design principle:** advisory tools never guess — they are backed by the static domain model (section 2) plus live RPC/explorer data. If a route is not supported (e.g. USDC.e via canonical bridge), the tool says so and offers the working alternative.

---

## 4. Architecture

```
AI agent (Claude/Cursor/any MCP client)
        │  MCP (stdio or HTTP/SSE)
        ▼
┌─────────────────────────────────────────────┐
│ adi-mcp-server (TypeScript, MCP SDK)        │
│  • tools/        — one module per tool      │
│  • domain/       — networks, bridges,       │
│                    tokens (static config)   │
│  • providers/    — viem clients per network │
│  • wallet/       — signer abstraction       │
│  • explorer/     — Blockscout REST client   │
└──────┬──────────────────────────┬───────────┘
       │                          │
       ▼                          ▼
  ADI RPC (viem)            Blockscout API
  Ethereum RPC (viem)       (tx status, proofs)
```

- **Language:** TypeScript + [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) + viem. Matches the ecosystem (docs already recommend `@adi-devtools/sdk`-style wrappers) and keeps the server portable to any MCP client.
- **Transport:** stdio first (local agents), HTTP/SSE later (remote agents).

### Distribution

**One surface: clone, audit, install globally.** No npm package, no npx — the point is to make reading the source the *required* step.

```bash
git clone <repo-url>
cd adi-mcp-server
bun i -g .          # installs globally from the audited clone
adi-mcp-server      # binary on PATH via package.json "bin"
```

Client config snippet (works in Claude Desktop, Cursor, `.mcp.json`, etc.):

```json
{
  "mcpServers": {
    "adi": {
      "command": "adi-mcp-server",
      "env": { "ADI_NETWORK": "mainnet" }
    }
  }
}
```

Notes:

- Global install requires a `bin` field in package.json (`"bin": { "adi-mcp-server": "./dist/cli.js" }`) — the binary lands on PATH after install.
- Commit a lockfile and document `bun i --frozen-lockfile` so the audited dependency tree is reproducible at install time.
- Update loop for auditors: `git pull && bun i -g .`. `bun link` is the live-dev variant (symlink to the clone, edits take effect on restart).
- Machines without bun can `npm i -g .` from the same clone; both resolve from the local directory, never a registry artifact.
- Optional escape hatch for non-dev machines: `bun build --compile` from the clone produces a standalone binary with zero runtime deps — built locally, so it is still audited code.
- Stdio MCP servers spawn per client session; the global install starts instantly (no npx cold start).
- `uv` was considered and rejected: it implies a Python implementation, which loses viem/`@adi-devtools/sdk` and re-implements what the TS ecosystem already ships.
- **Signing:** never hold keys. Accept a private key / mnemonic via env, or (preferred) delegate signing to the client via a `sign_transaction` round-trip, or integrate a wallet MCP (e.g. WalletChan) for popup approvals. For a DevRel/internal server, env-key signing is acceptable; for public use, client-side signing is required.
- **Data freshness:** static config (contracts, tokens) in `domain/` with a `verify` script that re-checks addresses against RPC/explorers (the deployed config differs from in-repo code — see AGENTS.md). Live data (balances, status, gas) always fetched at call time.
- **Testnet parity:** every tool takes a `network` param; testnet uses Sepolia L1 + AB Testnet L2 + CCIP testnet router. Note the testnet CCIP token gap (CCIP-BnM only) — the server should surface this rather than pretend USDC works on testnet.

---

## 5. Roadmap

1. **Phase 1 — Read-only (this is the 80% value):** `get_bridge_options`, `plan_funding_path`, `get_balance`, `get_token_info`, `get_ccip_lanes`, `get_bridge_status`. No signing. Agents get correct answers to "how do I get X onto ADI?" — the PRYPCO problem, solved for every future asker.
2. **Phase 2 — Canonical bridge execution:** `bridge_deposit` (Direct + Two Bridges), `bridge_withdraw`, `claim_withdrawal`. This is the "default bridge" wired in.
3. **Phase 3 — CCIP execution:** `ccip_transfer` via the Router (works for Transporter-style flows; xSwap-style swaps need a DEX aggregator integration, blocked until ADI has DEX liquidity).
4. **Phase 4 — ERC-8004 + agent identity:** `get_erc8004_agent`, register/reputation/validation tools, so agents can discover and trust each other on-chain.

---

## 6. Open questions

1. **Signing model** — env key (internal) vs client-side signing (public)? Determines whether Phase 2/3 tools are safe to ship as-is.
2. **Hosting** — local stdio server for DevRel/internal use, or a hosted HTTP endpoint for ecosystem partners?
3. **CCIP testnet USDC** — worth asking Chainlink/Transporter to add USDC to ADI testnet CCIP; until then testnet stablecoin flows can't be exercised end-to-end.
4. **DEX gap** — the single biggest constraint on ADI today. An MCP can route around it (multi-hop, swap services) but can't fix it. Flagging for ecosystem work.

---

## 7. Sources

- ADI docs: [The Bridge](https://docs.adi.foundation/how-to-start/the-bridge.md), [Canonical Bridge](https://docs.adi.foundation/adi-network-components/canonical-bridge.md), [Network Contracts](https://docs.adi.foundation/how-to-start/network-contracts.md), [Tools for Agents](https://docs.adi.foundation/core-components/ai-agent-infrastructure/tools-for-agents.md)
- Chainlink CCIP directory: [ADI mainnet](https://docs.chain.link/ccip/directory/mainnet/chain/adi-mainnet), [ADI testnet](https://docs.chain.link/ccip/directory/testnet/chain/adi-testnet), [USDC mainnet](https://docs.chain.link/ccip/directory/mainnet/token/USDC), [USDC testnet](https://docs.chain.link/ccip/directory/testnet/token/USDC), [LINK mainnet](https://docs.chain.link/ccip/directory/mainnet/token/LINK), [CCIP-BnM testnet](https://docs.chain.link/ccip/directory/testnet/token/CCIP-BnM)
- Prior research: `prypco/adi-onboarding-paths.md`, `prypco/recommendation.md` (2026-08-03/04, PRYPCO onboarding research)
- On-chain verification (2026-08-07): chain IDs via `cast`, USDC.e/CCIP-BnM symbols via RPC, L1 bridge contract code via Ethereum RPC
