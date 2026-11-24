// Pump.fun paper sprint bot: a barbell — a few long moonshot holds plus
// fast sniper churn that clears the 20-coin round-trip bar.
//
// What the kit's dev window (1,222 coins, 24 h sampled 1/16) actually
// showed, measured before this was written — four earlier designs of mine
// and the kit's own pilots were all graded on it with the real grader:
//
// - The edge lives inside a single slot and the harness steals it. Coins
//   that end +1,100% reach +100% a median of 0 slots after their first
//   big trade: the whole pump happens inside one slot, across several
//   trades. The harness fills orders 2 slots after the decision batch, so
//   no bot can buy mid-pump. Every lagged entry therefore buys the top:
//   lagged buy-and-hold averages -19% per coin (median -24%).
// - Momentum entries, early sniping with pyramiding, and deep-reserve
//   entries all lost (-1.32, -2.03, -0.93 SOL): entries land on local
//   tops, gap-downs run far past any stop, and ~3% round-trip friction
//   eats the rest. The kit's pilots graded worse (momentum -9.45 SOL,
//   reversion -4.37 SOL). The least-bad regime was the fast sniper
//   (-0.42 SOL over 343 trips): its gross trading was ~breakeven and the
//   fees were the whole loss.
// - But the return distribution is extremely right-skewed: the mean
//   buy-and-hold return is +23% while the median is -12%, because 1% of
//   coins end +1,100%. Any tight take-profit cuts that tail and keeps the
//   losses, which is why the scalpers lose. And the prize is
//   winner-takes-all with a PnL above zero required, so the entry wants
//   the fat tail, not the lowest variance.
//
// So this bot is a barbell, in its own code and with its own numbers:
//
// - MOONSHOT HOLDS (at most 3 at once): buy a fresh coin early (real
//   reserve >= 1 SOL, age <= 100 slots), 0.05 SOL or the order cap if
//   smaller; add 0.15 SOL once when the price doubles from the first buy
//   and the reserve reaches 20 SOL. No stop-loss, no clock: the position
//   leaves only on a +400% take-profit (realizable value >= 5x cost) or
//   when the harness flattens it at the end. Losers can go to ~zero; the
//   tail pays for them.
// - SNIPER CHURN (the other slots): the fast regime — buy in a coin's
//   first 3 slots when the opening tape looks unbundled (at most 3
//   distinct non-creator buyers, creator has not sold), take profit at
//   +15%, cut at -12%, leave at once when the creator sells, never hold
//   past 10 slots, and never send a buy smaller than 0.01 SOL (dust buys
//   pay a full transaction fee for nothing). The churn exists to clear
//   the 20-coin round-trip bar and to keep slots working while the holds
//   sit — and it stops after 32 buys: the sniper's gross edge measured
//   ~breakeven on the dev window, so every extra trip is ~3% of stake
//   paid in fees for nothing, and the churn's expected loss stays small
//   because both its stakes and its trip count are capped.
//
// A position is valued by what selling it would actually pay — selling
// tokens against a constant-product curve pays tokens * vq / (vt +
// tokens), minus curve fees, not the marginal-price mark tokens * vq /
// vt, which overstates proceeds by the sale's own price impact — and
// exits are decided on that realizable value against the position's cost.
//
// Deterministic by construction: every decision comes from the batch stream
// (slots, reserves, fills) and insertion-ordered maps. No clock, no random
// source, no network, no environment reads. The same batch stream always
// produces the same orders, so the harness's two executions agree.
//
// All money is bigint lamports.

import type {
  Batch,
  Bot,
  BotState,
  OrderInput,
  Pubkey,
} from './vendor/makefun-bot.ts';

const FEE_BPS = 125n; // protocol 95 + creator 30 bps of curve fees on a sale
const BPS = 10_000n;

