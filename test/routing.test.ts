import { describe, expect, test } from "bun:test";
import { planFundingPath, bridgeOptionsFor } from "../src/routing.ts";
import { TOKENS, resolveToken } from "../src/domain.ts";

describe("resolveToken", () => {
  test("resolves by symbol case-insensitively", () => {
    expect(resolveToken("ADI", "mainnet")?.id).toBe("ADI");
    expect(resolveToken("usdc.e", "mainnet")?.id).toBe("USDC.e");
    expect(resolveToken("link", "mainnet")?.id).toBe("LINK");
    expect(resolveToken("CCIP-BnM", "testnet")?.id).toBe("CCIP-BnM");
  });

  test("resolves tADI to ADI", () => {
    expect(resolveToken("tADI", "testnet")?.id).toBe("ADI");
  });

  test("resolves by L2 address", () => {
    expect(resolveToken("0x9cb8142aEBBcdc60AF7c97Af897A67A8f3CA71C2", "mainnet")?.id).toBe("USDC.e");
  });

  test("resolves by L1 ADI address per network", () => {
    expect(resolveToken("0x8b1484d57abbe239bb280661377363b03c89caea", "mainnet")?.id).toBe("ADI");
    expect(resolveToken("0x2a98B46fe31BA8Be05ef1cE3D36e1f80Db04190D", "testnet")?.id).toBe("ADI");
  });

  test("returns undefined for unknown", () => {
    expect(resolveToken("DOGE", "mainnet")).toBeUndefined();
  });
});

describe("planFundingPath", () => {
  test("native ADI on mainnet: canonical bridge is the top route", () => {
    const plan = planFundingPath("mainnet", "native-ADI");
    expect(plan.routes[0]?.id).toBe("canonical-adi");
    expect(plan.routes[0]?.executable).toBe(true);
    expect(plan.constraints.some((c) => c.includes("USDC.e"))).toBe(true);
  });

  test("native ADI: swap service route is advisory-only", () => {
    const plan = planFundingPath("mainnet", "native-ADI");
    const swap = plan.routes.find((r) => r.id === "swap-service");
    expect(swap?.executable).toBe(false);
  });

  test("USDC source adds the multi-hop route", () => {
    const plan = planFundingPath("mainnet", "native-ADI", "USDC");
    expect(plan.routes.some((r) => r.id === "usdc-multihop")).toBe(true);
  });

  test("no USDC source omits the multi-hop route", () => {
    const plan = planFundingPath("mainnet", "native-ADI", "ETH");
    expect(plan.routes.some((r) => r.id === "usdc-multihop")).toBe(false);
  });

  test("USDC.e target on mainnet routes via CCIP", () => {
    const plan = planFundingPath("mainnet", "USDC.e");
    expect(plan.routes[0]?.id).toBe("ccip-USDC.e");
    expect(plan.routes[0]?.steps.some((s) => s.bridge === "ccip")).toBe(true);
  });

  test("CCIP-BnM target on testnet routes via CCIP", () => {
    const plan = planFundingPath("testnet", "CCIP-BnM");
    expect(plan.routes[0]?.id).toBe("ccip-CCIP-BnM");
  });

  test("unknown target yields no routes and a constraint", () => {
    const plan = planFundingPath("mainnet", "LINK");
    expect(plan.routes.length).toBeGreaterThan(0); // LINK has a CCIP pool
  });
});

describe("bridgeOptionsFor", () => {
  test("ADI supports canonical bridge", () => {
    const opts = bridgeOptionsFor("mainnet", TOKENS.ADI, "to-adi");
    const canonical = opts.find((o) => o.bridge === "canonical");
    expect(canonical?.supported).toBe(true);
  });

  test("USDC.e does NOT support canonical bridge", () => {
    const opts = bridgeOptionsFor("mainnet", TOKENS["USDC.e"], "to-adi");
    const canonical = opts.find((o) => o.bridge === "canonical");
    expect(canonical?.supported).toBe(false);
    expect(canonical?.note).toContain("cannot use the canonical bridge");
  });

  test("USDC.e supports CCIP", () => {
    const opts = bridgeOptionsFor("mainnet", TOKENS["USDC.e"], "to-adi");
    const ccip = opts.find((o) => o.bridge === "ccip");
    expect(ccip?.supported).toBe(true);
  });

  test("CCIP-BnM is the only CCIP token on testnet", () => {
    const opts = bridgeOptionsFor("testnet", TOKENS["CCIP-BnM"], "to-adi");
    expect(opts.find((o) => o.bridge === "ccip")?.supported).toBe(true);
  });
});
