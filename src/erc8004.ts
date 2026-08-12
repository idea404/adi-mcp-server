/**
 * ERC-8004 registry reads (Identity, Reputation, Validation).
 *
 * The registries are deployed on ADI Mainnet only — the canonical testnet
 * deployment is still pending (verified: no code at the vanity addresses on
 * testnet). Tools in this module are mainnet-only.
 */

import { type Address } from "viem";
import identityRegistryAbi from "./abis/identityRegistry.json" with { type: "json" };
import reputationRegistryAbi from "./abis/reputationRegistry.json" with { type: "json" };
import validationRegistryAbi from "./abis/validationRegistry.json" with { type: "json" };
import { NETWORKS } from "./domain.ts";
import { getProviders } from "./providers.ts";

export interface AgentIdentity {
  agentId: bigint;
  owner: Address;
  tokenURI: string;
  agentWallet: Address | null;
}

/** Look up an agent by ID: owner, token URI (registration file), verified wallet. */
export async function getAgentIdentity(agentId: bigint): Promise<AgentIdentity> {
  const { l2 } = getProviders("mainnet");
  const registry = NETWORKS.mainnet.identityRegistry;
  const [owner, tokenURI, wallet] = await Promise.all([
    l2.readContract({ address: registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] }),
    l2.readContract({ address: registry, abi: identityRegistryAbi, functionName: "tokenURI", args: [agentId] }),
    l2.readContract({ address: registry, abi: identityRegistryAbi, functionName: "getAgentWallet", args: [agentId] }),
  ]);
  const zero = "0x0000000000000000000000000000000000000000";
  return {
    agentId,
    owner: owner as Address,
    tokenURI: tokenURI as string,
    agentWallet: (wallet as Address).toLowerCase() === zero ? null : (wallet as Address),
  };
}

export interface ReputationSummary {
  count: bigint;
  value: bigint;
  valueDecimals: number;
}

/** Reputation summary for an agent: feedback count, total value, decimals. */
export async function getAgentReputation(agentId: bigint, clients: Address[] = []): Promise<ReputationSummary> {
  const { l2 } = getProviders("mainnet");
  const registry = NETWORKS.mainnet.reputationRegistry;
  const result = await l2.readContract({
    address: registry,
    abi: reputationRegistryAbi,
    functionName: "getSummary",
    args: [agentId, clients, "", ""],
  });
  const [count, value, valueDecimals] = result as [bigint, bigint, number];
  return { count, value, valueDecimals };
}

export interface ValidationSummary {
  count: bigint;
  averageScore: number;
}

/** Validation summary for an agent: request count and average score. */
export async function getAgentValidation(agentId: bigint, validators: Address[] = []): Promise<ValidationSummary> {
  const { l2 } = getProviders("mainnet");
  const registry = NETWORKS.mainnet.validationRegistry;
  const result = await l2.readContract({
    address: registry,
    abi: validationRegistryAbi,
    functionName: "getSummary",
    args: [agentId, validators, ""],
  });
  const [count, averageScore] = result as [bigint, number];
  return { count, averageScore };
}

export interface AgentProfile {
  identity: AgentIdentity;
  reputation: ReputationSummary;
  validation: ValidationSummary;
}

/** Full agent profile: identity + reputation + validation in one call. */
export async function getAgentProfile(agentId: bigint): Promise<AgentProfile> {
  const [identity, reputation, validation] = await Promise.all([
    getAgentIdentity(agentId),
    getAgentReputation(agentId),
    getAgentValidation(agentId),
  ]);
  return { identity, reputation, validation };
}
