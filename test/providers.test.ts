import { describe, expect, test } from "bun:test";
import { normalizeL2ToL1Log, type L2ToL1Log } from "../src/providers.ts";

const SENDER = "0x0000000000000000000000000000000000008008" as const;
const KEY = "0x000000000000000000000000000000000000000000000000000000000000800a" as const;
const VALUE = "0xc454a82687afb8de2698444b065168422b029ecfc2efff7910a1718ba62be0f7" as const;

describe("normalizeL2ToL1Log", () => {
  test("normalizes the camelCase shape the ADI node returns today", () => {
    const log = {
      transactionIndex: "0x2",
      isService: true,
      shardId: "0x0",
      sender: SENDER,
      key: KEY,
      value: VALUE,
    } as unknown as L2ToL1Log;

    expect(normalizeL2ToL1Log(log)).toEqual({
      txNumberInBatch: 2,
      isService: true,
      shardId: 0,
      sender: SENDER,
      key: KEY,
      value: VALUE,
    });
  });

  test("normalizes the older snake_case shape to the same values", () => {
    const log = {
      tx_number_in_block: 2,
      is_service: true,
      l2_shard_id: 0,
      sender: SENDER,
      key: KEY,
      value: VALUE,
    } as L2ToL1Log;

    expect(normalizeL2ToL1Log(log)).toEqual({
      txNumberInBatch: 2,
      isService: true,
      shardId: 0,
      sender: SENDER,
      key: KEY,
      value: VALUE,
    });
  });

  test("throws when no transaction index is present", () => {
    const log = { sender: SENDER, key: KEY, value: VALUE } as L2ToL1Log;
    expect(() => normalizeL2ToL1Log(log)).toThrow();
  });

  test("defaults shard and service flags when the node omits them", () => {
    const log = { transactionIndex: "0x0", sender: SENDER, key: KEY, value: VALUE } as unknown as L2ToL1Log;
    const normalized = normalizeL2ToL1Log(log);
    expect(normalized.shardId).toBe(0);
    expect(normalized.isService).toBe(false);
  });
});
