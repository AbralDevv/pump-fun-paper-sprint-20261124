# Pump.fun Paper Sprint bot

Entry for the make.fun competition "Pump.fun Paper Sprint: Any Bot Can Win"
(`u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`).

## The entry

One strategy program, `main.ts` on Node 22. It paper-trades pump.fun on the
house replay: no real funds, no network, no secrets.

## How it trades

A launch sniper with a rug filter and fast exits:

- **Moonshot holds (at most 3 at once):** a fresh coin is bought early
  (real reserve ≥ 1 SOL, age ≤ 100 slots), 0.05 SOL; one 0.15 SOL add when
  the price doubles from the first buy and the reserve reaches 20 SOL. No
  stop-loss, no clock: the position leaves only on a +400% take-profit
  (realizable value ≥ 5× cost) or when the harness flattens it at the end.
- **Sniper churn (the other slots):** a coin is bought only in its first 3
  slots, only when the opening tape looks unbundled (at most 3 distinct
  non-creator buyers seen, and the creator has not sold). Take-profit
  +15%, stop-loss −12%, leave at once when the creator sells, never hold
  past 10 slots, never send a buy smaller than 0.01 SOL — and the churn
  stops after 32 buys: it exists to clear the 20-coin round-trip bar, and
  its gross edge measured ~breakeven, so extra trips are only fees.
- **Exits** are decided on the realizable sale value — what selling the
  tokens against the constant-product curve would actually pay, net of
  curve fees and the transaction fee — not on the marginal-price mark,
  which overstates proceeds by the sale's own price impact.
- **Deterministic:** every decision comes from the batch stream (slots,
  reserves, fills) and insertion-ordered maps. No clock, no randomness, no
  environment reads — the same batch stream always produces the same
  orders, so the harness's two executions agree byte for byte.

## Why this shape

Three earlier designs and the kit's own pilots were graded on the dev
window first. Momentum entries, early sniping with pyramiding, and
deep-reserve entries all lost between −0.93 and −9.45 SOL: the 2-slot fill
latency lands entries on local tops, gap-downs run far past any stop, and
~3% round-trip friction eats the rest. The least-bad regime on the window
was the fast sniper (the kit's pilot: −0.42 SOL over 343 trips, max
drawdown 4.6%): trade the launch burst, filter the bundled rugs, leave
within slots. This bot follows that regime in its own code and numbers.

## Files

- `main.ts` — entrypoint: wires the strategy to the replay harness.
- `strategy.ts` — the strategy (rug filter, entries, exits).
- `vendor/makefun-bot.ts` — the kit's TypeScript SDK shim, vendored
  byte-identical from `sdk/ts/makefun-bot.ts` as the kit's baselines do.

## Grade locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
