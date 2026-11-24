// Pump.fun Paper Sprint entry: one strategy program, main.ts on Node 22.
//
// The strategy lives in strategy.ts (createStrategy): early-momentum buys
// with take-profit / stop-loss / trailing / max-hold exits and a pace
// guardrail that keeps the run above the 20-coin round-trip bar. This file
// only wires it to the replay harness: the harness speaks
// agent-fun/replay/v2 on stdin/stdout, one JSON message per line, and this
// bot answers every batch with its orders for that batch.
//
// Paper trading only: the replay uses market data, never real funds.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
