import { isAddress, parseUnits, type Address } from "viem";
import { CCIP_LANES, NETWORKS, type NetworkId, type Token } from "./domain.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type NetworkCapability = "canonicalDeposit" | "canonicalWithdraw" | "claim" | "ccip";

/**
 * Capabilities the MCP may exercise per network.
 *
 * Testnet is intentionally limited to CCIP: the canonical bridge and the L1
 * Nullifier are not published on Sepolia (their addresses are 0x0 in the
 * domain model), so a deposit, withdrawal, or claim there would target a
 * nonexistent contract. Failing closed here gives a clear error instead of a
 * confusing on-chain revert.
 */
const NETWORK_CAPABILITIES: Record<NetworkId, Partial<Record<NetworkCapability, true>>> = {
  mainnet: { canonicalDeposit: true, canonicalWithdraw: true, claim: true, ccip: true },
  testnet: { ccip: true },
};

export function isZeroAddress(value: string): boolean {
  return value.toLowerCase() === ZERO_ADDRESS;
}

export function assertNetworkCapability(network: NetworkId, capability: NetworkCapability): void {
  if (!NETWORK_CAPABILITIES[network][capability]) {
    throw new Error(`${capability} is not supported on ${NETWORKS[network].name}`);
  }
}

export function assertAddress(value: string, label: string): asserts value is Address {
  if (!isAddress(value) || isZeroAddress(value)) {
    throw new Error(`Invalid ${label} address`);
  }
}

export function parsePositiveAmount(value: string, decimals: number, label = "amount"): bigint {
  let parsed: bigint;
  try {
    parsed = parseUnits(value, decimals);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  if (parsed <= 0n) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

export function assertCanonicalToken(network: NetworkId, token: Token): void {
  if (token.id !== "ADI" || !token.isNative || network !== "mainnet") {
    throw new Error(`Only ADI is currently supported by the canonical bridge on ${NETWORKS[network].name}`);
  }
}

/**
 * CCIP token support is read from the domain model's lane table
 * (`CCIP_LANES[network]`) — the documented source of truth for which tokens
 * move on which lanes. Adding a lane or token there is enough; this check
 * must not hardcode its own copy of that list.
 */
export function assertCcipToken(network: NetworkId, token: Token): void {
  const laneTokens = Object.values(CCIP_LANES[network]).flat();
  if (!laneTokens.includes(token.id) || !token.bridges.includes("ccip")) {
    throw new Error(`${token.symbol} is not supported by CCIP on ${NETWORKS[network].name}`);
  }
}

export function assertDestinationSelector(network: NetworkId, selector: bigint): void {
  if (selector <= 0n || selector === NETWORKS[network].ccipChainSelector) {
    throw new Error("Invalid CCIP destination chain selector");
  }
}