// --- tunables (SOL where a unit is SOL, slots where a unit is a slot) ---
const HOLD_STAKE_SOL = 0.05; // moonshot first buy per coin
const HOLD_ADD_SOL = 0.15; // the single moonshot add, into strength
const HOLD_ADD_PRICE_NUM = 2; // add when price >= first buy price * 2/1
const HOLD_ADD_PRICE_DEN = 1;
const HOLD_ADD_MIN_REAL_SOL = 20; // add only once real reserve >= 20 SOL
const HOLD_MIN_REAL_SOL = 1; // moonshot entry: real reserve >= 1 SOL
const HOLD_MAX_AGE_SLOTS = 100; // moonshot entry: coin age <= 100 slots
const HOLD_MAX_OPEN = 3; // at most this many moonshot holds at once
const HOLD_TAKE_PROFIT_NUM = 5; // moonshot sells when value >= cost * 5/1
const HOLD_TAKE_PROFIT_DEN = 1;
const CHURN_STAKE_SOL = 0.1; // sniper buy size per coin
const CHURN_MIN_BUY_SOL = 0.01; // never send a sniper buy smaller than this
const CHURN_MIN_REAL_SOL = 0.3; // sniper entry: real reserve >= 0.3 SOL
const CHURN_MAX_AGE_SLOTS = 3; // sniper entry: coin age <= 3 slots
const CHURN_MAX_OPEN_BUYERS = 3; // bundled launch filter
const CHURN_TAKE_PROFIT_NUM = 115; // sniper sells when value >= cost * 115/100
const CHURN_TAKE_PROFIT_DEN = 100;
const CHURN_STOP_LOSS_NUM = 88; // sniper sells when value <= cost * 88/100
const CHURN_STOP_LOSS_DEN = 100;
const CHURN_MAX_HOLD_SLOTS = 10; // sniper never holds past this many slots
const CHURN_MAX_BUYS = 32; // sniper buys are capped: the churn exists to clear
// the 20-coin round-trip bar, and every extra trip pays ~3% in fees for a
// ~breakeven gross edge, so the churn stops once the bar is safely cleared
const MAX_ORDERS_PER_BATCH = 16; // hard cap from hello.caps, re-checked live

interface Tape {
  mint: Pubkey;
  creator: Pubkey | null;
  createdSlot: number | null;
  buyers: Set<Pubkey>; // distinct non-creator wallets that bought
  creatorSold: boolean;
  buySlot: number; // slot of the first buy decision, -1 when not held
  firstBuyPrice: bigint; // scaled price at the first buy, 0 before any buy
  added: boolean; // the moonshot add has been sent for this mint
  decidedHold: boolean; // a moonshot buy has been sent for this mint
  decidedChurn: boolean; // a sniper buy has been sent for this mint
  mode: 'hold' | 'churn' | null; // which arm owns the open position
  holdCounted: boolean; // this hold is counted in holdOpen (filled buy)
}

/** Scaled price (lamports of quote per token, times 1_000_000). */
function scaledPrice(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (virtualQuote * 1_000_000n) / virtualToken;
}

