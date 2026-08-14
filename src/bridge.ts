/**
 * Canonical bridge execution: deposit (Direct + Two Bridges), withdrawal,
 * and claim. Encodes the exact request construction the bridge UI uses
 * (verified from the live bridge bundle).
 *
 * Signing: the server never holds keys. Callers pass a viem WalletClient
 * (e.g. from a private key in env, or a client-side signer).
 */

import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex, type WalletClient } from "viem";
import bridgehubAbi from "./abis/bridgehub.json" with { type: "json" };
import assetRouterAbi from "./abis/assetRouter.json" with { type: "json" };
import l2BaseTokenAbi from "./abis/l2BaseToken.json" with { type: "json" };
import l2AssetRouterAbi from "./abis/l2AssetRouter.json" with { type: "json" };
import ntvAbi from "./abis/ntv.json" with { type: "json" };
import nullifierAbi from "./abis/nullifier.json" with { type: "json" };
import { DEFAULT_DEPOSIT_GAS_LIMIT, GAS_PER_PUBDATA, NETWORKS, type NetworkId } from "./domain.ts";
import { getAddressTransactions, getL2ToL1LogProof, getProviders, getTransactionFinality, getWithdrawalLog } from "./providers.ts";

export interface DepositParams {
  /** L1 token address (ADI ERC-20 or any ERC-20) */
  token: Address;
  /** amount in wei (token decimals) */
  amount: bigint;
  /** L2 recipient */
  to: Address;
  /** L1 sender (signer address) */
  from: Address;
  /** L2 gas limit; defaults to DEFAULT_DEPOSIT_GAS_LIMIT */
  l2GasLimit?: bigint;
}

export interface DepositResult {
  /** L1 transaction hash */
  l1TxHash: Hex;
  /** canonical L2 transaction hash (from NewPriorityRequest) */
  canonicalTxHash: Hex;
  /** mintValue sent (base cost + amount for ADI; base cost for ERC-20) */
  mintValue: bigint;
  /** whether an approval transaction was needed */
  approvalTxHash?: Hex;
}

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
] as const);

/**
 * Resolve the assetId for an L1 token via the L1 Native Token Vault.
 * Throws if the token is not registered — ADI mainnet/testnet run
 * `nativeTokenBridgingOnly`, so only ADI is bridgeable via the canonical
 * bridge. Unregistered tokens must use CCIP instead.
 */
export async function getAssetId(network: NetworkId, token: Address): Promise<Hex> {
  const { l1 } = getProviders(network);
  const net = NETWORKS[network];
  const result = await l1.readContract({
    address: net.l1NativeTokenVault,
    abi: ntvAbi,
    functionName: "assetId",
    args: [token],
  });
  const assetId = result as Hex;
  if (assetId === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    throw new Error(
      `Token ${token} is not registered in the ADI canonical bridge (Native Token Vault). ` +
        `ADI ${net.name} runs nativeTokenBridgingOnly — only ADI is bridgeable via the canonical bridge. ` +
        `Use CCIP (USDC.e, LINK) or a swap service instead.`,
    );
  }
  return assetId;
}

/** L1 base cost of an L2 transaction (gas price × gas limit, in ADI). */
export async function l2TransactionBaseCost(
  network: NetworkId,
  gasPrice: bigint,
  l2GasLimit: bigint,
  gasPerPubdata: bigint = GAS_PER_PUBDATA,
): Promise<bigint> {
  const { l1 } = getProviders(network);
  const net = NETWORKS[network];
  const result = await l1.readContract({
    address: net.bridgehub,
    abi: bridgehubAbi,
    functionName: "l2TransactionBaseCost",
    args: [BigInt(net.chainId), gasPrice, l2GasLimit, gasPerPubdata],
  });
  return result as bigint;
}

/**
 * Build the canonical-bridge deposit transaction for ADI (base token).
 * Mirrors the bridge UI's _getDepositBaseTokenOnNonETHBasedChainTx:
 * requestL2TransactionDirect with l2Contract = recipient, l2Calldata = "0x",
 * mintValue = baseCost + amount, l2Value = amount.
 */
