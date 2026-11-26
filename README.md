# Pump.fun Sharpe Sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/HendrikSutisna/pumpfun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/HendrikSutisna/pumpfun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

An entry for the [Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) on make.fun: a paper-trading bot on a pump.fun replay, ranked by hourly Sharpe ratio over a 6-hour final window. The whole entry is one file, `main.ts`, run by the kit harness under Node 22.

## How it trades

A coin's fate is mostly written in its opening slot, so the bot only buys hot launches: at least 5 SOL of net buys from at least 8 distinct buyers in the creation slot, at least 2 trades, and a creator who has not sold. It buys once, 0.5 SOL, within a slot of creation, then sells everything at +20% over its all-in cost, cuts everything at −5%, or exits after 300 slots if the coin never moves. Positions are capped at 5 open at a time.

Because the final window is short, the bot also keeps a drip of tiny 0.01 SOL probe round trips going, paced toward 22 coins over 6 hours, so the guardrail (at least 20 distinct coins with round trips of at least 0.01 SOL) is always met. A curve that already finished one probe round trip is never probed again — repeat probes only burn fees.

## Tuned settings

- Entry: age 0–1 slots, opening net buys ≥ 5 SOL, opening buyers ≥ 8, opening trades ≥ 2, skip creator-sold launches
- Stake: 0.5 SOL per coin, one buy, no adds
- Exit: take profit +20% (sell all), stop loss −5%, max hold 300 slots
- Pacing: 22 coins / 240 fills over 6 hours, probes of 0.01 SOL, at most 1 probe buy in flight

## Verified locally

`node kit/cli/makefun.mjs grade-local --kit kit --bot entry --driver process --worktree`

- Status: finished
- Net PnL: +0.83666681 SOL
- Hourly Sharpe: 0.574904193
- Fills: 113, across 57 coins
- Max drawdown: 0.846%
- Determinism: reproduced on regrade (L1)

The bot is fully deterministic: no clock, no randomness, no I/O, no network. Every decision is a pure function of the replayed batches and the account the harness reports.

## Layout

- `main.ts` — the whole strategy
- `vendor/makefun-bot.ts` — the kit SDK (unmodified)
- `.makefun/owner.json` — payout wallet for the entry
- `LICENSE` — MIT
