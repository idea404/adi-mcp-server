/**
 * Route planning: given a source asset and a target, find the viable paths
 * onto ADI Chain. Encodes the token constraints from the domain model —
 * most importantly that USDC.e can only move via CCIP and cannot be swapped
 * to native ADI on-chain (no DEX liquidity on ADI Mainnet).
 */

import {
  BRIDGES,
  CCIP_LANES,
  NETWORKS,
  SWAP_SERVICES,
  TOKENS,
  type BridgeId,
  type NetworkId,
  type Token,
  type TokenId,
} from "./domain.ts";

export interface RouteStep {
  action: string;
  detail: string;
  bridge?: BridgeId;
  /** estimated time for this step */
  time?: string;
}

export interface Route {
  id: string;
  title: string;
  /** 1 = most recommended */
  rank: number;
  steps: RouteStep[];
  /** human summary of costs */
  cost: string;
  /** human summary of total time */
  time: string;
  /** why this route is or isn't recommended */
  caveats: string[];
  /** whether the MCP can execute this route */
  executable: boolean;
}

export interface FundingPlan {
  target: "native-ADI" | TokenId;
  network: NetworkId;
  routes: Route[];
  /** hard constraints that block some routes */
  constraints: string[];
}

function bridgeName(id: BridgeId): string {
  return BRIDGES[id].name;
}

/**
 * Plan how to get `target` (default: native ADI) onto `network` from a
 * starting asset. `source` is a token symbol ("USDC", "ADI", "ETH", ...) or
 * undefined for "any".
 */
export function planFundingPath(
  network: NetworkId,
  target: "native-ADI" | TokenId = "native-ADI",
  source?: string,
): FundingPlan {
  const net = NETWORKS[network];
  const constraints: string[] = [];
  const routes: Route[] = [];

  if (target === "native-ADI") {
    // Route 1: canonical bridge deposit of L1 ADI (the recommended path)
    routes.push({
      id: "canonical-adi",
      title: "Canonical bridge: ADI ERC-20 (L1) → native ADI (L2)",
      rank: 1,
      steps: [
        { action: "Acquire ADI ERC-20 on Ethereum", detail: "Buy on KuCoin/Kraken/Crypto.com and withdraw as ERC-20 (Ethereum network). No CEX is confirmed to support direct ADI Network withdrawal.", time: "minutes" },
        { action: "Approve + deposit via canonical bridge", detail: `Approve the L1 Asset Router (${net.l1AssetRouter}) to spend ADI, then call requestL2TransactionDirect on Bridgehub (${net.bridgehub}).`, bridge: "canonical", time: "~15 seconds" },
        { action: "Receive native ADI", detail: "ADI arrives as native gas token on ADI Chain L2.", time: "~15 seconds" },
      ],
      cost: "CEX withdrawal fee + L1 gas + L2 gas (paid in ADI)",
      time: "minutes (CEX) + ~15s (bridge)",
      caveats: ["Most reliable path. Requires a CEX account + KYC for initial ADI acquisition."],
      executable: true,
    });

    // Route 2: swap service (advisory only)
    routes.push({
      id: "swap-service",
      title: "Swap service: any asset → ADI delivered to ADI Mainnet",
      rank: 2,
      steps: [
        { action: "Choose a swap service", detail: SWAP_SERVICES.map((s) => `${s.name} (${s.note})`).join("; "), bridge: "swap-service", time: "minutes" },
        { action: "Provide ADI Mainnet address", detail: "The service delivers ADI directly to your ADI Mainnet wallet — no bridging needed." },
      ],
      cost: "Swap fee + network fee",
      time: "minutes",
      caveats: ["Non-custodial but centralized swap services, not DeFi. Not executable by the MCP."],
      executable: false,
    });

    // Route 3: USDC → ADI multi-hop (only if the user starts with USDC)
    if (!source || /usdc/i.test(source)) {
      routes.push({
        id: "usdc-multihop",
        title: "USDC → ADI multi-hop (CCIP + Uniswap + canonical bridge)",
        rank: 3,
        steps: [
          { action: "Bridge USDC → ADI Mainnet via CCIP", detail: "USDC arrives as USDC.e (burn/mint token).", bridge: "ccip", time: "~minutes" },
          { action: "Bridge USDC.e back to Ethereum via CCIP", detail: "USDC.e cannot be swapped on ADI Mainnet — no DEX liquidity. Bridge it back out.", bridge: "ccip", time: "~minutes" },
          { action: "Swap USDC → ADI on Uniswap V3 (Ethereum)", detail: "There is a real ADI/USDC pool on Ethereum L1 (~$2.7M liquidity).", time: "~30s" },
          { action: "Canonical bridge ADI → ADI Mainnet", detail: "Deposit the ADI ERC-20 via the canonical bridge to get native ADI.", bridge: "canonical", time: "~15 seconds" },
        ],
        cost: "2× CCIP fees + Uniswap swap fee + L1 gas + L2 gas",
        time: "~10 minutes",
        caveats: [
          "Round-trips through Ethereum because USDC.e is stuck on ADI Mainnet (no DEX).",
          "If you already hold USDC on Ethereum, skip the first hop: swap USDC→ADI on Uniswap, then canonical bridge.",
        ],
        executable: true,
      });
    }

    constraints.push(
      "USDC.e on ADI Mainnet is a CCIP burn/mint token — it can only move via CCIP lanes, never the canonical bridge.",
      "No on-chain AMM/DEX with liquidity pools exists on ADI Mainnet — USDC.e cannot be swapped to native ADI on-chain.",
    );
  } else {
    // Non-ADI target: only CCIP tokens are reachable cross-chain
    const token = TOKENS[target];
    if (token.bridges.includes("ccip")) {
      const lanes = CCIP_LANES[network];
      const laneNames = Object.entries(lanes)
        .filter(([, tokens]) => tokens.includes(target))
        .map(([name]) => name);
      routes.push({
        id: `ccip-${target}`,
        title: `CCIP: bridge ${target} to ADI ${net.name}`,
        rank: 1,
        steps: [
          { action: "Get the token on a source chain", detail: `Source chains with a lane to ADI: ${laneNames.join(", ")}.`, bridge: "ccip", time: "minutes" },
          { action: "Send via CCIP", detail: `Call ccipSend on the ADI CCIP router (${net.ccipRouter}) or use a CCIP app (Transporter, xSwap).`, bridge: "ccip", time: "~minutes" },
        ],
        cost: "CCIP fees + gas",
        time: "~minutes",
        caveats: token.notes,
        executable: true,
      });
    } else {
      constraints.push(`${target} cannot be bridged to ADI Chain by any supported bridge.`);
    }
  }

  return { target, network, routes, constraints };
}