export async function buildAdiDepositTx(
  network: NetworkId,
  params: DepositParams,
): Promise<{ tx: { to: Address; data: Hex; value: bigint }; mintValue: bigint }> {
  const { l1 } = getProviders(network);
  const net = NETWORKS[network];
  const l2GasLimit = params.l2GasLimit ?? DEFAULT_DEPOSIT_GAS_LIMIT;
  const gasPrice = await l1.getGasPrice();
  const baseCost = await l2TransactionBaseCost(network, gasPrice, l2GasLimit);
  // Buffer the base cost: the Mailbox recomputes it with the deposit tx's
  // actual gas price, which can exceed the estimate if the L1 base fee rises
  // between estimation and inclusion. Excess mintValue is refunded to
  // refundRecipient on L2, so overpaying is safe.
  const mintValue = (baseCost * 110n) / 100n + params.amount;

  const data = encodeFunctionData({
    abi: bridgehubAbi,
    functionName: "requestL2TransactionDirect",
    args: [
      {
        chainId: BigInt(net.chainId),
        mintValue,
        l2Contract: params.to,
        l2Value: params.amount,
        l2Calldata: "0x",
        l2GasLimit,
        l2GasPerPubdataByteLimit: GAS_PER_PUBDATA,
        factoryDeps: [],
        refundRecipient: params.from,
      },
    ],
  });

  return { tx: { to: net.bridgehub, data, value: 0n }, mintValue };
}

/**
 * Build the canonical-bridge deposit for an arbitrary ERC-20 (Two Bridges
 * pattern). Mirrors the bridge UI: second bridge = L1 Asset Router,
 * secondBridgeCalldata = bridgehubDeposit(chainId, prevMsgSender,
 * abi.encode(assetId, abi.encode(amount, l2Receiver, l1Token))).
 * Requires the user to hold ADI on L1 to cover L2 gas.
 */
export async function buildErc20DepositTx(
  network: NetworkId,
  params: DepositParams,
): Promise<{ tx: { to: Address; data: Hex; value: bigint }; mintValue: bigint }> {
  const { l1 } = getProviders(network);
  const net = NETWORKS[network];
  const l2GasLimit = params.l2GasLimit ?? DEFAULT_DEPOSIT_GAS_LIMIT;
  const gasPrice = await l1.getGasPrice();
  const baseCost = await l2TransactionBaseCost(network, gasPrice, l2GasLimit);
  const mintValue = baseCost;

  const assetId = await getAssetId(network, params.token);
  const transferData = encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }],
    [params.amount, params.to, params.token],
  );
  const secondBridgeCalldata = encodeFunctionData({
    abi: assetRouterAbi,
    functionName: "bridgehubDeposit",
    args: [BigInt(net.chainId), params.from, assetId, transferData],
  });

  const data = encodeFunctionData({
    abi: bridgehubAbi,
    functionName: "requestL2TransactionTwoBridges",
    args: [
      {
        chainId: BigInt(net.chainId),
        mintValue,
        l2Value: 0n,
        l2GasLimit,
        l2GasPerPubdataByteLimit: GAS_PER_PUBDATA,
        refundRecipient: params.from,
        secondBridgeAddress: net.l1AssetRouter,
        secondBridgeValue: 0n,
        secondBridgeCalldata,
      },
    ],
  });

  return { tx: { to: net.bridgehub, data, value: 0n }, mintValue };
}

/**
 * Execute a canonical-bridge deposit. Approves the token-pulling contract
 * first if allowance is insufficient, then sends the deposit. Returns the
 * L1 tx hash and the canonical L2 tx hash (parsed from the NewPriorityRequest
 * event).
 *
 * The spender that pulls the token differs by path (verified against the
 * deployed mainnet contracts):
 *  - ADI (native token): Bridgehub -> Native Token Vault pulls `mintValue`
 *    (base cost + amount) from the user via transferFrom(user, NTV, mintValue).
 *  - ERC-20 (Two Bridges): the L1 Asset Router pulls `amount` via
 *    bridgehubDeposit -> safeTransferFrom(user, AssetRouter, amount).
 */
