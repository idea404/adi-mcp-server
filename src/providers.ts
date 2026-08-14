/**
 * RPC + explorer providers. viem clients per network (L1 and L2), plus a
 * Blockscout v1 API client (module/action endpoints on explorer-api.* hosts).
 */

import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { NETWORKS, type NetworkId } from "./domain.ts";

export interface Providers {
  l1: PublicClient;
  l2: PublicClient;
}

/** Ethereum L1 RPC fallbacks (used when the primary L1 RPC is down). */
export const L1_RPC_FALLBACKS: Record<NetworkId, string[]> = {
  mainnet: ["https://eth.drpc.org", "https://1rpc.io/eth"],
  testnet: ["https://eth-sepolia.publicnode.com", "https://eth-sepolia.drpc.org"],
};

const clients: Record<NetworkId, Providers | undefined> = { mainnet: undefined, testnet: undefined };

export function getProviders(network: NetworkId): Providers {
  const existing = clients[network];
  if (existing) return existing;
  const net = NETWORKS[network];
  const providers: Providers = {
    l1: createPublicClient({
      chain: { id: net.l1ChainId, name: net.l1Name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [net.l1RpcUrl] } } },
      transport: fallback([http(net.l1RpcUrl), ...L1_RPC_FALLBACKS[network].map((url) => http(url))]),
    }),
    l2: createPublicClient({ chain: { id: net.chainId, name: net.name, nativeCurrency: { name: "ADI", symbol: "ADI", decimals: 18 }, rpcUrls: { default: { http: [net.rpcUrl] } } }, transport: http(net.rpcUrl) }),
  };
  clients[network] = providers;
  return providers;
}

/** Raw JSON-RPC call against the ADI L2 RPC (for zks_* methods viem doesn't type). */
export async function zksCall<T>(network: NetworkId, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(NETWORKS[network].rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  return body.result as T;
}

export interface Finality {
  stage: "pending" | "committed" | "executed";
  blockNumber: number | null;
  batchNumber: number | null;
}

/** zks_getTransactionFinality — where a tx sits in the L1 finality pipeline. */
export function getTransactionFinality(network: NetworkId, txHash: `0x${string}`): Promise<Finality> {
  return zksCall<Finality>(network, "zks_getTransactionFinality", [txHash]);
}

/** zks_getFinalityStatus — the node's finality frontiers. */
export function getFinalityStatus(network: NetworkId): Promise<{
  lastSealedBlock: number;
  lastCommittedBlock: number;
  lastCommittedBatch: number;
  lastExecutedBlock: number;
  lastExecutedBatch: number;
}> {
  return zksCall(network, "zks_getFinalityStatus", []);
}

/** zks_getL2ToL1LogProof — Merkle proof for an L2→L1 log; null until the batch executes on L1. */
export function getL2ToL1LogProof(
  network: NetworkId,
  txHash: `0x${string}`,
  logIndex: number,
): Promise<{ id: number; batch_number: number; proof: `0x${string}`[]; root: `0x${string}` } | null> {
  return zksCall(network, "zks_getL2ToL1LogProof", [txHash, logIndex]);
}

/** L1MessageSent event topic (L1 Messenger, 0x8008). */
export const L1_MESSAGE_SENT_TOPIC = "0x3a36e47291f4201faf137fab081d92295bce2d53be2c6ca68ba82c7faa9ce241" as const;

export interface L2ToL1Log {
  l2_shard_id: number;
  is_service: boolean;
  tx_number_in_block: number;
  sender: `0x${string}`;
  key: `0x${string}`;
  value: `0x${string}`;
}

export interface WithdrawalLog {
  /** L1MessageSent log from the L1 Messenger (0x8008) */
  log: { topics: `0x${string}`[]; data: `0x${string}` };
  /** matching L2→L1 log (sender = 0x8008) */
  l2ToL1Log: L2ToL1Log;
  /** index of the L2→L1 log in the receipt's l2ToL1Logs array */
  l2ToL1LogIndex: number;
}

/**
 * Extract the withdrawal L1MessageSent log and its matching L2→L1 log from a
 * receipt. Mirrors the bridge UI's _getWithdrawalLog/_getWithdrawalL2ToL1Log.
 */
export async function getWithdrawalLog(network: NetworkId, txHash: `0x${string}`, index = 0): Promise<WithdrawalLog> {
  const { l2 } = getProviders(network);
  const receipt = await l2.getTransactionReceipt({ hash: txHash });
  const messenger = NETWORKS[network].l1Messenger.toLowerCase();
  const logs = receipt.logs.filter(
    (l) => l.address.toLowerCase() === messenger && l.topics[0] === L1_MESSAGE_SENT_TOPIC,
  );
  const log = logs[index];
  if (!log) throw new Error(`No L1MessageSent log found for ${txHash} (index ${index})`);
  // viem's TransactionReceipt type omits l2ToL1Logs (a zkSync extension); narrow at runtime.
  const receiptExt = receipt as unknown;
  const l2ToL1Logs: L2ToL1Log[] =
    receiptExt && typeof receiptExt === "object" && "l2ToL1Logs" in receiptExt && Array.isArray(receiptExt.l2ToL1Logs)
      ? (receiptExt.l2ToL1Logs as L2ToL1Log[])
      : [];
  const entries = l2ToL1Logs
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.sender.toLowerCase() === messenger);
  const entry = entries[index];
  if (!entry) throw new Error(`No matching L2→L1 log found for ${txHash} (index ${index})`);
  return { log: { topics: log.topics as `0x${string}`[], data: log.data }, l2ToL1Log: entry.l, l2ToL1LogIndex: entry.i };
}

/** Blockscout v1 API client (module/action). */
export async function blockscoutV1<T>(
  network: NetworkId,
  module: string,
  action: string,
  params: Record<string, string> = {},
): Promise<T> {
  const qs = new URLSearchParams({ module, action, ...params });
  const res = await fetch(`${NETWORKS[network].explorerApiUrl}/api?${qs}`);
  const body = (await res.json()) as { status: string; message: string; result: T };
  if (body.status !== "1") throw new Error(`Blockscout ${module}/${action}: ${body.message ?? body.result}`);
  return body.result;
}

export interface BlockscoutTokenBalance {
  account: string;
  balance: string;
  token: { address: string; symbol: string; name: string; decimals: string };
}

/** ERC-20 balance via Blockscout (works for any token, including bridged ones). */
export function getTokenBalance(
  network: NetworkId,
  tokenAddress: `0x${string}`,
  address: `0x${string}`,
): Promise<BlockscoutTokenBalance[]> {
  return blockscoutV1(network, "account", "tokenbalance", {
    contractaddress: tokenAddress,
    address,
  });
}

/** Native balance via Blockscout. */
export function getNativeBalance(network: NetworkId, address: `0x${string}`): Promise<string> {
  return blockscoutV1(network, "account", "balance", { address });
}

/** Blockscout account/txlist row (v1 API). */
export interface BlockscoutTx {
  hash: string;
  nonce: string;
  from: string;
  to: string;
  value: string;
  input: string;
  txreceipt_status: string;
  blockNumber: string;
  timeStamp: string;
  isL1Originated?: string;
  functionName?: string;
}

/** Latest confirmed transactions from an address, newest first. */
export function getAddressTransactions(
  network: NetworkId,
  address: `0x${string}`,
  offset = 50,
): Promise<BlockscoutTx[]> {
  return blockscoutV1(network, "account", "txlist", { address, startblock: "0", endblock: "99999999", page: "1", offset: String(offset), sort: "desc" });
}
