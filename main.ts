// Launch-surge sniper for agent-fun/replay/v2 (pump.fun bonding-curve replay),
// tuned for the SHARPE SPRINT: the rank key is the hourly Sharpe ratio, not
// net PnL, so this bot optimises for steady, low-variance hourly gains.
//
// Idea, measured on the dev window's own data: a coin's fate is largely written
// in its CREATE SLOT. Coins with >=5 SOL of buys and >=8 distinct buyers in the
// create slot peak >=2x half the time and complete ~19% of the time; coins with
// <0.5 SOL of create-slot buys almost never peak above 1.5x. So this bot buys
// only those hot launches, at age 0-1, then sells everything at +20% over cost,
// cuts fast at -5%, or exits after 300 slots if it never pops. The tight stop
// keeps losing hours small (the variance term of the Sharpe ratio), the +20%
// take-profit caps each win so no single hour dominates the hourly returns,
// and stakes are capped by the harness's per-mint order cap (maxBuyLamports).
// Fast turnover through the 5 open-position slots, and a probe fallback that
// keeps the guardrail (20 coins, 0.01 SOL round trips) on pace over the 6-hour
// final window if entries dry up.

//
// Deterministic by construction: no clock, no randomness, no I/O, no network.
// Every decision is a pure function of the hello, the batches and the account
// the harness reports; iteration is only over insertion-ordered maps fed by the
// batch stream, so two runs produce byte-identical action logs.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';
import { pathToFileURL } from 'node:url';

