/* ============================================================
   RAX EXCHANGE — engine.js
   Market simulation: tiers, inflation model, events, state
   ============================================================ */

// ── Rarity Tiers ────────────────────────────────────────────

const TIERS = [
  { code: 'CM', name: 'Common',    dropRate: 0.600, basePrice: 10,      color: '#9CA3AF', maxSupply: null  },
  { code: 'UC', name: 'Uncommon',  dropRate: 0.250, basePrice: 50,      color: '#22C55E', maxSupply: null  },
  { code: 'RR', name: 'Rare',      dropRate: 0.100, basePrice: 250,     color: '#3B82F6', maxSupply: null  },
  { code: 'EP', name: 'Epic',      dropRate: 0.040, basePrice: 1500,    color: '#A855F7', maxSupply: 10000 },
  { code: 'LG', name: 'Legendary', dropRate: 0.009, basePrice: 10000,   color: '#F59E0B', maxSupply: 1000  },
  { code: 'MK', name: 'Mythic',    dropRate: 0.001, basePrice: 100000,  color: '#EF4444', maxSupply: 100   },
];

// ── Item Definitions ─────────────────────────────────────────

const ITEM_DEFS = [
  { id: 'i1', name: 'Iron Sword',      tierIdx: 0 },
  { id: 'i2', name: 'Silver Shield',   tierIdx: 1 },
  { id: 'i3', name: 'Crystal Wand',    tierIdx: 2 },
  { id: 'i4', name: 'Dragon Scale',    tierIdx: 3 },
  { id: 'i5', name: 'Phoenix Feather', tierIdx: 4 },
  { id: 'i6', name: 'Cosmic Fragment', tierIdx: 5 },
];

// ── Market Events ────────────────────────────────────────────

const EVENTS_LIST = [
  { name: '⚡ Flash Sale',    effect: 'volume_spike',  mag:  3.0,  dur: 30 },
  { name: '🐋 Whale Buy',     effect: 'price_spike',   mag:  0.12, dur:  5 },
  { name: '📦 Mass Listing',  effect: 'supply_flood',  mag:  4.0,  dur: 45 },
  { name: '🎲 Rarity Boost',  effect: 'drop_boost',    mag:  2.0,  dur: 60 },
  { name: '💥 Market Panic',  effect: 'price_crash',   mag: -0.18, dur: 30 },
  { name: '🚀 FOMO Rally',    effect: 'user_surge',    mag:  3.5,  dur: 60 },
  { name: '🔥 Supply Burn',   effect: 'supply_reduce', mag:  0.1,  dur:  5 },
];

// ── Global State ─────────────────────────────────────────────

const state = {
  items: ITEM_DEFS.map(def => {
    const tier = TIERS[def.tierIdx];
    return {
      ...def,
      tier,
      price:         tier.basePrice * (0.8 + Math.random() * 0.4),
      priceHistory:  [],
      candles:       [],
      volume24h:     0,
      high24h:       0,
      low24h:        Infinity,
      change24h:     0,
      listedSupply:  Math.floor(Math.random() * 20) + 2,
      totalSupply:   Math.floor(Math.random() * 400) + 100,
      txHistory:     [],
    };
  }),
  selectedIdx:  4,   // Phoenix Feather by default
  activeEvents: [],
  totalTrades:  0,
  totalVolume:  0,
  globalUsers:  150,
  tick:         0,
  tradeLog:     [],
};

// ── Synthetic Candle Generator ───────────────────────────────

/**
 * Generates N synthetic candles using Geometric Brownian Motion.
 * Used to populate price history on startup.
 */
function genSyntheticCandles(basePrice, n = 60) {
  const candles = [];
  let p = basePrice * (0.5 + Math.random() * 0.5);
  const now = Date.now() / 1000;

  for (let i = 0; i < n; i++) {
    const t     = now - (n - i) * 60;
    const drift = (Math.random() - 0.48) * 0.04;
    const open  = p;
    const close = p * Math.exp(drift);
    const high  = Math.max(open, close) * (1 + Math.random() * 0.015);
    const low   = Math.min(open, close) * (1 - Math.random() * 0.015);
    const vol   = Math.random() * basePrice * 3;

    candles.push({ t, o: open, h: high, l: low, c: close, v: vol });
    p = close;
  }
  return candles;
}

