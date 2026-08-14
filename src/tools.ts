/**
 * MCP tool definitions. Read/advisory tools are always available; write
 * tools require a signer (private key via env) and are registered only when
 * one is configured.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatEther, formatGwei, formatUnits, isAddress, parseUnits, type Account, type Address, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, fallback, http } from "viem";
import {
  BRIDGES,
  CCIP_LANES,
  NETWORKS,
  SWAP_SERVICES,
  TOKENS,
  resolveToken,
  type NetworkId,
  type TokenId,
} from "./domain.ts";
import { bridgeOptionsFor, planFundingPath } from "./routing.ts";
import { getFinalityStatus, getNativeBalance, getProviders, getTokenBalance, getTransactionFinality, L1_RPC_FALLBACKS } from "./providers.ts";
import { buildAdiDepositTx, buildAdiWithdrawTx, buildErc20DepositTx, buildErc20WithdrawTx, checkWithdrawalFinalized, claimWithdrawal, deposit, getWithdrawalParams, getWithdrawalStatus, l2TransactionBaseCost, listWithdrawals } from "./bridge.ts";
import { buildCcipSendTx, ccipSend } from "./ccip.ts";
import { getAgentProfile } from "./erc8004.ts";

const networkSchema = z.enum(["mainnet", "testnet"]).default("mainnet");

function parseNetwork(value: unknown): NetworkId {
  const parsed = networkSchema.safeParse(value);
  return parsed.success ? parsed.data : "mainnet";
}

function formatAmount(wei: bigint, decimals: number): string {
  return formatUnits(wei, decimals);
}

/** Build a viem Account from a private key (env ADI_MCP_PRIVATE_KEY). */
export function accountFromEnv(): Account | undefined {
  const key = process.env.ADI_MCP_PRIVATE_KEY;
  if (!key) return undefined;
  return privateKeyToAccount(key as Hex);
}

/** Per-network wallet client bound to an account. */
export function walletFor(network: NetworkId, account: Account): WalletClient {
  const net = NETWORKS[network];
  return createWalletClient({
    account,
    chain: { id: net.chainId, name: net.name, nativeCurrency: { name: "ADI", symbol: "ADI", decimals: 18 }, rpcUrls: { default: { http: [net.rpcUrl] } } },
    transport: http(net.rpcUrl),
  });
}

/** L1 wallet client bound to an account. */
export function l1WalletFor(network: NetworkId, account: Account): WalletClient {
  const net = NETWORKS[network];
  return createWalletClient({
    account,
    chain: { id: net.l1ChainId, name: net.l1Name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [net.l1RpcUrl] } } },
    transport: fallback([http(net.l1RpcUrl), ...L1_RPC_FALLBACKS[network].map((url) => http(url))]),
  });
}

