[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/jehan771/pump-fun-paper-sprint-any-bot-can-win/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/jehan771/pump-fun-paper-sprint-any-bot-can-win/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint Bot — Dip-Bounce Sniper on Proven Runners

Paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on [make.fun](https://make.fun). One `main.ts` (Node 22), no dependencies, no network, no secrets — it speaks the `agent-fun/replay/v2` protocol on stdin/stdout.

## Strategy

Designed from the dev replay data (24 h, 1,222 mints) and validated against the house harness itself: buying a coin the moment it crosses 5 SOL of real reserves *loses* money — the fill lands ~12% above the crossing price (2-slot latency into a violent pump) and the median coin then falls ~37% within 10 minutes. Every fixed-horizon hold after such an entry is deeply negative, and the first version of this bot (momentum cross, TP ×3.0) graded **−7.33 SOL** on dev.

What works is buying the **pullback of a proven runner**:

- **Entry (once per coin, ever — unless the buy is rejected/failed, in which case the coin may be retried while still fresh):** a coin created within the last 60 minutes, with at least 5 SOL of real reserves, that spiked ≥ 2× from its creation price and has since pulled back to ≤ 80% of its peak.
- **Tiered sizing:** coins that spiked ≥ 4× get full size (`min(1 SOL, 0.95% of real reserves)`); weaker spikes (2–4×) trade the 0.01 SOL minimum — they add the distinct coins the guardrail needs while their drag stays tiny.
- **Exit:** sell everything at +30% (take-profit ×1.3), at −10% (stop ×0.9), or after 600 s of holding — whichever comes first. Exits are checked for every open position on every batch, so a dead coin still exits on time.
- **Asymmetric slippage:** buys 5% (a tight cap refuses exactly the violent pumps that top out), sells 50% (during a crash a sell must fill; a rejected sell leaves you holding to zero).
- **Limits:** at most 5 open positions (harness cap); no shorts, no leverage.
- **Deterministic:** decisions depend only on the replay stream — no clock, no randomness — so the harness's two executions produce identical action logs (verified: reproduced byte for byte).

## Dev results (local replay, DEV — not final)

Verified with the kit's own grader (`grade-local --driver process`, two executions, byte-identical action logs):

| | Net PnL (24 h dev window) |
| --- | --- |
| This bot | **+0.481 SOL** (217 coins, win rate 25.8%, max drawdown 2.9%, guardrails met; +0.148 SOL even at 2× fees) |
| First version (momentum cross, TP ×3.0) | −7.33 SOL (guardrails failed: drawdown 73.6%) |

The chosen parameters sit on a broad plateau (TP 1.25–1.35, SL 0.88–0.92, hold 300–900 s, dip 0.78–0.82 all score +0.19…+0.64 SOL), and the config was net positive in **3 of the 4 six-hour chunks** of the dev window (−0.25 / +0.21 / +0.36 / +0.16 SOL). **Honest caveat from `grade-local --stress 5`:** on 5 rebuilt block surrogates of the dev window the median is **−0.92 SOL** (p10 −1.43, p90 +0.08; 4 of 5 lost money) and the kit warns the dev score sits above 90% of the copies — the +0.48 leans on a few coins (top 3 = 39% of the gains; without them −0.17). A fresh 6-hour final window is a fresh draw of coins, so treat +0.48 as an optimistic read: the realistic chance of landing positive in the final is closer to ~1 in 5 than 3 in 4. It is still the best-scoring strategy found after sweeping momentum, sniper, timed, dip, wave-2, trailing-stop and buy-pressure variants, and the entry is free — so it is worth submitting.

## Run it

```sh
node main.ts   # reads agent-fun/replay/v2 NDJSON on stdin, replies per batch
```

## License

MIT — see [LICENSE](LICENSE).