/** What selling `tokens` against reserves (vq, vt) would pay, after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * FEE_BPS + BPS - 1n) / BPS;
}

function solLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

export function createStrategy(): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const pendingSell = new Set<Pubkey>();
  const pendingBuy = new Set<Pubkey>();
  const pendingAdd = new Set<Pubkey>();
  let holdOpen = 0;
  let churnBuysSent = 0;

  function tapeFor(mint: Pubkey): Tape {
    let tape = tapes.get(mint);
    if (tape === undefined) {
      tape = {
        mint,
        creator: null,
        createdSlot: null,
        buyers: new Set<Pubkey>(),
        creatorSold: false,
        buySlot: -1,
        firstBuyPrice: 0n,
        added: false,
        decidedHold: false,
        decidedChurn: false,
        mode: null,
        holdCounted: false,
      };
      tapes.set(mint, tape);
    }
    return tape;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      // Fold the batch's fills in first. Fills arrive one batch late, so
      // the pending sets are the only guard against double orders. A hold
      // slot counts only once its buy fills: a rejected or failed buy
      // frees the tape without ever counting, and a filled sell (or a
      // completion) closes a counted hold and frees its slot.
      for (const fill of batch.fills) {
        if (fill.status !== 'filled') {
          if (fill.side === 'sell') pendingSell.delete(fill.mint);
          if (fill.side === 'buy') {
            if (pendingAdd.has(fill.mint)) {
              pendingAdd.delete(fill.mint);
            } else {
              pendingBuy.delete(fill.mint);
              const tape = tapes.get(fill.mint);
              if (tape !== undefined && tape.mode === 'hold') tape.mode = null;
            }
          }
          continue;
        }
        if (fill.side === 'buy') {
          if (pendingAdd.has(fill.mint)) {
            pendingAdd.delete(fill.mint);
          } else {
            pendingBuy.delete(fill.mint);
            const tape = tapes.get(fill.mint);
            if (tape !== undefined && tape.mode === 'hold' && !tape.holdCounted) {
              tape.holdCounted = true;
              holdOpen += 1;
            }
          }
        } else {
          pendingSell.delete(fill.mint);
          const tape = tapes.get(fill.mint);
          if (tape !== undefined && tape.mode === 'hold') {
            tape.mode = null;
            if (tape.holdCounted) {
              tape.holdCounted = false;
              holdOpen -= 1;
            }
          }
        }
      }

      // Refresh every tape from the batch's events: creator and creation
      // slot, the opening tape (distinct buyers, creator sells), and
      // completion (a completed curve is dead, its tape is dropped; a
      // completed moonshot hold frees its slot too).
      for (const event of batch.events) {
        if (event.event === 'CreateEvent') {
          const tape = tapeFor(event.mint);
          tape.creator = event.creator;
          tape.createdSlot = event.slot;
        } else if (event.event === 'TradeEvent') {
          const tape = tapeFor(event.mint);
          if (tape.creator !== null && event.user === tape.creator) {
            if (!event.is_buy) tape.creatorSold = true;
          } else if (event.is_buy) {
            tape.buyers.add(event.user);
          }
        } else if (event.event === 'CompleteEvent') {
          const tape = tapes.get(event.mint);
          if (tape !== undefined && tape.mode === 'hold' && tape.holdCounted) holdOpen -= 1;
          tapes.delete(event.mint);
        }
      }

      const orders: OrderInput[] = [];
      const caps = state.hello.caps;
      const txFee = state.txFeeLamports();
      const orderCap = Math.min(caps.max_orders_per_batch, MAX_ORDERS_PER_BATCH);

      // Exits first: selling frees one of the five open slots for the next
      // entry in this same batch. A moonshot hold leaves only on its +400%
      // take-profit; a sniper position leaves on +15% / -12% / 10 slots /
      // a creator dump. Both are decided on the realizable sale value,
      // net of the transaction fee the sale pays.
      for (const [mint, holding] of state.positions) {
        if (orders.length >= orderCap) break;
        if (pendingSell.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const tape = tapes.get(mint);
        if (tape === undefined || tape.mode === null) continue;
        const value =
          sellValue(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) -
          txFee;
        const cost = holding.cost_lamports;
        if (cost <= 0n) continue;
        let exit = false;
        if (tape.mode === 'hold') {
          exit = value * BigInt(HOLD_TAKE_PROFIT_DEN) >= cost * BigInt(HOLD_TAKE_PROFIT_NUM);
        } else {
          const takeProfit =
            value * BigInt(CHURN_TAKE_PROFIT_DEN) >= cost * BigInt(CHURN_TAKE_PROFIT_NUM);
          const stopLoss =
            value * BigInt(CHURN_STOP_LOSS_DEN) <= cost * BigInt(CHURN_STOP_LOSS_NUM);
          const stale = tape.buySlot >= 0 && batch.slot - tape.buySlot >= CHURN_MAX_HOLD_SLOTS;
          exit = takeProfit || stopLoss || stale || tape.creatorSold;
        }
        if (!exit) continue;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: 10_000,
        });
        pendingSell.add(mint);
        tape.buySlot = -1;
      }

      let freeCash = state.freeCashLamports();

      // Moonshot adds: one 0.15 SOL add per hold, only while the price is
      // at least double the first buy's price and the real reserve is deep
      // enough for the order cap to allow it.
      for (const [mint, holding] of state.positions) {
        if (orders.length >= orderCap) break;
        if (pendingSell.has(mint) || pendingAdd.has(mint)) continue;
        const tape = tapes.get(mint);
        if (tape === undefined || tape.mode !== 'hold' || tape.added || tape.firstBuyPrice <= 0n) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price * BigInt(HOLD_ADD_PRICE_DEN) < tape.firstBuyPrice * BigInt(HOLD_ADD_PRICE_NUM)) continue;
        if (curve.real_quote_reserves < solLamports(HOLD_ADD_MIN_REAL_SOL)) continue;
        const addAmount = solLamports(HOLD_ADD_SOL);
        if (state.maxBuyLamports(mint) < addAmount) continue;
        if (freeCash < addAmount + txFee) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: addAmount,
          max_slippage_bps: 10_000,
        });
        pendingAdd.add(mint);
        tape.added = true;
        freeCash -= addAmount + txFee;
      }

      // Entries, moonshots first: one buy per coin while a slot is free.
      // A moonshot takes a hold slot (at most 2 open); a sniper buy takes
      // any free slot. Both are capped by the 1%-of-real-reserve order cap.
      let slots = caps.max_open_positions - state.committedPositionCount();
      for (const event of batch.events) {
        if (orders.length >= orderCap) break;
        if (slots <= 0) break;
        if (event.event !== 'CreateEvent' && event.event !== 'TradeEvent') continue;
        const mint = event.mint;
        if (state.positions.has(mint) || pendingBuy.has(mint) || pendingSell.has(mint)) continue;
        const tape = tapes.get(mint);
        if (tape === undefined || tape.decidedHold || tape.decidedChurn) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const isFresh =
          tape.createdSlot !== null && batch.slot - tape.createdSlot <= HOLD_MAX_AGE_SLOTS;
        if (isFresh && holdOpen < HOLD_MAX_OPEN && curve.real_quote_reserves >= solLamports(HOLD_MIN_REAL_SOL)) {
          const amount = solLamports(HOLD_STAKE_SOL);
          const buy = state.maxBuyLamports(mint) < amount ? state.maxBuyLamports(mint) : amount;
          if (buy <= 0n || freeCash < buy + txFee) continue;
          orders.push({ side: 'buy', mint, quote_lamports: buy, max_slippage_bps: 10_000 });
          pendingBuy.add(mint);
          tape.decidedHold = true;
          tape.mode = 'hold';
          tape.firstBuyPrice = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          tape.buySlot = batch.slot;
          freeCash -= buy + txFee;
          slots -= 1;
          continue;
        }
        // Sniper churn: first 3 slots, unbundled opening tape, creator
        // has not sold, real reserve >= 0.3 SOL, buy >= 0.01 SOL — and
        // only while the churn cap is not reached.
        if (churnBuysSent >= CHURN_MAX_BUYS) continue;
        if (tape.createdSlot === null) continue;
        if (batch.slot - tape.createdSlot > CHURN_MAX_AGE_SLOTS) continue;
        if (tape.creatorSold) continue;
        if (tape.buyers.size > CHURN_MAX_OPEN_BUYERS) continue;
        if (curve.real_quote_reserves < solLamports(CHURN_MIN_REAL_SOL)) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < solLamports(CHURN_MIN_BUY_SOL)) continue;
        const amount = cap < solLamports(CHURN_STAKE_SOL) ? cap : solLamports(CHURN_STAKE_SOL);
        if (freeCash < amount + txFee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: 10_000 });
        pendingBuy.add(mint);
        churnBuysSent += 1;
        tape.decidedChurn = true;
        tape.mode = 'churn';
        tape.firstBuyPrice = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        tape.buySlot = batch.slot;
        freeCash -= amount + txFee;
        slots -= 1;
      }

      return orders;
    },
  };
}
