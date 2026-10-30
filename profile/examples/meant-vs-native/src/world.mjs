// A local world: one PocketIC instance with two real DFINITY ICRC ledgers (the pinned ledger-suite release) holding
// test tokens. No mainnet, no real funds: while it runs, fetch refuses every host but this machine.
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { PocketIc, PocketIcServer, SubnetStateType } from "@dfinity/pic";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { manifest, paths, platformKey, readVerified } from "./artifacts.mjs";

const fixed = (n) => Principal.fromUint8Array(Uint8Array.from({ length: 29 }, (_, i) => (i === 28 ? 0x02 : (n * 31 + i) & 0xff)));
export const ALICE = fixed(1); // the person (and the agent acting for them)
export const BOB = fixed(2); // the recipient
const CONTROLLER = fixed(3);
const MINTER = fixed(4);

/** Test tokens with the decimals of ICP (TKA), ckUSDC (TKB) and ckETH (TKC). */
export const TOKENS = [
  { symbol: "TKA", decimals: 8, fee: 10_000n, start: 10n * 10n ** 8n },
  { symbol: "TKB", decimals: 6, fee: 10_000n, start: 1_000n * 10n ** 6n },
  { symbol: "TKC", decimals: 18, fee: 2_000_000_000_000n, start: 10n * 10n ** 18n },
];

const Account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
const MetadataValue = IDL.Variant({ Nat: IDL.Nat, Int: IDL.Int, Text: IDL.Text, Blob: IDL.Vec(IDL.Nat8) });
const InitArgs = IDL.Record({
  minting_account: Account, fee_collector_account: IDL.Opt(Account), transfer_fee: IDL.Nat, decimals: IDL.Opt(IDL.Nat8),
  max_memo_length: IDL.Opt(IDL.Nat16), token_symbol: IDL.Text, token_name: IDL.Text,
  metadata: IDL.Vec(IDL.Tuple(IDL.Text, MetadataValue)), initial_balances: IDL.Vec(IDL.Tuple(Account, IDL.Nat)),
  feature_flags: IDL.Opt(IDL.Record({ icrc2: IDL.Bool })),
  archive_options: IDL.Record({
    num_blocks_to_archive: IDL.Nat64, max_transactions_per_response: IDL.Opt(IDL.Nat64), trigger_threshold: IDL.Nat64,
    max_message_size_bytes: IDL.Opt(IDL.Nat64), cycles_for_archive_creation: IDL.Opt(IDL.Nat64),
    node_max_memory_size_bytes: IDL.Opt(IDL.Nat64), controller_id: IDL.Principal, more_controller_ids: IDL.Opt(IDL.Vec(IDL.Principal)),
  }),
  index_principal: IDL.Opt(IDL.Principal),
});
const LedgerArg = IDL.Variant({ Init: InitArgs, Upgrade: IDL.Opt(IDL.Reserved) });

function ledgerInit(t) {
  return new Uint8Array(IDL.encode([LedgerArg], [{
    Init: {
      minting_account: { owner: MINTER, subaccount: [] }, fee_collector_account: [], transfer_fee: t.fee, decimals: [t.decimals],
      max_memo_length: [32], token_symbol: t.symbol, token_name: `Test ${t.symbol}`, metadata: [],
      initial_balances: [[{ owner: ALICE, subaccount: [] }, t.start]], feature_flags: [{ icrc2: true }],
      archive_options: {
        num_blocks_to_archive: 1000n, max_transactions_per_response: [], trigger_threshold: 100_000n, max_message_size_bytes: [],
        cycles_for_archive_creation: [], node_max_memory_size_bytes: [], controller_id: CONTROLLER, more_controller_ids: [],
      },
      index_principal: [],
    },
  }]));
}

/** Refuse any request that leaves this machine: the demo never talks to mainnet. */
function guardFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error(`refused: ${url.origin} is not this machine (no mainnet)`);
    return original(input, init);
  };
  return () => { globalThis.fetch = original; };
}

export async function startWorld() {
  const plat = manifest.pocket_ic.platforms[platformKey()];
  if (!plat) throw new Error(`no PocketIC build is pinned for ${platformKey()}`);
  readVerified(paths.pocketIc, plat.sha256);
  const wasm = gunzipSync(readVerified(paths.ledgerWasm, manifest.ledger.wasm.sha256));
  const did = readVerified(paths.ledgerDid, manifest.ledger.did.sha256).toString("utf8");
  const unguard = guardFetch();
  const server = await PocketIcServer.start({ binPath: paths.pocketIc });
  const pic = await PocketIc.create(server.getUrl(), { application: [{ state: { type: SubnetStateType.New } }] });
  const [app] = (await pic.getTopology()).filter((s) => s.type === "Application").map((s) => s.id);
  await pic.resetCertifiedTime();
  const tokens = [];
  for (const t of TOKENS) {
    const ledger = await pic.createCanister({ targetSubnetId: app, cycles: 10n ** 14n, sender: CONTROLLER });
    await pic.installCode({ canisterId: ledger, wasm, arg: ledgerInit(t), targetSubnetId: app, sender: CONTROLLER });
    tokens.push({ ...t, ledger });
  }
  const stop = async () => {
    try {
      await pic.tearDown();
    } finally {
      // PocketIcServer.stop() of @dfinity/pic 0.25.0 waits forever when the server already exited (observed).
      const proc = server.serverProcess;
      if (proc && proc.exitCode === null) {
        const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
        await server.stop().catch(() => {});
        clearTimeout(timer);
      }
      unguard();
    }
  };
  return { pic, did, tokens, stop };
}