// Initialize every item with synthetic candle history
state.items.forEach(item => {
  item.candles   = genSyntheticCandles(item.price);
  item.price     = item.candles.at(-1).c;
  item.high24h   = Math.max(...item.candles.map(c => c.h));
  item.low24h    = Math.min(...item.candles.map(c => c.l));
  item.volume24h = item.candles.reduce((s, c) => s + c.v, 0);
});

// ── Inflation Engine ─────────────────────────────────────────

/**
 * Calculates a new price for an item based on six market factors:
 *   1. Mean reversion     — pulls price back toward base price
 *   2. Volume pressure    — more transactions → upward push
 *   3. User pressure      — more active users → more demand
 *   4. Scarcity           — low listed supply relative to demand → price spike
 *   5. Momentum           — recent price trend carries forward
 *   6. Stochastic noise   — GBM volatility (higher for rarer items)
 */
function calcNewPrice(item, txVol, activeUsers, listedSupply) {
  const P  = item.price;
  const P0 = item.tier.basePrice;

  // 1. Mean reversion
  const meanRev = 0.018 * (P0 - P) / P0;

  // 2. Volume pressure (log-scaled)
  const avgVol     = item.txHistory.length
    ? item.txHistory.reduce((a, b) => a + b, 0) / item.txHistory.length
    : txVol;
  const volPressure = 0.001 * Math.log1p(txVol / (avgVol + 1));

  // 3. User pressure (log-scaled, baseline = 100 users)
  const userPressure = 0.004 * Math.log1p(activeUsers / 100);

  // 4. Scarcity (amplified for supply-capped items)
  const supplyRatio  = listedSupply / Math.max(1, item.totalSupply);
  const demandRatio  = activeUsers  / Math.max(1, listedSupply * 10);
  let scarcity       = 2.0 * (1 - supplyRatio) * Math.log1p(demandRatio);

  if (item.tier.maxSupply) {
    const capRatio = Math.min(1, (item.candles.length * 0.01) / item.tier.maxSupply);
    scarcity      *= (1 + capRatio * capRatio * 3);
  }

  // 5. Momentum (last 5 candles, 25% carry-over)
  let momentum = 0;
  const hist   = item.candles.slice(-5);
  if (hist.length >= 3) {
    const returns = hist.slice(1).map((c, i) => (c.c - hist[i].c) / hist[i].c);
    momentum      = returns.reduce((a, b) => a + b, 0) / returns.length * 0.25;
  }

  // 6. Stochastic noise — volatility by rarity tier
  const VOL_BY_TIER = { CM: 0.012, UC: 0.015, RR: 0.020, EP: 0.028, LG: 0.040, MK: 0.060 };
  const sigma       = VOL_BY_TIER[item.tier.code] ?? 0.02;
  const noise       = (Math.random() - 0.5) * 2 * sigma;

  // Combine all factors (circuit breaker: max ±15% per tick)
  let logReturn = meanRev + volPressure + userPressure + scarcity + momentum + noise;
  logReturn     = Math.max(-0.15, Math.min(0.15, logReturn));

  // Price floor: 1% of base price
  return Math.max(P0 * 0.01, P * Math.exp(logReturn));
}

// ── Market Events ────────────────────────────────────────────

/** 8% chance per tick of triggering a random market event. */
function maybeTriggerEvent() {
  if (Math.random() > 0.08) return null;

  const ev       = { ...EVENTS_LIST[Math.floor(Math.random() * EVENTS_LIST.length)] };
  ev.expiresAt   = Date.now() + ev.dur * 1000;
  state.activeEvents.push(ev);
  return ev;
}

/** Returns currently active events, pruning expired ones. */
function getActiveEvents() {
  const now      = Date.now();
  state.activeEvents = state.activeEvents.filter(e => e.expiresAt > now);
  return state.activeEvents;
}

/**
 * Applies any active event modifiers to the tick's base parameters.
 * @param {object} params - { vol, users, supply }
 * @returns {object} Modified params
 */