export async function deposit(
  wallet: WalletClient,
  network: NetworkId,
  params: DepositParams,
): Promise<DepositResult> {
  const { l1 } = getProviders(network);
  const net = NETWORKS[network];
  const isAdi = params.token.toLowerCase() === net.l1Adi.toLowerCase();

  // Build the deposit tx first: the ADI approval amount is mintValue, which
  // depends on the current L1 gas price.
  const { tx, mintValue } = isAdi
    ? await buildAdiDepositTx(network, params)
    : await buildErc20DepositTx(network, params);

  const spender = isAdi ? net.l1NativeTokenVault : net.l1AssetRouter;
  const needed = isAdi ? mintValue : params.amount;
  const allowance = await l1.readContract({
    address: params.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [params.from, spender],
  });
  let approvalTxHash: Hex | undefined;
  if (allowance < needed) {
    const approvalHash = await wallet.writeContract({
      address: params.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, needed],
      chain: { id: net.l1ChainId, name: net.l1Name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [net.l1RpcUrl] } } },
      account: wallet.account!,
    });
    approvalTxHash = approvalHash;
    // The deposit pulls the token via transferFrom, so it must not be sent
    // until the approval is mined — otherwise the estimate sees the stale
    // allowance and the deposit reverts with ERC20InsufficientAllowance.
    await l1.waitForTransactionReceipt({ hash: approvalHash });
  }

  const l1TxHash = await wallet.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
    chain: { id: net.l1ChainId, name: net.l1Name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [net.l1RpcUrl] } } },
    account: wallet.account!,
  });

  // Parse the canonical L2 tx hash from the Diamond's priority-request events.
  // ADI's Mailbox emits NewPriorityRequestId(txId indexed, txHash indexed) —
  // txHash is topics[2]. Fall back to the non-indexed NewPriorityRequest
  // (txHash is the second 32-byte word of data) for older deployments.
  const receipt = await l1.waitForTransactionReceipt({ hash: l1TxHash });
  const diamondLogs = receipt.logs.filter((l) => l.address.toLowerCase() === net.l1DiamondProxy.toLowerCase());
  const NEW_PRIORITY_REQUEST_ID_TOPIC = "0x779f441679936c5441b671969f37400b8c3ed0071cb47444431bf985754560df" as const;
  const NEW_PRIORITY_REQUEST_TOPIC = "0x4531cd5795773d7101c17bdeb9f5ab7f47d7056017506f937083be5d6e77a382" as const;
  let canonicalTxHash: Hex = "0x";
  const idLog = diamondLogs.find((l) => l.topics[0] === NEW_PRIORITY_REQUEST_ID_TOPIC);
  if (idLog) {
    canonicalTxHash = idLog.topics[2] as Hex;
  } else {
    const reqLog = diamondLogs.find((l) => l.topics[0] === NEW_PRIORITY_REQUEST_TOPIC);
    if (reqLog) {
      canonicalTxHash = `0x${reqLog.data.slice(64, 128)}` as Hex;
    }
  }

  return { l1TxHash, canonicalTxHash, mintValue, approvalTxHash };
}

/**
 * Build the L2 withdrawal transaction for native ADI: withdraw(l1Receiver)
 * on the L2 Base Token (0x800A), payable with the ADI amount.
 */
export function buildAdiWithdrawTx(network: NetworkId, l1Receiver: Address): { to: Address; data: Hex; value: bigint } {
  const net = NETWORKS[network];
  return {
    to: net.l2BaseToken,
    data: encodeFunctionData({ abi: l2BaseTokenAbi, functionName: "withdraw", args: [l1Receiver] }),
    value: 0n, // caller sets value = amount
  };
}

/**
 * Build the L2 withdrawal for an ERC-20: withdraw(assetId, transferData) on
 * the L2 Asset Router (0x10003), where transferData encodes
 * (amount, l1Receiver, l2TokenAddress).
 */