export interface Params {
  /** Oldest age (slots since CreateEvent) at which a first buy may be decided. */
  maxEntryAge: number;
  /** Create-slot net buy SOL (buys minus sells) required. */
  minBuySol0: number;
  /** Create-slot net buy SOL allowed at most (0 = no cap). */
  maxBuySol0: number;
  /** Create-slot distinct non-creator buyers required. */
  minBuyers0: number;
  /** Create-slot distinct non-creator buyers allowed at most (0 = no cap). */
  maxBuyers0: number;
  /** Create-slot trades required. */
  minTrades0: number;
  /** Skip a coin whose creator sold in the create slot. */
  skipDevSold: boolean;
  /** SOL staked per coin (one buy, no adds), capped by the harness order cap. */
  stakeSol: number;
  /** First take-profit: sell tp1PartBps of the position at +tp1Bps over cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** Sell everything when the position is worth this much under its cost (bps). */
  slBps: number;
  /** Runner trailing stop: sell when value falls this much under its peak (bps). */
  runnerTrailBps: number;
  /** Runner floor: sell when value falls this much under its cost (bps). */
  runnerFloorBps: number;
  /** Runner max hold, slots. */
  maxHold: number;
  /** Max hold before any take-profit, slots: exit if it never pops. */
  preTpMaxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Guardrail pacing: keep coins/fills on pace toward these targets over paceSecs. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Settings tuned for HOURLY SHARPE on the dev window (24h full + four 6h slices,
// the final window's shape), preferring the flat region around them:
// buyers>=8 + buySol>=5, stake 0.5 SOL, take all at +20%, stop -5%, hold 300,
// probes paced over 6h toward 22 coins at 0.01 SOL.
// Dev (grade-local, new kit): Sharpe 0.57, net +0.83 SOL, 49 coins, dd 0.9%;
// 6h slices: Sharpe 0.24 / 0.73 / 0.71 / 0.42, all PnL-positive, >=22 coins.
export const DEFAULT_PARAMS: Params = {
  maxEntryAge: 1,
  minBuySol0: 5,
  maxBuySol0: 0,
  minBuyers0: 8,
  maxBuyers0: 0,
  minTrades0: 2,
  skipDevSold: true,
  stakeSol: 0.5,
  tp1Bps: 2000,
  tp1PartBps: 10000,
  slBps: 500,
  runnerTrailBps: 2000,
  runnerFloorBps: 2000,
  maxHold: 300,
  preTpMaxHold: 300,
  exitOnDevSell: true,
  targetCoins: 22,
  targetFills: 240,
  paceSecs: 21600,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const BPS = 10_000;
/** Wide-open slippage, as the kit's equal-weight baseline does. */
const SLIP_BPS = 10_000;

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-slot tape: buys/sells in SOL, distinct buyers, trades, dev sold? */
  buySol0: number;
  sellSol0: number;
  buyers0: Set<Pubkey>;
  trades0: number;
  devSold0: boolean;
  /** Creator sold at any point while we watch. */
  devSold: boolean;
  /** Never buy it again (exited, filtered out, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Tx fees paid on this position's orders (lamports). */
  txPaid: bigint;
  /** Best close value seen (SOL) since the last regime change. */
  peakValue: number;
  tookTp1: boolean;
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - ((q * 125n + 9999n) / 10_000n);
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const fresh: Coin[] = [];
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: 'buy' while the probe buy is pending, 'sell' once selling. */
  const probes = new Map<Pubkey, 'buy' | 'sell'>();
  let probeSeq = 0;
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint, createSlot: -1, creator: '', buySol0: 0, sellSol0: 0,
        buyers0: new Set(), trades0: 0, devSold0: false, devSold: false,
        done: false, complete: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.createSlot = e.slot;
          c.creator = e.creator;
          fresh.push(c);
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          if (e.slot === c.createSlot) {
            c.trades0++;
            if (e.is_buy) {
              c.buySol0 += sol;
              if (e.user !== c.creator) c.buyers0.add(e.user);
            } else {
              c.sellSol0 += sol;
              if (e.user === c.creator) { c.devSold0 = true; c.devSold = true; }
            }
          } else if (!e.is_buy && e.user === c.creator) {
            c.devSold = true;
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) { c.complete = true; c.done = true; }
        }
      }
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
        // Probe state follows the probe orders' own client ids.
        if (f.client_id.startsWith('pb')) {
          if (f.status === 'filled' && f.side === 'buy') probes.set(f.mint, 'sell');
          else if (f.status !== 'filled') probes.delete(f.mint);
        } else if (f.client_id.startsWith('ps')) {
          if (f.status === 'filled' && f.side === 'sell') probes.delete(f.mint);
          else if (f.status !== 'filled') probes.set(f.mint, 'sell');
        }
      }
      // Track positions and the orders already in flight for them.
      const pendingSell = new Set<Pubkey>();
      const pendingBuy = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
        else pendingBuy.add(po.order.mint);
      }
      const txFee = state.txFeeLamports();
      for (const [mint, pos] of state.positions) {
        const c = coins.get(mint);
        if (held.get(mint) === undefined) {
          held.set(mint, {
            openedSlot: now, txPaid: txFee, peakValue: 0, tookTp1: false,
            devSoldAtOpen: c?.devSold ?? false,
          });
        }
      }
      const heldMints = new Set<Pubkey>();
      for (const mint of state.positions.keys()) if (!probes.has(mint)) heldMints.add(mint);
      const openSlots = state.committedPositionCount();

      const orders: OrderInput[] = [];
      const push = (o: OrderInput) => { if (orders.length < 16) orders.push(o); };
      const nowSecs = lastTime !== null && firstTime !== null ? lastTime - firstTime : 0;
      const pace = nowSecs > 0 && p.paceSecs > 0 ? Math.min(1, nowSecs / p.paceSecs) : 0;

      // --- Exits: exit fast when a held position has stopped being useful. ---
      for (const mint of heldMints) {
        const pos = state.positions.get(mint)!;
        const c = coins.get(mint);
        if (c === undefined) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        const h = held.get(mint)!;
        const value = Number(sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves)) / LAMPORTS;
        const cost = Number(pos.cost_lamports + h.txPaid) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        const age = now - h.openedSlot;
        let exitAll = false;
        let takePartial = false;

        if (c.complete || curve.complete) exitAll = true;
        else if (p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exitAll = true;
        else if (value <= cost * (1 - p.slBps / BPS)) exitAll = true;
        else if (!h.tookTp1 && value >= cost * (1 + p.tp1Bps / BPS)) takePartial = true;
        else if (h.tookTp1 && value <= h.peakValue * (1 - p.runnerTrailBps / BPS)) exitAll = true;
        else if (h.tookTp1 && value <= cost * (1 - p.runnerFloorBps / BPS)) exitAll = true;
        else if (!h.tookTp1 && age >= p.preTpMaxHold) exitAll = true;
        else if (h.tookTp1 && age >= p.maxHold) exitAll = true;

        if (!exitAll && takePartial && !pendingSell.has(mint)) {
          const part = (pos.token_amount * BigInt(p.tp1PartBps)) / BigInt(BPS);
          if (part < pos.token_amount) {
            push({ mint, side: 'sell', token_amount: part, max_slippage_bps: SLIP_BPS });
            h.tookTp1 = true;
            h.peakValue = value;
          } else {
            exitAll = true;
          }
        }
        if (exitAll && !pendingSell.has(mint)) {
          push({ mint, side: 'sell', token_amount: pos.token_amount, max_slippage_bps: SLIP_BPS });
          held.delete(mint);
          c.done = true;
        }
      }

      // --- Entries: buy only hot launches, at age 0-1, small stake, no adds. ---
      while (fresh.length > 0 && now - fresh[0].createSlot > p.maxEntryAge) fresh.shift();
      const stakeLamports = BigInt(Math.round(p.stakeSol * LAMPORTS));
      for (const c of fresh) {
        if (openSlots + orders.filter((o) => o.side === 'buy').length >= 5) break;
        if (orders.length >= 16) break;
        const age = now - c.createSlot;
        if (age < 0 || age > p.maxEntryAge) continue;
        if (c.done || c.complete || c.devSold0) continue;
        if (c.buySol0 - c.sellSol0 < p.minBuySol0) continue;
        if (p.maxBuySol0 > 0 && c.buySol0 - c.sellSol0 > p.maxBuySol0) continue;
        if (c.buyers0.size < p.minBuyers0) continue;
        if (p.maxBuyers0 > 0 && c.buyers0.size > p.maxBuyers0) continue;
        if (c.trades0 < p.minTrades0) continue;
        if (p.skipDevSold && c.devSold) continue;
        if (heldMints.has(c.mint) || pendingBuy.has(c.mint)) continue;
        const cap = state.maxBuyLamports(c.mint);
        if (cap <= 0n) continue;
        const spend = stakeLamports < cap ? stakeLamports : cap;
        push({ mint: c.mint, side: 'buy', quote_lamports: spend, max_slippage_bps: SLIP_BPS });
        c.done = true;
      }

      // --- Guardrail probes: tiny round trips on new coins when the count is behind pace. ---
      const paceCoins = p.targetCoins * pace;
      const paceFills = p.targetFills * pace;
      if (myCoins.size < paceCoins && myFills < paceFills) {
        // Sell any probe whose buy has landed, at whatever the price is. A
        // probe is guardrail insurance, not a trade: waiting for breakeven
        // would strand it in a crashed coin and clog the 5 open-position
        // slots, blocking the real entries. The round trip costs ~2 tx fees
        // plus the curve fee on 0.012 SOL.
        for (const [mint, stage] of probes) {
          if (orders.length >= 16) break;
          if (stage !== 'sell') continue;
          if (pendingSell.has(mint)) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          push({ mint, side: 'sell', token_amount: pos.token_amount, max_slippage_bps: SLIP_BPS, client_id: `ps${probeSeq++}` });
        }
        // Open one probe at a time, on a coin trading in this batch with room
        // under its order cap. (Candidates come from this batch's trades only:
        // scanning every known coin each batch is O(coins) and far too slow.)
        const buying = [...probes.values()].filter((s) => s === 'buy').length;
        if (buying < p.maxProbes && openSlots + orders.filter((o) => o.side === 'buy').length < 5) {
          const seen = new Set<Pubkey>();
          for (const e of batch.events) {
            if (orders.length >= 16) break;
            if (e.event !== 'TradeEvent') continue;
            if (seen.has(e.mint)) continue;
            seen.add(e.mint);
            const c = coins.get(e.mint);
            if (c === undefined) continue;
            if (c.done || c.complete || c.devSold) continue;
            if (heldMints.has(c.mint) || pendingBuy.has(c.mint) || probes.has(c.mint)) continue;
            const curve = state.curves.get(c.mint);
            if (curve === undefined || curve.complete) continue;
            const cap = state.maxBuyLamports(c.mint);
            const probeSpend = BigInt(Math.round(p.probeSol * LAMPORTS));
            if (cap < probeSpend) continue;
            push({ mint: c.mint, side: 'buy', quote_lamports: probeSpend, max_slippage_bps: SLIP_BPS, client_id: `pb${probeSeq++}` });
            probes.set(c.mint, 'buy');
            break;
          }
        }
      }

      return orders;
    },
  };
}

// Run the bot only when this file is executed directly (node main.ts), so the
// strategy can also be imported by a local backtest without hanging on stdin.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBot(createStrategy());
}
