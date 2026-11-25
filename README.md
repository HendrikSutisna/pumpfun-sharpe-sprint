# Pump.fun Sharpe Sprint Bot

A deterministic paper-trading bot for pump.fun replay, tuned for the **hourly
Sharpe ratio** — not net PnL. Launch-surge sniper: buys only coins with ≥5 SOL
net buys and ≥8 distinct buyers in the create slot, stake min(0.5 SOL, 1% of
real reserve), sells all at +20%, cuts fast at −5%, exits after 300 slots if
it never pops. The tight stop keeps losing hours small and the +20% cap keeps
no single hour dominating the hourly returns. 10 SOL paper capital, no real
money. A probe fallback keeps the 20-coin guardrail on pace over the 6-hour
final window.

Dev window (official grade-local): hourly Sharpe 0.57, net +0.83 SOL,
49 coins, max drawdown 0.9%; on four 6-hour slices Sharpe 0.24 / 0.73 /
0.71 / 0.42, every slice PnL-positive with ≥22 coins.

## make.fun

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/HendrikSutisna/pumpfun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/HendrikSutisna/pumpfun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Entry for the [make.fun bounty](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).