export function registerTools(server: McpServer, account: Account | undefined): void {
  // ---------- Read / query tools ----------

  server.tool(
    "get_network_info",
    "Network details for ADI Mainnet or Testnet: RPC, chain ID, explorer, gas token, bridge and CCIP contract addresses.",
    { network: networkSchema },
    async ({ network }) => {
      const net = NETWORKS[network];
      return {
        content: [{ type: "text", text: JSON.stringify({
          name: net.name,
          chainId: net.chainId,
          rpcUrl: net.rpcUrl,
          explorerUrl: net.explorerUrl,
          explorerApiUrl: net.explorerApiUrl,
          gasToken: "ADI",
          l1: { name: net.l1Name, chainId: net.l1ChainId, rpcUrl: net.l1RpcUrl },
          bridgehub: net.bridgehub,
          l1AssetRouter: net.l1AssetRouter,
          l1Nullifier: net.l1Nullifier,
          l1Adi: net.l1Adi,
          ccipRouter: net.ccipRouter,
          ccipChainSelector: net.ccipChainSelector.toString(),
          faucet: net.faucetUrl ?? null,
        }, null, 2) }],
      };
    },
  );

  server.tool(
    "get_token_info",
    "Token details for ADI, USDC.e, LINK, or CCIP-BnM: addresses on L1/L2, decimals, and which bridges can move it.",
    { token: z.string().describe("Token symbol (ADI, USDC.e, LINK, CCIP-BnM) or address"), network: networkSchema },
    async ({ token, network }) => {
      const t = resolveToken(token, network);
      if (!t) return { content: [{ type: "text", text: `Unknown token: ${token}` }] };
      const net = NETWORKS[network];
      return {
        content: [{ type: "text", text: JSON.stringify({
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          isNative: t.isNative,
          l2Address: t.l2Address,
          l1Address: t.id === "ADI" ? net.l1Adi : (t.l1Address ?? null),
          bridges: t.bridges,
          notes: t.notes,
        }, null, 2) }],
      };
    },
  );

  server.tool(
    "get_balance",
    "Native ADI and/or ERC-20 balance for an address on ADI Chain (L2).",
    { address: z.string().describe("EVM address"), token: z.string().optional().describe("Token symbol or address; omit for native ADI"), network: networkSchema },
    async ({ address, token, network }) => {
      if (!isAddress(address)) return { content: [{ type: "text", text: `Invalid address: ${address}` }] };
      const addr = address as Address;
      if (!token) {
        const balance = await getNativeBalance(network, addr);
        return { content: [{ type: "text", text: `Native ADI balance of ${addr}: ${formatEther(BigInt(balance))} ADI` }] };
      }
      const t = resolveToken(token, network);
      if (!t) return { content: [{ type: "text", text: `Unknown token: ${token}` }] };
      if (t.isNative) {
        const balance = await getNativeBalance(network, addr);
        return { content: [{ type: "text", text: `Native ADI balance of ${addr}: ${formatEther(BigInt(balance))} ADI` }] };
      }
      const rows = await getTokenBalance(network, t.l2Address, addr);
      const total = rows.reduce((acc, r) => acc + BigInt(r.balance), 0n);
      return { content: [{ type: "text", text: `${t.symbol} balance of ${addr}: ${formatAmount(total, t.decimals)}` }] };
    },
  );

  server.tool(
    "get_bridge_options",
    "Which bridges can move a token to/from ADI Chain, with the constraints of each (e.g. USDC.e is CCIP-only).",
    { token: z.string().describe("Token symbol or address"), direction: z.enum(["to-adi", "from-adi"]).default("to-adi"), network: networkSchema },
    async ({ token, direction, network }) => {
      const t = resolveToken(token, network);
      if (!t) return { content: [{ type: "text", text: `Unknown token: ${token}` }] };
      const options = bridgeOptionsFor(network, t, direction);
      return {
        content: [{ type: "text", text: JSON.stringify({
          token: t.symbol,
          direction,
          options: options.map((o) => ({ bridge: o.bridge, name: o.name, supported: o.supported, note: o.note })),
        }, null, 2) }],
      };
    },
  );

  server.tool(
    "get_ccip_lanes",
    "Live CCIP lanes for ADI Chain and the tokens each lane supports.",
    { network: networkSchema },
    async ({ network }) => {
      const net = NETWORKS[network];
      return {
        content: [{ type: "text", text: JSON.stringify({
          network: net.name,
          router: net.ccipRouter,
          chainSelector: net.ccipChainSelector.toString(),
          lanes: CCIP_LANES[network],
        }, null, 2) }],
      };
    },
  );

  server.tool(
    "get_bridge_status",
    "Finality status of a transaction on ADI Chain: pending (sealed), committed (on L1), or executed (final).",
    { tx_hash: z.string().describe("L2 transaction hash"), network: networkSchema },
    async ({ tx_hash, network }) => {
      const f = await getTransactionFinality(network, tx_hash as Hex);
      if (!f) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            txHash: tx_hash,
            stage: "not-found",
            blockNumber: null,
            batchNumber: null,
            meaning: "No finality record for this hash on ADI Chain. Canonical (priority) tx hashes from bridge_deposit are L1-side identifiers, not L2 tx hashes — query the L2 tx hash instead, or wait for the deposit to be processed.",
          }, null, 2) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          txHash: tx_hash,
          stage: f.stage,
          blockNumber: f.blockNumber,
          batchNumber: f.batchNumber,
          meaning: f.stage === "pending" ? "Sealed by sequencer, not yet on L1" : f.stage === "committed" ? "Committed to L1" : "Executed on L1 — fully final",
        }, null, 2) }],
      };
    },
  );

  server.tool(
    "get_finality_status",
    "The node's finality frontiers: last sealed/committed/executed block and batch.",
    { network: networkSchema },
    async ({ network }) => {
      const s = await getFinalityStatus(network);
      return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
    },
  );

  // ---------- Advisory tools ----------

  server.tool(
    "plan_funding_path",
    "Best routes to get native ADI (or another token) onto ADI Chain from a starting asset. Encodes the known constraints: no DEX on ADI Mainnet, USDC.e is CCIP-only and stuck.",
    { network: networkSchema, target: z.enum(["native-ADI", "USDC.e", "LINK", "CCIP-BnM"]).default("native-ADI"), source: z.string().optional().describe("Starting asset symbol, e.g. USDC, ADI, ETH") },
    async ({ network, target, source }) => {
      const plan = planFundingPath(network, target, source);
      return {
        content: [{ type: "text", text: JSON.stringify({
          target: plan.target,
          network,
          constraints: plan.constraints,
          routes: plan.routes.map((r) => ({
            rank: r.rank,
            title: r.title,
            steps: r.steps,
            cost: r.cost,
            time: r.time,
            caveats: r.caveats,
            executable: r.executable,
          })),
        }, null, 2) }],
      };
    },
  );

  server.tool(
    "get_swap_services",
    "Non-custodial swap services that deliver ADI directly to an ADI Mainnet address (advisory only — not executable by the MCP).",
    {},
    async () => {
      return { content: [{ type: "text", text: JSON.stringify(SWAP_SERVICES, null, 2) }] };
    },
  );

  server.tool(
    "get_agent_profile",
    "ERC-8004 agent profile on ADI Mainnet: identity (owner, registration URI, verified wallet), reputation summary, and validation summary. Mainnet only — the testnet registries are not deployed.",
    { agent_id: z.string().describe("Agent ID (uint256)") },
    async ({ agent_id }) => {
      try {
        const profile = await getAgentProfile(BigInt(agent_id));
        return {
          content: [{ type: "text", text: JSON.stringify({
            identity: {
              agentId: profile.identity.agentId.toString(),
              owner: profile.identity.owner,
              tokenURI: profile.identity.tokenURI,
              agentWallet: profile.identity.agentWallet,
            },
            reputation: {
              count: profile.reputation.count.toString(),
              value: profile.reputation.value.toString(),
              valueDecimals: profile.reputation.valueDecimals,
            },
            validation: {
              count: profile.validation.count.toString(),
              averageScore: profile.validation.averageScore,
            },
          }, null, 2) }],
        };
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("ERC721NonexistentToken") || msg.includes("reverted")) {
          return { content: [{ type: "text", text: `Agent ${agent_id} does not exist on the Identity Registry (0x8004A169FB4a3325136EB29fA0ceB6D2e539a432). The registry is deployed but no agents have been minted yet.` }] };
        }
        throw e;
      }
    },
  );

  // ---------- Write tools (require account) ----------

  if (account) {
    server.tool(
      "bridge_deposit",
      "Canonical bridge deposit: ADI ERC-20 (L1) → native ADI (L2), or any ERC-20 via the Two Bridges pattern. Approves the token-pulling contract (Native Token Vault for ADI, Asset Router for ERC-20), then deposits. Returns the L1 tx hash and canonical L2 tx hash.",
      {
        network: networkSchema,
        token: z.string().describe("L1 token address (ADI ERC-20 or any ERC-20)"),
        amount: z.string().describe("Amount in human units (e.g. 1.5)"),
        to: z.string().describe("L2 recipient address"),
      },
      async ({ network, token, amount, to }) => {
        if (!isAddress(token) || !isAddress(to)) return { content: [{ type: "text", text: "Invalid address" }] };
        const t = resolveToken(token, network);
        const decimals = t ? t.decimals : 18;
        const wei = parseUnits(amount, decimals);
        const result = await deposit(l1WalletFor(network, account), network, {
          token: token as Address,
          amount: wei,
          to: to as Address,
          from: account.address,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            l1TxHash: result.l1TxHash,
            canonicalTxHash: result.canonicalTxHash,
            mintValue: formatEther(result.mintValue),
            approvalTxHash: result.approvalTxHash ?? null,
            note: "Deposit lands on L2 in ~15 seconds. Track with get_bridge_status using the canonical tx hash.",
          }, null, 2) }],
        };
      },
    );

    server.tool(
      "bridge_withdraw",
      "Canonical bridge withdrawal: native ADI (L2) → ADI ERC-20 (L1), or a bridged ERC-20 back to L1. Takes ~75 minutes (ZK proof) + claim.",
      {
        network: networkSchema,
        token: z.string().describe("Token symbol (ADI) or L2 token address"),
        amount: z.string().describe("Amount in human units"),
        l1_receiver: z.string().describe("L1 (Ethereum) receiver address"),
      },
      async ({ network, token, amount, l1_receiver }) => {
        if (!isAddress(l1_receiver)) return { content: [{ type: "text", text: "Invalid L1 receiver" }] };
        const t = resolveToken(token, network);
        if (!t) return { content: [{ type: "text", text: `Unknown token: ${token}` }] };
        const wei = parseUnits(amount, t.decimals);
        const net = NETWORKS[network];
        let tx: { to: Address; data: Hex; value: bigint };
        if (t.isNative) {
          tx = buildAdiWithdrawTx(network, l1_receiver as Address);
          tx.value = wei;
        } else {
          tx = await buildErc20WithdrawTx(network, t.l2Address, wei, l1_receiver as Address);
        }
        const wallet = walletFor(network, account);
        const txHash = await wallet.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          chain: { id: net.chainId, name: net.name, nativeCurrency: { name: "ADI", symbol: "ADI", decimals: 18 }, rpcUrls: { default: { http: [net.rpcUrl] } } },
          account: wallet.account!,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            txHash,
            note: "Withdrawal takes ~75 minutes (commit → prove → execute) then must be claimed on L1 via the Nullifier. Claim support is not yet implemented in this server.",
          }, null, 2) }],
        };
      },
    );

    server.tool(
      "ccip_transfer",
      "Send a CCIP token (USDC.e, LINK on mainnet; CCIP-BnM on testnet) from ADI Chain to another chain via the CCIP router.",
      {
        network: networkSchema,
        token: z.string().describe("Token symbol (USDC.e, LINK, CCIP-BnM)"),
        amount: z.string().describe("Amount in human units"),
        destination_chain_selector: z.string().describe("Destination chain selector (e.g. Ethereum mainnet 5009297430713026196)"),
        receiver: z.string().describe("Receiver address on the destination chain"),
      },
      async ({ network, token, amount, destination_chain_selector, receiver }) => {
        const t = resolveToken(token, network);
        if (!t) return { content: [{ type: "text", text: `Unknown token: ${token}` }] };
        if (!t.bridges.includes("ccip")) return { content: [{ type: "text", text: `${t.symbol} has no CCIP pool on ADI — cannot be sent via CCIP.` }] };
        if (!isAddress(receiver)) return { content: [{ type: "text", text: "Invalid receiver" }] };
        const wei = parseUnits(amount, t.decimals);
        const result = await ccipSend(walletFor(network, account), {
          network,
          destinationChainSelector: BigInt(destination_chain_selector),
          token: t.l2Address,
          amount: wei,
          receiver: receiver as Address,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            txHash: result.txHash,
            messageId: result.messageId,
            note: "CCIP transfers take ~minutes. Track the messageId on the destination chain.",
          }, null, 2) }],
        };
      },
    );
  }

  server.tool(
    "estimate_deposit",
    "Estimate the L1 base cost (in ADI) of a canonical bridge deposit — the mintValue the deposit will require.",
    { network: networkSchema, l2_gas_limit: z.string().optional().describe("L2 gas limit; defaults to 1,000,000") },
    async ({ network, l2_gas_limit }) => {
      const { l1 } = getProviders(network);
      const gasPrice = await l1.getGasPrice();
      const gasLimit = l2_gas_limit ? BigInt(l2_gas_limit) : 1_000_000n;
      const baseCost = await l2TransactionBaseCost(network, gasPrice, gasLimit);
      return { content: [{ type: "text", text: `Estimated L1 base cost: ${formatEther(baseCost)} ADI (gas price ${formatGwei(gasPrice)} gwei, gas limit ${gasLimit})` }] };
    },
  );

  server.tool(
    "get_withdrawal_params",
    "Build the claim params for a withdrawal tx: batch number, message index, L2 sender, message, and Merkle proof. Errors if the batch is not yet executed on L1 (~75 min).",
    { tx_hash: z.string().describe("L2 withdrawal transaction hash"), network: networkSchema },
    async ({ tx_hash, network }) => {
      const params = await getWithdrawalParams(network, tx_hash as Hex);
      return {
        content: [{ type: "text", text: JSON.stringify({
          chainId: params.chainId.toString(),
          l2BatchNumber: params.l2BatchNumber.toString(),
          l2MessageIndex: params.l2MessageIndex.toString(),
          l2Sender: params.l2Sender,
          l2TxNumberInBatch: params.l2TxNumberInBatch,
          message: params.message,
          merkleProof: params.merkleProof,
        }, null, 2) }],
      };
    },
  );

  server.tool(
    "list_withdrawals",
    "List an address's L2→L1 withdrawals (newest first) with their claim status: stage (pending/committed/executed), claimable (batch executed on L1, proof available), and finalized (already claimed via the Nullifier). Stateless — derived from on-chain state.",
    { address: z.string().describe("L2 address to inspect"), network: networkSchema, limit: z.number().int().min(1).max(200).optional().describe("max tx history rows to scan (default 50)") },
    async ({ address, network, limit }) => {
      if (!isAddress(address)) return { content: [{ type: "text", text: `Invalid address: ${address}` }] };
      const records = await listWithdrawals(network, address as Address, limit ?? 50);
      return {
        content: [{ type: "text", text: JSON.stringify({
          address,
          network: NETWORKS[network].name,
          count: records.length,
          withdrawals: records.map((r) => ({
            txHash: r.txHash,
            amount: formatEther(BigInt(r.amount)),
            blockNumber: r.blockNumber,
            stage: r.stage,
            claimable: r.claimable,
            finalized: r.finalized,
            params: r.params ? {
              chainId: r.params.chainId.toString(),
              l2BatchNumber: r.params.l2BatchNumber.toString(),
              l2MessageIndex: r.params.l2MessageIndex.toString(),
              l2Sender: r.params.l2Sender,
              l2TxNumberInBatch: r.params.l2TxNumberInBatch,
              message: r.params.message,
              merkleProof: r.params.merkleProof,
            } : null,
          })),
        }, null, 2) }],
      };
    },
  );

  if (account) {
    server.tool(
      "claim_withdrawal",
      "Claim a finalized withdrawal on L1 via the Nullifier. Requires the params from get_withdrawal_params (or the tx hash to rebuild them).",
      {
        network: networkSchema,
        tx_hash: z.string().optional().describe("L2 withdrawal tx hash — rebuilds params automatically"),
        params: z.string().optional().describe("JSON params from get_withdrawal_params (alternative to tx_hash)"),
      },
      async ({ network, tx_hash, params: paramsJson }) => {
        let params;
        if (paramsJson) {
          const parsed = JSON.parse(paramsJson) as {
            chainId: string; l2BatchNumber: string; l2MessageIndex: string;
            l2Sender: string; l2TxNumberInBatch: number; message: string; merkleProof: string[];
          };
          params = {
            chainId: BigInt(parsed.chainId),
            l2BatchNumber: BigInt(parsed.l2BatchNumber),
            l2MessageIndex: BigInt(parsed.l2MessageIndex),
            l2Sender: parsed.l2Sender as Address,
            l2TxNumberInBatch: parsed.l2TxNumberInBatch,
            message: parsed.message as Hex,
            merkleProof: parsed.merkleProof as Hex[],
          };
        } else if (tx_hash) {
          params = await getWithdrawalParams(network, tx_hash as Hex);
        } else {
          return { content: [{ type: "text", text: "Provide either tx_hash or params" }] };
        }
        if (await checkWithdrawalFinalized(network, params)) {
          return { content: [{ type: "text", text: JSON.stringify({
            status: "already-claimed",
            note: "This withdrawal was already finalized on L1 — finalizeDeposit has been called. The tokens have been released to the L1 receiver.",
          }, null, 2) }] };
        }
        const txHash = await claimWithdrawal(l1WalletFor(network, account), network, params);
        return {
          content: [{ type: "text", text: JSON.stringify({
            txHash,
            note: "Claim submitted on L1. Tokens are released to the L1 receiver from the Native Token Vault.",
          }, null, 2) }],
        };
      },
    );
  }
}

/** Build a deposit tx without sending (for preview/audit). */
export async function previewDepositTx(
  network: NetworkId,
  token: Address,
  amount: bigint,
  to: Address,
  from: Address,
): Promise<{ to: Address; data: Hex; value: bigint; mintValue: bigint; isAdi: boolean }> {
  const net = NETWORKS[network];
  const isAdi = token.toLowerCase() === net.l1Adi.toLowerCase();
  const { tx, mintValue } = isAdi
    ? await buildAdiDepositTx(network, { token, amount, to, from })
    : await buildErc20DepositTx(network, { token, amount, to, from });
  return { ...tx, mintValue, isAdi };
}
