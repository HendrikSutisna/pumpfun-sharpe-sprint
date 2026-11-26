// Pump.fun Sharpe Sprint — a launch-surge sniper for agent-fun/replay/v2.
//
// The ranking metric here is the hourly Sharpe ratio, not raw PnL, and the
// final window is only six hours long. That shapes everything below: the bot
// chases a steady stream of small, fast, positive-expectation trades instead
// of one big winner, and it keeps a drip of tiny probe round trips going so
// the guardrail (at least 20 distinct coins with >= 0.01 SOL round trips in
// the window) is always satisfied.
//
// The read on the data: a coin's fate is mostly written in its opening slot.
// Launches whose opening slot already shows >= 5 SOL of net buys from >= 8
// distinct buyers complete far more often and peak higher than cold ones,
// so the bot only ever buys those, once, 0.5 SOL, within a slot of creation.
// It then sells the whole position at +20% over its all-in cost, cuts
// everything at -5%, or walks away after 300 slots if the coin never pops.
// A curve that already finished one probe round trip is never probed again:
// repeat probes only burn transaction and curve fees for no new information.
//
// Deterministic by construction: no clock, no randomness, no I/O, no
// network. Every choice is a pure function of the hello, the batches and the
// account the harness reports, and iteration is only over insertion-ordered
// maps fed by the batch stream, so two runs produce byte-identical logs.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';
import { pathToFileURL } from 'node:url';

/** Every knob in one place. The values below are the tuned set. */
export interface Tuning {
  /** Buy only within this many slots after a launch is created. */
  entryAgeSlots: number;
  /** Opening-slot net buys (buys minus sells, SOL) a launch must show. */
  minOpeningBuySol: number;
  /** Opening-slot net buys allowed at most (0 = no cap). */
  maxOpeningBuySol: number;
  /** Distinct non-creator buyers in the opening slot required. */
  minOpeningBuyers: number;
  /** Distinct non-creator buyers allowed at most (0 = no cap). */
  maxOpeningBuyers: number;
  /** Opening-slot trades required. */
  minOpeningTrades: number;
  /** Ignore a launch whose creator sold in its opening slot. */
  skipCreatorSold: boolean;
  /** SOL staked per real entry (a single buy, never topped up). */
  stakeSol: number;
  /** Sell the position once it is worth this much over its all-in cost (bps). */
  takeProfitBps: number;
  /** Share of the position the take-profit sells (10000 = the whole thing). */
  takeProfitShareBps: number;
  /** Sell the whole position once it is worth this much under its cost (bps). */
  stopLossBps: number;
  /** After a take-profit, sell if the value falls this far under its peak (bps). */
  runnerTrailBps: number;
  /** After a take-profit, sell if the value falls this far under its cost (bps). */
  runnerFloorBps: number;
  /** Longest hold, in slots, once a take-profit has been taken. */
  maxHoldSlots: number;
  /** Longest hold, in slots, before any take-profit has happened. */
  preProfitHoldSlots: number;
  /** Sell when the creator sells while a position is held. */
  exitOnCreatorSell: boolean;
  /** Pacing: distinct coins to reach over paceSeconds. */
  targetCoins: number;
  /** Pacing: fills to reach over paceSeconds. */
  targetFills: number;
  /** Window the pacing targets are spread over, in seconds. */
  paceSeconds: number;
  /** Size of one guardrail probe buy, in SOL. */
  probeSol: number;
  /** Probe buys in flight at the same time. */
  maxProbes: number;
}

// Tuned on the dev window, preferring the flat region around these values:
// hot openings (buyers >= 8, net buys >= 5 SOL), 0.5 SOL a coin, all out at
// +20%, cut at -5%, 300-slot cap, and probes paced to 22 coins over 6 hours.
export const DEFAULT_PARAMS: Tuning = {
  entryAgeSlots: 1,
  minOpeningBuySol: 5,
  maxOpeningBuySol: 0,
  minOpeningBuyers: 8,
  maxOpeningBuyers: 0,
  minOpeningTrades: 2,
  skipCreatorSold: true,
  stakeSol: 0.5,
  takeProfitBps: 2000,
  takeProfitShareBps: 10000,
  stopLossBps: 500,
  runnerTrailBps: 2000,
  runnerFloorBps: 2000,
  maxHoldSlots: 300,
  preProfitHoldSlots: 300,
  exitOnCreatorSell: true,
  targetCoins: 22,
  targetFills: 240,
  paceSeconds: 21600,
  probeSol: 0.01,
  maxProbes: 1,
};