export async function buildErc20WithdrawTx(
  network: NetworkId,
  l2Token: Address,
  amount: bigint,
  l1Receiver: Address,
): Promise<{ to: Address; data: Hex; value: bigint }> {
  const net = NETWORKS[network];
  const assetId = await getAssetId(network, l2Token);
  const transferData = encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }],
    [amount, l1Receiver, l2Token],
  );
  return {
    to: net.l2AssetRouter,
    data: encodeFunctionData({ abi: l2AssetRouterAbi, functionName: "withdraw", args: [assetId, transferData] }),
    value: 0n,
  };
}

// ---------------------------------------------------------------------------
// Withdrawal claim (L2 → L1 finalization on the L1 Nullifier)
// ---------------------------------------------------------------------------

export interface WithdrawalParams {
  chainId: bigint;
  l2BatchNumber: bigint;
  l2MessageIndex: bigint;
  /** L2 sender of the message — the L2 Base Token (0x800A) for ADI withdrawals */
  l2Sender: Address;
  l2TxNumberInBatch: number;
  /** the 56-byte withdrawal message (abi.encodePacked(selector, l1Receiver, amount)) */
  message: Hex;
  merkleProof: Hex[];
}

/**
 * Build the claim params for a withdrawal tx. Mirrors the bridge UI's
 * getFinalizeWithdrawalParams: reads the L1MessageSent log, the matching
 * L2→L1 log, and the Merkle proof from zks_getL2ToL1LogProof.
 */
export async function getWithdrawalParams(network: NetworkId, txHash: Hex, index = 0): Promise<WithdrawalParams> {
  const { log, l2ToL1Log, l2ToL1LogIndex } = await getWithdrawalLog(network, txHash, index);
  const proof = await getL2ToL1LogProof(network, txHash, l2ToL1LogIndex);
  if (!proof) throw new Error("Log proof not found — the batch has not been executed on L1 yet. Wait for execution (~75 min).");
  const [message] = decodeAbiParameters([{ type: "bytes" }], log.data);
  // l2Sender = last 20 bytes of the L2→L1 log key (the L2 Base Token for ADI withdrawals)
  const l2Sender = ("0x" + l2ToL1Log.key.slice(26)) as Address;
  return {
    chainId: BigInt(NETWORKS[network].chainId),
    l2BatchNumber: BigInt(proof.batch_number),
    l2MessageIndex: BigInt(proof.id),
    l2Sender,
    l2TxNumberInBatch: l2ToL1Log.tx_number_in_block,
    message,
    merkleProof: proof.proof,
  };
}

/**
 * Build the claim transaction against the L1 Nullifier. The Nullifier has two
 * finalizeDeposit overloads; the struct form is the one the bridge UI uses.
 */
export function buildClaimTx(network: NetworkId, params: WithdrawalParams): { to: Address; data: Hex } {
  const structOverload = nullifierAbi.find(
    (e) => e.type === "function" && e.name === "finalizeDeposit" && e.inputs?.[0]?.type === "tuple",
  );
  if (!structOverload) throw new Error("finalizeDeposit struct overload not found in ABI");
  return {
    to: NETWORKS[network].l1Nullifier,
    data: encodeFunctionData({ abi: [structOverload], functionName: "finalizeDeposit", args: [params] }),
  };
}

/** Execute the claim on L1. Returns the L1 tx hash. */
export async function claimWithdrawal(
  wallet: WalletClient,
  network: NetworkId,
  params: WithdrawalParams,
): Promise<Hex> {
  const { to, data } = buildClaimTx(network, params);
  const net = NETWORKS[network];
  if (!wallet.account) throw new Error("Wallet has no account");
  return wallet.sendTransaction({
    to,
    data,
    chain: { id: net.l1ChainId, name: net.l1Name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [net.l1RpcUrl] } } },
    account: wallet.account,
  });
}

// ---------------------------------------------------------------------------
// Withdrawal discovery (stateless) — everything is derived from chain state:
// Blockscout tx history, the finality RPC, and the L1 Nullifier's
// isWithdrawalFinalized mapping. The server keeps no state.
// ---------------------------------------------------------------------------