/** Which bridges can move a token between two chains (L1 <-> ADI L2, or CCIP lanes). */
export function bridgeOptionsFor(
  network: NetworkId,
  token: Token,
  direction: "to-adi" | "from-adi",
): { bridge: BridgeId; name: string; supported: boolean; note: string }[] {
  const net = NETWORKS[network];
  const out: { bridge: BridgeId; name: string; supported: boolean; note: string }[] = [];

  const canonical = token.bridges.includes("canonical");
  out.push({
    bridge: "canonical",
    name: BRIDGES.canonical.name,
    supported: canonical,
    note: canonical
      ? direction === "to-adi"
        ? `Deposit via Bridgehub (${net.bridgehub}). ADI: requestL2TransactionDirect. ERC-20: requestL2TransactionTwoBridges (needs ADI on L1 for L2 gas).`
        : `Withdraw via L2 Base Token (0x800A) for ADI, or L2 Asset Router (0x10003) for ERC-20. ~75min + claim.`
      : "This token is not a canonical-bridge asset (CCIP burn/mint tokens cannot use the canonical bridge).",
  });

  const ccip = token.bridges.includes("ccip");
  out.push({
    bridge: "ccip",
    name: BRIDGES.ccip.name,
    supported: ccip,
    note: ccip
      ? `CCIP lanes: ${Object.entries(CCIP_LANES[network]).filter(([, t]) => t.includes(token.id)).map(([n]) => n).join(", ")}. Router ${net.ccipRouter}.`
      : "This token has no CCIP pool on ADI.",
  });

  out.push({
    bridge: "swap-service",
    name: BRIDGES["swap-service"].name,
    supported: true,
    note: "Advisory only — delivers ADI to an ADI Mainnet address; not executable by the MCP.",
  });

  return out;
}
