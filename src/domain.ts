/**
 * ADI Chain domain model: networks, tokens, bridges, and routing rules.
 *
 * All addresses verified against live RPC / Chainlink CCIP directory / the
 * bridge UI config. The deployed config differs from in-repo code — this
 * file is the source of truth for what is live.
 */

export type NetworkId = "mainnet" | "testnet";

export interface Network {
  id: NetworkId;
  chainId: number;
  name: string;
  /** ADI L2 RPC */
  rpcUrl: string;
  /** Ethereum L1 RPC (settlement layer) */
  l1RpcUrl: string;
  l1ChainId: number;
  l1Name: string;
  explorerUrl: string;
  /** Blockscout v1 API host (module/action) */
  explorerApiUrl: string;
  faucetUrl?: string;
  /** L1 Bridgehub (verified via zks_getBridgehubContract) */
  bridgehub: `0x${string}`;
  /** L1 Asset Router */
  l1AssetRouter: `0x${string}`;
  /** L1 Nullifier */
  l1Nullifier: `0x${string}`;
  /** L1 Native Token Vault */
  l1NativeTokenVault: `0x${string}`;
  /** L1 Diamond Proxy (Mailbox/Executor) */
  l1DiamondProxy: `0x${string}`;
  /** L1 ADI ERC-20 */
  l1Adi: `0x${string}`;
  /** L2 system contracts */
  l2BaseToken: `0x${string}`;
  l2AssetRouter: `0x${string}`;
  l2NativeTokenVault: `0x${string}`;
  l1Messenger: `0x${string}`;
  /** CCIP */
  ccipRouter: `0x${string}`;
  ccipChainSelector: bigint;
  ccipOnRamp: `0x${string}`;
  /** ERC-8004 registries (L2) */
  identityRegistry: `0x${string}`;
  reputationRegistry: `0x${string}`;
  validationRegistry: `0x${string}`;
}

export const NETWORKS: Record<NetworkId, Network> = {
  mainnet: {
    id: "mainnet",
    chainId: 36900,
    name: "ADI Mainnet",
    rpcUrl: "https://rpc.adifoundation.ai",
    l1RpcUrl: "https://ethereum-rpc.publicnode.com",
    l1ChainId: 1,
    l1Name: "Ethereum Mainnet",
    explorerUrl: "https://explorer.adifoundation.ai",
    explorerApiUrl: "https://explorer-api.adifoundation.ai",
    bridgehub: "0x7a38c18a229ef8a0ae7104ba272a46280f2d59cb",
    l1AssetRouter: "0xf25227efad2046d19777a4ca540b5c016df7fe7a",
    l1Nullifier: "0x5e5a72077dfb354dfe61200b8f31fa491f9b9cea",
    l1NativeTokenVault: "0x0a0f8912162ff83a036883dbada42eff647a3065",
    l1DiamondProxy: "0x0583ef2b6416cb7b287406438b940e4d99680c5b",
    l1Adi: "0x8b1484d57abbe239bb280661377363b03c89caea",
    l2BaseToken: "0x000000000000000000000000000000000000800A",
    l2AssetRouter: "0x0000000000000000000000000000000000010003",
    l2NativeTokenVault: "0x0000000000000000000000000000000000010004",
    l1Messenger: "0x0000000000000000000000000000000000008008",
    ccipRouter: "0x010771998A1F4736BD844939d0bf01ac5cA0f8fa",
    ccipChainSelector: 4059281736450291836n,
    ccipOnRamp: "0xabd3F7722C178e42DB20065f063B1e758B19FDB6",
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    validationRegistry: "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58",
  },
  testnet: {
    id: "testnet",
    chainId: 99999,
    name: "ADI Testnet (AB)",
    rpcUrl: "https://rpc.ab.testnet.adifoundation.ai",
    l1RpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    l1ChainId: 11155111,
    l1Name: "Ethereum Sepolia",
    explorerUrl: "https://explorer.ab.testnet.adifoundation.ai",
    explorerApiUrl: "https://explorer-api.ab.testnet.adifoundation.ai",
    faucetUrl: "http://faucet.ab.testnet.adifoundation.ai",
    bridgehub: "0xFd3cE61C65dDd1039e6e9e07FB6D6e16388d1cc7",
    l1AssetRouter: "0x5BA5B3a62745cD4eC5a59A22c988b2Dc2ae06573",
    l1Nullifier: "0x0000000000000000000000000000000000000000", // not published; claim unsupported on testnet
    l1NativeTokenVault: "0x0000000000000000000000000000000000000000", // not published
    l1DiamondProxy: "0x0000000000000000000000000000000000000000", // not published
    l1Adi: "0x2a98B46fe31BA8Be05ef1cE3D36e1f80Db04190D",
    l2BaseToken: "0x000000000000000000000000000000000000800A",
    l2AssetRouter: "0x0000000000000000000000000000000000010003",
    l2NativeTokenVault: "0x0000000000000000000000000000000000010004",
    l1Messenger: "0x0000000000000000000000000000000000008008",
    ccipRouter: "0x5D445DF89674096B6A138565cAE955FF816f352D",
    ccipChainSelector: 9418205736192840573n,
    ccipOnRamp: "0xd54205E00835B63Db005ADEF8d99E4984601ACAf",
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", // canonical testnet deployment pending (June 2026)
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    validationRegistry: "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58",
  },
};