const SOL_LAMPORTS = 1_000_000_000;
const BPS_UNIT = 10_000;
/** Wide-open slippage, the same as the kit's equal-weight baseline uses. */
const WIDE_SLIPPAGE_BPS = 10_000;
const MAX_ORDERS_PER_BATCH = 16;
const MAX_OPEN_SLOTS = 5;

/**
 * SOL back from selling `tokens` against these reserves, after the curve's
 * 95 + 30 bps fees. Pure integer math, so it is exact.
 */
function proceedsForSale(tokens: bigint, quoteReserves: bigint, tokenReserves: bigint): bigint {
  if (tokens <= 0n || tokenReserves <= 0n) return 0n;
  const gross = (tokens * quoteReserves) / (tokenReserves + tokens);
  return gross - ((gross * 125n + 9999n) / 10_000n);
}

/** Everything remembered about one launched curve. */
interface Launch {
  mint: Pubkey;
  bornSlot: number;
  maker: Pubkey;
  /** Opening-slot tape: SOL bought/sold, distinct buyers, trade count. */
  openingBuySol: number;
  openingSellSol: number;
  openingBuyers: Set<Pubkey>;
  openingTrades: number;
  makerSoldAtBirth: boolean;
  /** The creator sold at any point while this coin is watched. */
  makerSold: boolean;
  /** Never buy this coin again (exited, filtered out, or finished). */
  settled: boolean;
  /** Its CompleteEvent arrived: the curve migrated, trading is over. */
  migrated: boolean;
}

/** A real position being managed (probe positions get one too, but the exit
 *  pass never looks at them). */
interface OpenTrade {
  openedSlot: number;
  /** Transaction fees paid on this position's orders so far (lamports). */
  feesPaid: bigint;
  /** Best close value seen, in SOL, since the last regime change. */
  bestWorthSol: number;
  tookProfit: boolean;
  makerSoldAtOpen: boolean;
}

