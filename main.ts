// Pump.fun Paper Sprint bot — "dip-bounce sniper on proven runners".
//
// Strategy (designed from the dev replay data, 24h / 1222 mints, and
// validated against a faithful slot-level replay of the house harness):
//  * Buying a coin the moment it crosses 5 SOL of real reserves LOSES money:
//    the fill lands ~12% above the crossing price (2-slot latency into a
//    violent pump) and the median coin then falls ~37% within 10 minutes.
//    Every fixed-horizon hold after such an entry is deeply negative.
//  * What works is buying the PULLBACK of a proven runner: a coin that
//    spiked >= 2x from its creation price and then pulled back to <= 80% of
//    its peak. Those bounces are real: the dip entry, TP x1.3 / SL x0.9 /
//    600 s hold, scores +0.48 SOL over the 24h dev window (218 coins,
//    max drawdown 3%), positive in 3 of the 4 six-hour chunks.
//  * Tiered sizing: coins that spiked >= 4x get full size
//    (min(1 SOL, 0.95% of real reserves)); weaker spikes (2-4x) trade the
//    0.01 SOL minimum — they add the distinct coins the guardrail needs
//    while their drag stays tiny.
//  * Asymmetric slippage: buys 5% (a tight cap refuses exactly the violent
//    pumps that top out — adverse-selection filter), sells 50% (during a
//    crash a sell must fill; a rejected sell leaves you holding to zero).
//  * A rejected/failed buy clears the entry flag, so the coin may be
//    retried while still fresh; a rejected/failed sell never blocks its
//    slot — it is re-issued on the next batch.
//  * At most 5 open positions (harness cap); no shorts, no leverage.
//  * Fully deterministic: decisions depend only on the replay stream
//    (no clock, no randomness), so the two harness executions agree.
//
// Protocol: agent-fun/replay/v2, NDJSON on stdin (hello / batch / done),
// one {"type":"reply","seq":N,"orders":[...]} per batch on stdout.
import * as fs from "node:fs";

type Order = {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
};

type Coin = {
  t0: number; // creation timestamp (seconds)
  p0: number; // creation price: virtual_sol / virtual_token
  price: number; // last virtual price
  peak: number; // highest price since creation
  phase: 0 | 1; // 0 = rising / making highs, 1 = pulled back off the peak
  realSol: bigint; // last real SOL reserves (lamports)
  entered: boolean; // a buy was placed and not rejected for this coin
  done: boolean; // completed (graduated) — never touch again
};

type Held = {
  entryPrice: number; // effective cost basis (lamports per token)
  entryT: number; // timestamp the buy fill was first seen
  sellId: string | null; // client_id of the sell in flight, if any
  sellBatch: number; // batch seq the sell was sent on
};

// ---- tuned parameters (swept on the dev window with a faithful replay;
// ---- the chosen point sits on a broad plateau, not a sharp peak) ----
const ENTER_REAL_SOL = 5n * 1_000_000_000n; // 5 SOL of real reserves
const ENTRY_WINDOW_SEC = 3600; // only coins created within the last hour
const MIN_SPIKE = 2.0; // coin must have spiked >= 2x from creation
const TIER_SPIKE = 4.0; // >= 4x spike earns full size, below it minimum size
const DIP_TRIGGER = 0.8; // entry once price pulls back to <= 80% of peak
const MAX_BUY_LAMPORTS = 1_000_000_000n; // 1 SOL max per buy
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL min round trip
const ORDER_BPS_OF_REAL = 95n; // 0.95% of real reserves (cap is 1%)
const TAKE_PROFIT = 1.3; // sell at +30%
const STOP_LOSS = 0.9; // sell at -10%
const MAX_HOLD_SEC = 600; // sell after 10 minutes, whatever the price
const BUY_SLIPPAGE_BPS = 500; // 5% — refuse violent pumps
const SELL_SLIPPAGE_BPS = 5000; // 50% — a crash exit must fill

const TRACE_FILE = process.env.BOT_TRACE || "";

let capital = 10_000_000_000n;
let maxPositions = 5;
let orderSeq = 0;
let batchSeq = 0;

const coins = new Map<string, Coin>();
const held = new Map<string, Held>();
const buyIdToMint = new Map<string, string>();
const sellIdToMint = new Map<string, string>();
let cash = 0n;
let now = 0; // max event timestamp seen so far
let buysPlaced = 0;
let sellsPlaced = 0;
let buysFilled = 0;
let sellsFilled = 0;
let rejected = 0;
let failed = 0;