export const WITHDRAW_METHOD_ID = "0x51cff8d9" as const; // L2 Base Token withdraw(address)

const nullifierViewAbi = parseAbi([
  "function isWithdrawalFinalized(uint256 _chainId, uint256 _l2BatchNumber, uint256 _l2MessageIndex) view returns (bool)",
] as const);

/** Whether finalizeDeposit was already called on the L1 Nullifier for these params. */
export async function checkWithdrawalFinalized(network: NetworkId, params: WithdrawalParams): Promise<boolean> {
  const { l1 } = getProviders(network);
  const net = NETWORKS[network];
  return (await l1.readContract({
    address: net.l1Nullifier,
    abi: nullifierViewAbi,
    functionName: "isWithdrawalFinalized",
    args: [BigInt(net.chainId), params.l2BatchNumber, params.l2MessageIndex],
  })) as boolean;
}

/** Claim status of a withdrawal, read from the L1 Nullifier. */
export interface WithdrawalClaimStatus {
  /** finalizeDeposit has been called on L1 — the withdrawal is claimed */
  finalized: boolean;
  /** whether the batch executed on L1 yet (proof available) */
  claimable: boolean;
}

/**
 * Claim status for a withdrawal tx: claimable once the batch executed on L1,
 * finalized once finalizeDeposit was called on the Nullifier.
 * Returns null if the withdrawal tx has no finality record yet.
 */
export async function getWithdrawalStatus(
  network: NetworkId,
  txHash: Hex,
): Promise<(WithdrawalClaimStatus & { stage: string; blockNumber: number | null; batchNumber: number | null }) | null> {
  const finality = await getTransactionFinality(network, txHash);
  if (!finality) return null;
  try {
    const params = await getWithdrawalParams(network, txHash);
    return { ...finality, finalized: await checkWithdrawalFinalized(network, params), claimable: true };
  } catch (e) {
    // Only the "batch not executed on L1 yet" case means not-claimable.
    // Any other failure (RPC errors, missing logs) must surface, not be
    // misreported as "not claimable".
    if (e instanceof Error && e.message.includes("not been executed on L1")) {
      return { ...finality, finalized: false, claimable: false };
    }
    throw e;
  }
}

/** A withdrawal discovered from an address's tx history, with claim status. */
export interface WithdrawalRecord {
  txHash: Hex;
  amount: string; // wei
  blockNumber: string;
  timeStamp: string;
  stage: string;
  claimable: boolean;
  finalized: boolean;
  params: WithdrawalParams | null;
}

/**
 * List an address's pending/finalized L2→L1 withdrawals, newest first.
 * Stateless: filters the address's L2 tx history (Blockscout) for L2 Base
 * Token withdraw() calls, then annotates each with finality + claim status.
 */
export async function listWithdrawals(
  network: NetworkId,
  address: Address,
  offset = 50,
): Promise<WithdrawalRecord[]> {
  const txs = await getAddressTransactions(network, address, offset);
  const net = NETWORKS[network];
  const l2BaseToken = net.l2BaseToken.toLowerCase();
  const records: WithdrawalRecord[] = [];
  for (const tx of txs) {
    // L2 Base Token withdraw(address) — skip L1-originated (deposit) rows.
    if ((tx.to ?? "").toLowerCase() !== l2BaseToken) continue;
    if (!(tx.input ?? "0x").toLowerCase().startsWith(WITHDRAW_METHOD_ID)) continue;
    if (tx.isL1Originated === "1") continue;
    const hash = tx.hash as Hex;
    const status = await getWithdrawalStatus(network, hash);
    let params: WithdrawalParams | null = null;
    if (status?.claimable) {
      try {
        params = await getWithdrawalParams(network, hash);
      } catch {
        params = null;
      }
    }
    records.push({
      txHash: hash,
      amount: tx.value,
      blockNumber: tx.blockNumber,
      timeStamp: tx.timeStamp,
      stage: status?.stage ?? "pending",
      claimable: status?.claimable ?? false,
      finalized: status?.finalized ?? false,
      params,
    });
  }
  return records;
}