export type TokenId = "ADI" | "USDC.e" | "LINK" | "CCIP-BnM";

export interface Token {
  id: TokenId;
  symbol: string;
  name: string;
  decimals: number;
  /** L1 ERC-20 address (Ethereum/Sepolia), if the token exists on L1 */
  l1Address?: `0x${string}`;
  /** L2 address on ADI Chain; the native gas token is the 0x800A system contract */
  l2Address: `0x${string}`;
  /** true = native gas token on ADI L2 */
  isNative: boolean;
  /** which bridges can move this token */
  bridges: BridgeId[];
  /** human-readable constraint notes */
  notes: string[];
}

export type BridgeId = "canonical" | "ccip" | "swap-service";

export interface Bridge {
  id: BridgeId;
  name: string;
  description: string;
  /** direction support: canonical is L1<->L2, ccip is cross-chain lanes */
  kind: "l1-l2" | "cross-chain" | "off-chain";
  /** deposit time estimate (human) */
  depositTime: string;
  /** withdrawal time estimate (human) */
  withdrawTime: string;
  /** security model */
  security: string;
  /** whether the MCP can execute it (vs advisory-only) */
  executable: boolean;
}

export const BRIDGES: Record<BridgeId, Bridge> = {
  canonical: {
    id: "canonical",
    name: "ADI Canonical Bridge",
    description:
      "Protocol-level bridge between Ethereum (L1) and ADI Chain (L2), secured by ZK validity proofs. Deposits ~15s, withdrawals ~75min (commit → prove → execute) + claim. NOTE: ADI mainnet/testnet run nativeTokenBridgingOnly — only ADI is registered in the Native Token Vault, so in practice only ADI is bridgeable via the canonical bridge today.",
    kind: "l1-l2",
    depositTime: "~15 seconds",
    withdrawTime: "~75 minutes + claim",
    security: "Trustless — every withdrawal verified by a ZK proof on Ethereum. 1:1 backing via chainBalance.",
    executable: true,
  },
  ccip: {
    id: "ccip",
    name: "CCIP (Chainlink)",
    description:
      "Chainlink CCIP lanes to/from ADI Chain. Burn/mint token pools. Used by Transporter, xSwap, and other CCIP apps.",
    kind: "cross-chain",
    depositTime: "~minutes",
    withdrawTime: "~minutes",
    security: "Chainlink CCIP — DON-secured cross-chain messaging with burn/mint pools.",
    executable: true,
  },
  "swap-service": {
    id: "swap-service",
    name: "Swap services (SimpleSwap, LetsExchange, ChangeHero)",
    description:
      "Non-custodial but centralized swap services that deliver ADI directly to an ADI Mainnet address from 2,800+ source assets. Advisory only — the MCP cannot execute these.",
    kind: "off-chain",
    depositTime: "minutes",
    withdrawTime: "n/a",
    security: "Non-custodial swap service; not on-chain, not executable by the MCP.",
    executable: false,
  },
};