function applyEvents(params) {
  const events = getActiveEvents();
  let { vol, users, supply } = params;

  for (const ev of events) {
    if (ev.effect === 'volume_spike') vol    *= ev.mag;
    if (ev.effect === 'user_surge')   users   = Math.floor(users * ev.mag);
    if (ev.effect === 'supply_flood') supply  = Math.floor(supply * ev.mag);
    if (ev.effect === 'price_crash')  { vol  *= 0.1; supply *= 3; }
  }

  return { vol, users, supply };
}

// ── Main Tick ────────────────────────────────────────────────

/**
 * Advances the simulation by one step.
 * Updates prices, candles, trade log, and global stats.
 * @returns {object|null} Triggered event, if any
 */
function tick() {
  state.tick++;
  state.globalUsers = Math.max(10, state.globalUsers + (Math.random() - 0.5) * 15);

  const triggeredEvent = maybeTriggerEvent();

  state.items.forEach(item => {
    const baseTxVol = Math.random() * 3 * item.tier.basePrice;
    const params    = applyEvents({
      vol:    baseTxVol,
      users:  Math.floor(state.globalUsers + Math.random() * 30 - 15),
      supply: item.listedSupply,
    });

    const newPrice  = calcNewPrice(item, params.vol, params.users, params.supply);
    const prevPrice = item.price;
    item.price      = newPrice;

    // Update or create the current-minute candle
    const nowSec    = Math.floor(Date.now() / 1000);
    const candleTs  = Math.floor(nowSec / 60) * 60;
    const lastCandle = item.candles.at(-1);

    if (lastCandle && lastCandle.t === candleTs) {
      lastCandle.h   = Math.max(lastCandle.h, newPrice);
      lastCandle.l   = Math.min(lastCandle.l, newPrice);
      lastCandle.c   = newPrice;
      lastCandle.v  += params.vol;
    } else {
      item.candles.push({
        t: candleTs,
        o: prevPrice,
        h: Math.max(prevPrice, newPrice),
        l: Math.min(prevPrice, newPrice),
        c: newPrice,
        v: params.vol,
      });
      if (item.candles.length > 200) item.candles.shift();
    }

    // Update 24h stats
    item.volume24h  += params.vol;
    item.high24h     = Math.max(item.high24h, newPrice);
    item.low24h      = Math.min(item.low24h,  newPrice);
    item.change24h   = ((newPrice - item.candles[0].o) / item.candles[0].o) * 100;

    // Rolling transaction volume history (last 60 ticks)
    item.txHistory.push(params.vol);
    if (item.txHistory.length > 60) item.txHistory.shift();

    // Randomly fluctuate listed supply
    if (Math.random() < 0.15) {
      item.listedSupply = Math.max(1, item.listedSupply + Math.floor(Math.random() * 5) - 2);
    }

    // Append to trade log
    const side = Math.random() < 0.5 ? 'buy' : 'sell';
    const qty  = Math.floor(Math.random() * 5) + 1;

    state.tradeLog.unshift({
      time:     new Date().toTimeString().slice(0, 8),
      itemName: item.name,
      side,
      price:    newPrice,
      qty,
      total:    newPrice * qty,
    });

    state.totalTrades++;
    state.totalVolume += params.vol;
  });

  if (state.tradeLog.length > 100) state.tradeLog.length = 100;

  return triggeredEvent;
}

// ── Auto-Reset (cada 60 minutos) ─────────────────────────────

const RESET_INTERVAL_MS = 60 * 60 * 1000; // 60 minutos

/**
 * Resetea el trade feed, usuarios activos, volumen global
 * y eventos activos. Los precios y candles no se tocan.
 */
function resetMarketSession() {
  state.tradeLog     = [];
  state.totalTrades  = 0;
  state.totalVolume  = 0;
  state.globalUsers  = 150;
  state.activeEvents = [];

  state.items.forEach(item => {
    item.volume24h = 0;
    item.high24h   = item.price;
    item.low24h    = item.price;
    item.change24h = 0;
    item.txHistory = [];
  });
}