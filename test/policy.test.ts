import { describe, expect, test } from "bun:test";
import { TOKENS } from "../src/domain.ts";
import { assertAddress, assertCanonicalToken, assertCcipToken, assertDestinationSelector, assertNetworkCapability, parsePositiveAmount } from "../src/policy.ts";

describe("write policy", () => {
  test("disables canonical writes and claims on testnet", () => {
    expect(() => assertNetworkCapability("testnet", "canonicalDeposit")).toThrow();
    expect(() => assertNetworkCapability("testnet", "canonicalWithdraw")).toThrow();
    expect(() => assertNetworkCapability("testnet", "claim")).toThrow();
  });

  test("accepts only positive amounts", () => {
    expect(parsePositiveAmount("1.5", 18)).toBe(1500000000000000000n);
    expect(() => parsePositiveAmount("0", 18)).toThrow();
    expect(() => parsePositiveAmount("-1", 18)).toThrow();
    expect(() => parsePositiveAmount("not-a-number", 18)).toThrow();
  });

  test("rejects zero addresses", () => {
    expect(() => assertAddress("0x0000000000000000000000000000000000000000", "receiver")).toThrow();
    expect(() => assertAddress("0x0000000000000000000000000000000000000001", "receiver")).not.toThrow();
  });

  test("restricts canonical bridge to mainnet ADI", () => {
    expect(() => assertCanonicalToken("mainnet", TOKENS.ADI)).not.toThrow();
    expect(() => assertCanonicalToken("mainnet", TOKENS.LINK)).toThrow();
    expect(() => assertCanonicalToken("testnet", TOKENS.ADI)).toThrow();
  });

  test("restricts CCIP tokens by network", () => {
    expect(() => assertCcipToken("mainnet", TOKENS.LINK)).not.toThrow();
    expect(() => assertCcipToken("testnet", TOKENS["CCIP-BnM"])).not.toThrow();
    expect(() => assertCcipToken("testnet", TOKENS.LINK)).toThrow();
  });

  test("rejects invalid CCIP destination selectors", () => {
    expect(() => assertDestinationSelector("mainnet", 0n)).toThrow();
    expect(() => assertDestinationSelector("mainnet", 4059281736450291836n)).toThrow();
    expect(() => assertDestinationSelector("mainnet", 5009297430713026196n)).not.toThrow();
  });
});