export const TOKENS: Record<TokenId, Token> = {
  ADI: {
    id: "ADI",
    symbol: "ADI",
    name: "ADI Token",
    decimals: 18,
    l1Address: undefined, // per-network (mainnet vs sepolia differ)
    l2Address: "0x000000000000000000000000000000000000800A",
    isNative: true,
    bridges: ["canonical", "swap-service"],
    notes: [
      "Dual nature: ERC-20 on Ethereum L1, native gas token on ADI L2.",
      "Canonical bridge converts between the two: deposit mints native, withdrawal burns native and releases ERC-20 on L1.",
      "MEXC supports direct ADI Network withdrawal (confirmed 2026-08). Other CEXs: withdraw as ERC-20 and bridge.",
    ],
  },
  "USDC.e": {
    id: "USDC.e",
    symbol: "USDC.e",
    name: "USDC.e (bridged USDC)",
    decimals: 6,
    l2Address: "0x9cb8142aEBBcdc60AF7c97Af897A67A8f3CA71C2",
    isNative: false,
    bridges: ["ccip", "swap-service"],
    notes: [
      "CCIP burn/mint token — can ONLY move via CCIP lanes, never the canonical bridge.",
      "USDC.e is STUCK on ADI Mainnet: no on-chain DEX with liquidity exists, so it cannot be swapped to native ADI on-chain.",
      "To get native ADI from USDC.e: bridge back to Ethereum via CCIP → swap USDC→ADI on Uniswap V3 → canonical bridge ADI to ADI Mainnet.",
    ],
  },
  LINK: {
    id: "LINK",
    symbol: "LINK",
    name: "ChainLink Token",
    decimals: 18,
    l2Address: "0x76a443768A5e3B8d1AED0105FC250877841Deb40",
    isNative: false,
    bridges: ["ccip"],
    notes: ["CCIP burn/mint token on ADI Mainnet. Also a CCIP fee token."],
  },
  "CCIP-BnM": {
    id: "CCIP-BnM",
    symbol: "CCIP-BnM",
    name: "CCIP-BnM",
    decimals: 18,
    l2Address: "0x23577b74c98325f9e70677EA8B72707F06625343",
    isNative: false,
    bridges: ["ccip"],
    notes: [
      "The ONLY CCIP token on ADI Testnet. USDC is NOT on ADI testnet CCIP — testnet stablecoin flows cannot be exercised end-to-end via CCIP.",
    ],
  },
};

/** Resolve a token's L1 address for a network, or undefined if it has none. */
export function l1AddressFor(token: TokenId, network: NetworkId): `0x${string}` | undefined {
  if (token === "ADI") return NETWORKS[network].l1Adi;
  return TOKENS[token].l1Address;
}

/** Resolve a token by symbol (case-insensitive), or by L2/L1 address. */
export function resolveToken(query: string, network: NetworkId): Token | undefined {
  const q = query.trim().toLowerCase();
  if (q === "adi" || q === "tadi") return TOKENS.ADI;
  for (const t of Object.values(TOKENS)) {
    if (t.symbol.toLowerCase() === q) return t;
  }
  const addr = q.toLowerCase() as `0x${string}`;
  for (const t of Object.values(TOKENS)) {
    if (t.l2Address.toLowerCase() === addr) return t;
    const l1 = l1AddressFor(t.id, network);
    if (l1 && l1.toLowerCase() === addr) return t;
  }
  return undefined;
}

/** CCIP lanes per network: destination chain name -> supported tokens. */
export const CCIP_LANES: Record<NetworkId, Record<string, TokenId[]>> = {
  mainnet: {
    "Ethereum": ["USDC.e", "LINK"],
    "Arbitrum One": ["USDC.e", "LINK"],
    "Base": ["USDC.e", "LINK"],
    "Solana": ["USDC.e", "LINK"],
  },
  testnet: {
    "Ethereum Sepolia": ["CCIP-BnM"],
    "Arbitrum Sepolia": ["CCIP-BnM"],
    "Base Sepolia": ["CCIP-BnM"],
    "Solana Devnet": ["CCIP-BnM"],
  },
};

/** Swap services (advisory only). */
export const SWAP_SERVICES = [
  { name: "SimpleSwap", url: "https://simpleswap.io", note: "2,800+ assets → ADI delivered to ADI Mainnet wallet" },
  { name: "LetsExchange", url: "https://letsexchange.io", note: "6,000+ assets" },
  { name: "ChangeHero", url: "https://changehero.io", note: "300+ assets" },
];

/** Default L2 gas limit for a canonical bridge deposit (bridge UI uses estimateL1ToL2Execute; the RPC does not expose it, so we use the zkSync-era default). */
export const DEFAULT_DEPOSIT_GAS_LIMIT = 1_000_000n;
/** gasPerPubdataByteLimit used by the bridge UI (Kv=800). */
export const GAS_PER_PUBDATA = 800n;
