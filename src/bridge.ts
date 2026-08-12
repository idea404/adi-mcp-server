/**
 * Canonical bridge execution: deposit (Direct + Two Bridges), withdrawal,
 * and claim. Encodes the exact request construction the bridge UI uses
 * (verified from the live bridge bundle, see DESIGN.md).
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
import { getL2ToL1LogProof, getProviders, getWithdrawalLog } from "./providers.ts";

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
  const mintValue = baseCost + params.amount;

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
 * Execute a canonical-bridge deposit. Approves the L1 Asset Router first if
 * allowance is insufficient, then sends the deposit. Returns the L1 tx hash
 * and the canonical L2 tx hash (parsed from the NewPriorityRequest event).
 */
export async function deposit(
  wallet: WalletClient,
  network: NetworkId,
  params: DepositParams,
): Promise<DepositResult> {
  const { l1 } = getProviders(network);
  const net = NETWORKS[network];
  const isAdi = params.token.toLowerCase() === net.l1Adi.toLowerCase();

  // Approval: the L1 Asset Router pulls the token (bridgeBurn via safeTransferFrom).
  const allowance = await l1.readContract({
    address: params.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [params.from, net.l1AssetRouter],
  });
  let approvalTxHash: Hex | undefined;
  if (allowance < params.amount) {
    const approvalHash = await wallet.writeContract({
      address: params.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [net.l1AssetRouter, params.amount],
      chain: { id: net.l1ChainId, name: net.l1Name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [net.l1RpcUrl] } } },
      account: params.from,
    });
    approvalTxHash = approvalHash;
  }

  const { tx, mintValue } = isAdi
    ? await buildAdiDepositTx(network, params)
    : await buildErc20DepositTx(network, params);

  const l1TxHash = await wallet.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
    chain: { id: net.l1ChainId, name: net.l1Name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [net.l1RpcUrl] } } },
    account: params.from,
  });

  // Parse the canonical L2 tx hash from the NewPriorityRequest event.
  const receipt = await l1.waitForTransactionReceipt({ hash: l1TxHash });
  const log = receipt.logs.find((l) => l.address.toLowerCase() === net.l1DiamondProxy.toLowerCase());
  const canonicalTxHash = log ? (log.topics[1] as Hex) : "0x";

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
  const account = wallet.account?.address;
  if (!account) throw new Error("Wallet has no account");
  return wallet.sendTransaction({
    to,
    data,
    chain: { id: net.l1ChainId, name: net.l1Name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [net.l1RpcUrl] } } },
    account,
  });
}
