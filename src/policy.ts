import { isAddress, parseUnits, type Address } from "viem";
import { NETWORKS, type NetworkId, type Token } from "./domain.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type NetworkCapability = "canonicalDeposit" | "canonicalWithdraw" | "claim" | "ccip";

const NETWORK_CAPABILITIES: Record<NetworkId, Set<NetworkCapability>> = {
  mainnet: new Set(["canonicalDeposit", "canonicalWithdraw", "claim", "ccip"]),
  testnet: new Set(["ccip"]),
};

export function isZeroAddress(value: string): boolean {
  return value.toLowerCase() === ZERO_ADDRESS;
}

export function assertNetworkCapability(network: NetworkId, capability: NetworkCapability): void {
  if (!NETWORK_CAPABILITIES[network].has(capability)) {
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

export function assertCcipToken(network: NetworkId, token: Token): void {
  const supported = network === "testnet" ? token.id === "CCIP-BnM" : token.id === "USDC.e" || token.id === "LINK";
  if (!supported || !token.bridges.includes("ccip")) {
    throw new Error(`${token.symbol} is not supported by CCIP on ${NETWORKS[network].name}`);
  }
}

export function assertDestinationSelector(network: NetworkId, selector: bigint): void {
  if (selector <= 0n || selector === NETWORKS[network].ccipChainSelector) {
    throw new Error("Invalid CCIP destination chain selector");
  }
}