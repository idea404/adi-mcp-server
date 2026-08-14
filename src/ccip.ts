/**
 * CCIP execution: ccipSend on the ADI CCIP router. Selector 0x96f4e9f9
 * verified present in the router bytecode on ADI Mainnet.
 *
 * Signing: same model as the canonical bridge — callers pass a viem
 * WalletClient; the server never holds keys.
 */

import { encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex, type WalletClient } from "viem";
import { NETWORKS, type NetworkId } from "./domain.ts";
import { getProviders } from "./providers.ts";

const ccipRouterAbi = parseAbi([
  "function ccipSend(uint64 destinationChainSelector, (bytes,bytes,(address,uint256)[],address,bytes) message) payable returns (bytes32 messageId)",
] as const);

export interface CcipSendParams {
  network: NetworkId;
  /** destination chain selector (e.g. Ethereum mainnet 5009297430713026196) */
  destinationChainSelector: bigint;
  /** token to send (must have a CCIP pool on ADI) */
  token: Address;
  amount: bigint;
  /** destination receiver address, abi.encode(address) */
  receiver: Address;
  /** fee token: address(0) = native ADI */
  feeToken?: Address;
  /** extra args: abi.encode(Client.EVMExtraArgsV1({gasLimit, strict})) */
  extraArgs?: Hex;
}

/** Build the ccipSend transaction. */
export function buildCcipSendTx(params: CcipSendParams): { to: Address; data: Hex; value: bigint } {
  const net = NETWORKS[params.network];
  const receiver = encodeAbiParameters([{ type: "address" }], [params.receiver]);
  const extraArgs = params.extraArgs ?? encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "uint256", name: "gasLimit" }, { type: "bool", name: "strict" }] }],
    [{ gasLimit: 0n, strict: false }],
  );

  const data = encodeFunctionData({
    abi: ccipRouterAbi,
    functionName: "ccipSend",
    args: [
      params.destinationChainSelector,
      [
        receiver,
        "0x",
        [[params.token, params.amount]],
        params.feeToken ?? "0x0000000000000000000000000000000000000000",
        extraArgs,
      ],
    ],
  });

  return { to: net.ccipRouter, data, value: 0n };
}

/** Execute a CCIP transfer. Returns the L2 tx hash and the CCIP messageId. */
export async function ccipSend(
  wallet: WalletClient,
  params: CcipSendParams,
): Promise<{ txHash: Hex; messageId: Hex }> {
  const { l2 } = getProviders(params.network);
  const net = NETWORKS[params.network];
  const { to, data, value } = buildCcipSendTx(params);

  const txHash = await wallet.sendTransaction({
    to,
    data,
    value,
    chain: { id: net.chainId, name: net.name, nativeCurrency: { name: "ADI", symbol: "ADI", decimals: 18 }, rpcUrls: { default: { http: [net.rpcUrl] } } },
    account: wallet.account!,
  });

  const receipt = await l2.waitForTransactionReceipt({ hash: txHash });
  const log = receipt.logs.find((l) => l.address.toLowerCase() === net.ccipRouter.toLowerCase());
  const messageId = log ? (log.topics[1] as Hex) : "0x";
  return { txHash, messageId };
}
