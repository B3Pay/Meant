// @meantjs/reconcile as a TypeScript consumer uses it: is the transfer in the blocks read since the send?
import { DEDUP_WINDOW_NS, expectedTransaction, matchBlocks, type Icrc3Value, type MatchResult } from "@meantjs/reconcile";
import { principalFromText } from "@meantjs/format";
import { check } from "./check.mts";

const caller = "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae";
const to = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const stamp = 1791547200000000000n;
const expected = expectedTransaction("icrc1_transfer", { to: { owner: to, subaccount: null }, amount: 29000000n, fee: null, memo: null, from_subaccount: null, created_at_time: stamp }, caller);
check(expected !== undefined && expected.op === "xfer" && expected.btype === "1xfer", "the expected block");

const account = (owner: string): Icrc3Value => ({ tag: "Array", value: [{ tag: "Blob", value: principalFromText(owner) }] });
const block: Icrc3Value = {
  tag: "Map",
  value: [
    ["btype", { tag: "Text", value: "1xfer" }],
    ["ts", { tag: "Nat", value: stamp + 1n }],
    [
      "tx",
      {
        tag: "Map",
        value: [
          ["amt", { tag: "Nat", value: 29000000n }],
          ["from", account(caller)],
          ["to", account(to)],
          ["ts", { tag: "Nat", value: stamp }],
        ],
      },
    ],
  ],
};
const found: MatchResult = matchBlocks([{ id: 5n, block }], expected, { logLength: 6n, floor: 5n, inFlight: true, windowNs: DEDUP_WINDOW_NS });
check(found.status === "found" && found.block === 5n, "found");
const none = matchBlocks([], expected, { logLength: 5n, floor: 5n, inFlight: false });
check(none.status === "absent", "absent once nothing is in flight");