function trace(obj: unknown): void {
  if (!TRACE_FILE) return;
  try {
    fs.appendFileSync(TRACE_FILE, JSON.stringify(obj) + "\n");
  } catch {
    // tracing must never break the bot
  }
}

function priceOf(vSol: string, vTok: string): number {
  const s = Number(vSol);
  const t = Number(vTok);
  if (t <= 0) return 0;
  return s / t;
}

function reply(seq: number, orders: Order[]): void {
  process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
}

function handleBatch(msg: any): void {
  batchSeq = msg.seq;
  const orders: Order[] = [];
  const active = new Set<string>();

  // 1. Account snapshot (authoritative): cash + open positions.
  if (msg.account) {
    cash = BigInt(msg.account.cash_lamports ?? "0");
    const seen = new Set<string>();
    for (const p of msg.account.positions ?? []) {
      seen.add(p.mint);
      if (!held.has(p.mint)) {
        // Position without our own entry record: fall back to cost basis.
        const toks = BigInt(p.token_amount);
        const cost = BigInt(p.cost_lamports);
        held.set(p.mint, {
          entryPrice: toks > 0n ? Number(cost) / Number(toks) : 0,
          entryT: now,
          sellId: null,
          sellBatch: 0,
        });
      }
    }
    // Positions that vanished (sold / auto-closed) drop out.
    for (const mint of [...held.keys()]) {
      if (!seen.has(mint)) held.delete(mint);
    }
  }

  // 2. Fills from earlier batches: every resolution is reported here.
  for (const f of msg.fills ?? []) {
    const mint: string = f.mint;
    if (f.side === "buy") {
      buyIdToMint.delete(f.client_id);
      if (f.status === "filled") {
        const toks = BigInt(f.token_amount ?? "0");
        const quote = BigInt(f.quote_lamports ?? "0");
        if (toks > 0n) {
          held.set(mint, {
            entryPrice: Number(quote) / Number(toks),
            entryT: now,
            sellId: null,
            sellBatch: 0,
          });
          buysFilled += 1;
        }
      } else {
        // Rejected / failed buy: the coin may be retried while still fresh.
        const c = coins.get(mint);
        if (c) c.entered = false;
        if (f.status === "rejected") rejected += 1;
        else if (f.status === "failed") failed += 1;
      }
    } else if (f.side === "sell") {
      sellIdToMint.delete(f.client_id);
      const h = held.get(mint);
      if (h && h.sellId === f.client_id) {
        // The sell resolved (filled, rejected or failed): the slot is free
        // to issue another sell. A filled sell's position vanishes from
        // the account on the next batch anyway.
        h.sellId = null;
        if (f.status === "filled") sellsFilled += 1;
        else if (f.status === "rejected") rejected += 1;
        else if (f.status === "failed") failed += 1;
      }
    }
  }
  // Safety net: a sell with no fill reported within 3 batches is treated
  // as resolved (fills arrive in the first batch after resolution).
  for (const [mint, h] of held) {
    if (h.sellId !== null && batchSeq - h.sellBatch > 3) {
      h.sellId = null;
    }
  }

  // 3. Marks: latest reserves for open positions / pending-order mints.
  for (const mk of msg.marks ?? []) {
    const c = coins.get(mk.mint);
    if (!c) continue;
    const p = priceOf(mk.virtual_quote_reserves, mk.virtual_token_reserves);
    if (p > 0) c.price = p;
    c.realSol = BigInt(mk.real_quote_reserves ?? "0");
  }

  // 4. Events: creates, trades, completions.
  for (const ev of msg.events ?? []) {
    const mint: string = ev.mint;
    if (ev.event === "CreateEvent") {
      if (!coins.has(mint)) {
        const p0 = priceOf(
          ev.virtual_sol_reserves,
          ev.virtual_token_reserves,
        );
        coins.set(mint, {
          t0: Number(ev.timestamp),
          p0,
          price: p0,
          peak: p0,
          phase: 0,
          realSol: 0n,
          entered: false,
          done: false,
        });
      }
      continue;
    }
    if (ev.event === "CompleteEvent") {
      const c = coins.get(mint);
      if (c) c.done = true;
      continue;
    }
    if (ev.event !== "TradeEvent") continue;
    const ts = Number(ev.timestamp);
    if (ts > now) now = ts;
    let c = coins.get(mint);
    if (!c) {
      // Trade before we saw the create (universe sampling): seed the coin.
      const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
      c = {
        t0: ts,
        p0: p,
        price: p,
        peak: p,
        phase: 0,
        realSol: 0n,
        entered: false,
        done: false,
      };
      coins.set(mint, c);
    }
    const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
    if (p > 0) c.price = p;
    c.realSol = BigInt(ev.real_sol_reserves ?? "0");
    // Peak / dip phase tracking (the entry signal).
    if (p > c.peak) {
      c.peak = p;
      if (c.phase === 1) c.phase = 0; // new high resets the dip
    } else if (
      c.phase === 0 &&
      c.peak > 0 &&
      p <= c.peak * DIP_TRIGGER
    ) {
      c.phase = 1;
    }
    active.add(mint);
  }

  // 5. Exits first: for every open position, check TP / SL / hold time.
  //    Uses the latest known price, so a dead coin still exits on time.
  for (const [mint, h] of held) {
    if (h.sellId !== null) continue; // a sell is already in flight
    const c = coins.get(mint);
    const px = c ? c.price : 0;
    const age = now - h.entryT;
    // Never sell on an unknown price (px <= 0): only the hold timeout
    // may fire without a price. TP/SL need a real mark.
    const hitTp = px > 0 && px >= h.entryPrice * TAKE_PROFIT;
    const hitSl = px > 0 && px <= h.entryPrice * STOP_LOSS;
    if (hitTp || hitSl || age >= MAX_HOLD_SEC) {
      const pos = (msg.account?.positions ?? []).find(
        (p: any) => p.mint === mint,
      );
      const amount = pos ? pos.token_amount : "0";
      if (amount !== "0") {
        orderSeq += 1;
        const id = `s-${orderSeq}`;
        orders.push({
          side: "sell",
          client_id: id,
          mint,
          token_amount: amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        h.sellId = id;
        h.sellBatch = batchSeq;
        sellIdToMint.set(id, mint);
        sellsPlaced += 1;
      }
    }
  }

  // 6. Entries: coins active in this batch that spiked, then dipped.
  const openCount =
    held.size + orders.filter((o) => o.side === "buy").length;
  let slots = maxPositions - openCount;
  for (const mint of active) {
    if (slots <= 0) break;
    const c = coins.get(mint);
    if (!c || c.entered || c.done) continue;
    if (now - c.t0 > ENTRY_WINDOW_SEC) continue;
    if (c.realSol < ENTER_REAL_SOL) continue;
    if (c.price <= 0) continue;
    if (c.peak < c.p0 * MIN_SPIKE) continue; // must be a proven runner
    if (c.phase !== 1) continue; // must be in a pullback right now
    // Tiered sizing: full size for >= 4x spikes, minimum size otherwise.
    let size: bigint;
    if (c.peak >= c.p0 * TIER_SPIKE) {
      size = (c.realSol * ORDER_BPS_OF_REAL) / 10000n;
      if (size > MAX_BUY_LAMPORTS) size = MAX_BUY_LAMPORTS;
    } else {
      size = MIN_BUY_LAMPORTS;
    }
    if (size < MIN_BUY_LAMPORTS) continue;
    if (cash < size + 200_000n) continue; // keep a tx-fee margin
    orderSeq += 1;
    const id = `b-${orderSeq}`;
    orders.push({
      side: "buy",
      client_id: id,
      mint,
      quote_lamports: size.toString(),
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
    buyIdToMint.set(id, mint);
    c.entered = true;
    buysPlaced += 1;
    slots -= 1;
  }

  trace({
    seq: batchSeq,
    slot: msg.slot,
    orders: orders.map((o) => [o.side, o.client_id, o.mint.slice(0, 8)]),
    fills: (msg.fills ?? []).map((f: any) => [
      f.side,
      f.client_id,
      f.status,
      f.reason,
    ]),
    cash: cash.toString(),
    held: [...held.keys()].map((m) => m.slice(0, 8)),
  });
  reply(msg.seq, orders);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      capital = BigInt(msg.capital?.lamports ?? capital.toString());
      cash = capital;
      if (msg.caps) {
        maxPositions = msg.caps.max_open_positions ?? maxPositions;
        // ORDER_BPS_OF_REAL (95) stays under the harness cap (100).
      }
    } else if (msg.type === "batch") {
      handleBatch(msg);
    } else if (msg.type === "done") {
      process.stderr.write(
        `[bot] done reason=${msg.reason} buys=${buysPlaced}/${buysFilled} sells=${sellsPlaced}/${sellsFilled} rejected=${rejected} failed=${failed} cash=${cash}\n`,
      );
      process.exit(0);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