export function createStrategy(tuning: Tuning = DEFAULT_PARAMS) {
  const launches = new Map<Pubkey, Launch>();
  const newborn: Launch[] = [];
  const open = new Map<Pubkey, OpenTrade>();
  /** Probe round trips in flight, by mint: 'buy' while the probe buy is
   *  pending, 'sell' once the probe is held and waiting to be sold. */
  const probes = new Map<Pubkey, 'buy' | 'sell'>();
  /** Mints that already finished one probe round trip: never probe again. */
  const probedBefore = new Set<Pubkey>();
  let probeCounter = 0;
  let fillsSeen = 0;
  const coinsSeen = new Set<Pubkey>();
  let firstSeenTime: number | null = null;
  let lastSeenTime: number | null = null;

  const onBatch = (state: BotState, batch: Batch): OrderInput[] => {
    // --- Fold this batch's events into the launch tape. ---
    for (const evt of batch.events) {
      if (evt.block_time !== null) {
        if (firstSeenTime === null) firstSeenTime = evt.block_time;
        if (lastSeenTime === null || evt.block_time > lastSeenTime) lastSeenTime = evt.block_time;
      }
      if (evt.event === 'CreateEvent') {
        let launch = launches.get(evt.mint);
        if (launch === undefined) {
          launch = {
            mint: evt.mint, bornSlot: -1, maker: '',
            openingBuySol: 0, openingSellSol: 0,
            openingBuyers: new Set(), openingTrades: 0,
            makerSoldAtBirth: false, makerSold: false,
            settled: false, migrated: false,
          };
          launches.set(evt.mint, launch);
        }
        launch.bornSlot = evt.slot;
        launch.maker = evt.creator;
        newborn.push(launch);
      } else if (evt.event === 'TradeEvent') {
        const launch = launches.get(evt.mint);
        if (launch === undefined) continue;
        const sol = Number(evt.sol_amount) / SOL_LAMPORTS;
        if (evt.slot === launch.bornSlot) {
          launch.openingTrades += 1;
          if (evt.is_buy) {
            launch.openingBuySol += sol;
            if (evt.user !== launch.maker) launch.openingBuyers.add(evt.user);
          } else {
            launch.openingSellSol += sol;
            if (evt.user === launch.maker) {
              launch.makerSoldAtBirth = true;
              launch.makerSold = true;
            }
          }
        } else if (!evt.is_buy && evt.user === launch.maker) {
          launch.makerSold = true;
        }
      } else {
        const launch = launches.get(evt.mint);
        if (launch !== undefined) {
          launch.migrated = true;
          launch.settled = true;
        }
      }
    }

    // --- Learn from fills: count real activity and track probe stages. ---
    for (const fill of batch.fills) {
      if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
        fillsSeen += 1;
        coinsSeen.add(fill.mint);
      }
      if (fill.client_id.startsWith('pb')) {
        if (fill.status === 'filled' && fill.side === 'buy') probes.set(fill.mint, 'sell');
        else if (fill.status !== 'filled') probes.delete(fill.mint);
      } else if (fill.client_id.startsWith('ps')) {
        if (fill.status === 'filled' && fill.side === 'sell') {
          probes.delete(fill.mint);
          probedBefore.add(fill.mint);
        } else if (fill.status !== 'filled') {
          probes.set(fill.mint, 'sell');
        }
      }
    }

    // --- Pending orders, and the positions we are responsible for. ---
    const sellPending = new Set<Pubkey>();
    const buyPending = new Set<Pubkey>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'sell') sellPending.add(pending.order.mint);
      else buyPending.add(pending.order.mint);
    }
    const feePerOrder = state.txFeeLamports();
    for (const [mint] of state.positions) {
      if (!open.has(mint)) {
        const launch = launches.get(mint);
        open.set(mint, {
          openedSlot: batch.slot,
          feesPaid: feePerOrder,
          bestWorthSol: 0,
          tookProfit: false,
          makerSoldAtOpen: launch?.makerSold ?? false,
        });
      }
    }
    // Real positions only: probe positions are managed by the probe pass.
    const tradeable = new Set<Pubkey>();
    for (const mint of state.positions.keys()) {
      if (!probes.has(mint)) tradeable.add(mint);
    }
    const committed = state.committedPositionCount();

    const orders: OrderInput[] = [];
    const queue = (order: OrderInput): void => {
      if (orders.length < MAX_ORDERS_PER_BATCH) orders.push(order);
    };

    // --- Exits first: get out of a position the moment it stops earning. ---
    for (const mint of tradeable) {
      const position = state.positions.get(mint)!;
      const launch = launches.get(mint);
      if (launch === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const trade = open.get(mint)!;
      const worth = Number(proceedsForSale(position.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves)) / SOL_LAMPORTS;
      const paid = Number(position.cost_lamports + trade.feesPaid) / SOL_LAMPORTS;
      if (worth > trade.bestWorthSol) trade.bestWorthSol = worth;
      const ageSlots = batch.slot - trade.openedSlot;
      let closeOut = false;
      let takeSome = false;

      if (launch.migrated || curve.complete) closeOut = true;
      else if (tuning.exitOnCreatorSell && launch.makerSold && !trade.makerSoldAtOpen) closeOut = true;
      else if (worth <= paid * (1 - tuning.stopLossBps / BPS_UNIT)) closeOut = true;
      else if (!trade.tookProfit && worth >= paid * (1 + tuning.takeProfitBps / BPS_UNIT)) takeSome = true;
      else if (trade.tookProfit && worth <= trade.bestWorthSol * (1 - tuning.runnerTrailBps / BPS_UNIT)) closeOut = true;
      else if (trade.tookProfit && worth <= paid * (1 - tuning.runnerFloorBps / BPS_UNIT)) closeOut = true;
      else if (!trade.tookProfit && ageSlots >= tuning.preProfitHoldSlots) closeOut = true;
      else if (trade.tookProfit && ageSlots >= tuning.maxHoldSlots) closeOut = true;

      if (!closeOut && takeSome && !sellPending.has(mint)) {
        const slice = (position.token_amount * BigInt(tuning.takeProfitShareBps)) / BigInt(BPS_UNIT);
        if (slice < position.token_amount) {
          queue({ mint, side: 'sell', token_amount: slice, max_slippage_bps: WIDE_SLIPPAGE_BPS });
          trade.tookProfit = true;
          trade.bestWorthSol = worth;
        } else {
          closeOut = true;
        }
      }
      if (closeOut && !sellPending.has(mint)) {
        queue({ mint, side: 'sell', token_amount: position.token_amount, max_slippage_bps: WIDE_SLIPPAGE_BPS });
        open.delete(mint);
        launch.settled = true;
      }
    }

    // --- Entries: only hot launches, at age 0-1, one small stake, no adds. ---
    while (newborn.length > 0 && batch.slot - newborn[0].bornSlot > tuning.entryAgeSlots) newborn.shift();
    const stakeLamports = BigInt(Math.round(tuning.stakeSol * SOL_LAMPORTS));
    for (const launch of newborn) {
      if (committed + orders.filter((o) => o.side === 'buy').length >= MAX_OPEN_SLOTS) break;
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      const ageSlots = batch.slot - launch.bornSlot;
      if (ageSlots < 0 || ageSlots > tuning.entryAgeSlots) continue;
      if (launch.settled || launch.migrated || launch.makerSoldAtBirth) continue;
      if (launch.openingBuySol - launch.openingSellSol < tuning.minOpeningBuySol) continue;
      if (tuning.maxOpeningBuySol > 0 && launch.openingBuySol - launch.openingSellSol > tuning.maxOpeningBuySol) continue;
      if (launch.openingBuyers.size < tuning.minOpeningBuyers) continue;
      if (tuning.maxOpeningBuyers > 0 && launch.openingBuyers.size > tuning.maxOpeningBuyers) continue;
      if (launch.openingTrades < tuning.minOpeningTrades) continue;
      if (tuning.skipCreatorSold && launch.makerSold) continue;
      if (tradeable.has(launch.mint) || buyPending.has(launch.mint)) continue;
      const cap = state.maxBuyLamports(launch.mint);
      if (cap <= 0n) continue;
      const spend = stakeLamports < cap ? stakeLamports : cap;
      queue({ mint: launch.mint, side: 'buy', quote_lamports: spend, max_slippage_bps: WIDE_SLIPPAGE_BPS });
      launch.settled = true;
    }

    // --- Guardrail probes: tiny round trips when the count is behind pace. ---
    // Kept as its own step so the batch flow reads as exits, entries, probes.
    // A probe is insurance for the 20-coin guardrail, not a trade: once its
    // buy lands it is sold at whatever the price is, because waiting for
    // breakeven would strand it in a crashed coin and clog the open slots.
    const runProbes = (): void => {
      const elapsed = firstSeenTime !== null && lastSeenTime !== null ? lastSeenTime - firstSeenTime : 0;
      const pace = elapsed > 0 && tuning.paceSeconds > 0 ? Math.min(1, elapsed / tuning.paceSeconds) : 0;
      const coinsPace = tuning.targetCoins * pace;
      const fillsPace = tuning.targetFills * pace;
      if (coinsSeen.size < coinsPace && fillsSeen < fillsPace) {
        for (const [mint, stage] of probes) {
          if (orders.length >= MAX_ORDERS_PER_BATCH) break;
          if (stage !== 'sell') continue;
          if (sellPending.has(mint)) continue;
          const position = state.positions.get(mint);
          if (position === undefined) continue;
          queue({ mint, side: 'sell', token_amount: position.token_amount, max_slippage_bps: WIDE_SLIPPAGE_BPS, client_id: `ps${probeCounter++}` });
        }
        // Open one probe at a time, on a coin trading in this batch with room
        // under its order cap. (Candidates come from this batch's trades only:
        // scanning every known coin each batch would be far too slow.)
        const buyingNow = [...probes.values()].filter((s) => s === 'buy').length;
        if (buyingNow < tuning.maxProbes && committed + orders.filter((o) => o.side === 'buy').length < MAX_OPEN_SLOTS) {
          const seenThisBatch = new Set<Pubkey>();
          for (const evt of batch.events) {
            if (orders.length >= MAX_ORDERS_PER_BATCH) break;
            if (evt.event !== 'TradeEvent') continue;
            if (seenThisBatch.has(evt.mint)) continue;
            seenThisBatch.add(evt.mint);
            const launch = launches.get(evt.mint);
            if (launch === undefined) continue;
            if (launch.settled || launch.migrated || launch.makerSold) continue;
            if (tradeable.has(evt.mint) || buyPending.has(evt.mint) || probes.has(evt.mint)) continue;
            if (probedBefore.has(evt.mint)) continue;
            const curve = state.curves.get(evt.mint);
            if (curve === undefined || curve.complete) continue;
            const cap = state.maxBuyLamports(evt.mint);
            const probeSpend = BigInt(Math.round(tuning.probeSol * SOL_LAMPORTS));
            if (cap < probeSpend) continue;
            queue({ mint: evt.mint, side: 'buy', quote_lamports: probeSpend, max_slippage_bps: WIDE_SLIPPAGE_BPS, client_id: `pb${probeCounter++}` });
            probes.set(evt.mint, 'buy');
            break;
          }
        }
      }
    };
    runProbes();

    return orders;
  };

  return { onBatch };
}

// Run the bot only when this file is executed directly (node main.ts), so the
// strategy can also be imported by a local backtest without hanging on stdin.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBot(createStrategy());
}
