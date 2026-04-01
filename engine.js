/* ===============================================
RAX ENGINE - engine.js
Market simulation: tiers, inflation model, events, state
=============================================== */

const { act } = require("react");

// ── Rarity Tiers ────────────────────────────────────────────────────────

const TIERS = [
    { code: 'CM', name: 'Common', dropRate: 0.600, basePrice: 10, color: '#9CA3AF', maxSupply: null }, 
    { code: 'UC', name: 'Uncommon', dropRate: 0.250, basePrice: 50, color: '#22C55E', maxSuplly: null }, 
    { code: 'RR', name: 'Rare', dropRate: 0.100, basePrice: 250, color: '#3B82F6', maxSupply: null }, 
    { code: 'EP', name: 'Epic', dropRate: 0.040, basePrice: 1500, color: '#A855F7', maxSupply: 10000 }, 
    { code: 'LG', name: 'Legendary', dropRate: 0.009, basePrice: 10000, color: '#F59E0B', maxSupply: 1000 }, 
    { code: 'MK', name: 'Mythic', dropRate: 0.000, basePrice: 100000, color: '#EF4444', maxSupply: 100 }
];

// ── Item Definitions ────────────────────────────────────────────────────────

const ITEM_DEFS = [
    { id: 'i1', name: 'Iron Sword', tierIdx: 0 }, 
    { id: 'i2', name: 'Silver Shield', tierIdx: 1},
    { id: 'i3', name: 'Crystal Wand', tierIdx: 2},
    { id: 'i4', name: 'Dragon Scale', tierIdx: 3},
    { id: 'i5', name: 'Phoenix Feather', tierIdx: 4},
    { id: 'i6', name: 'Cosmic Fragment', tierIdx: 5}
];

// ── Market Events ────────────────────────────────────────────────────────

const EVENTS_LIST = [
    { name: '⚡ Flash Sale', effect: 'volume_spike', mag: 3.0, dur: 30 },
    { name: '🐋 Whale Buy', effect: 'price_spike', mag: 0.12, dur: 5 },
    { name: '📦 Mass Listing', effect: 'supply_flood', mag: 4.0, dur: 45 },
    { name: '🎲 Rarity Boost', effect: 'drop_boost', mag: 2.0, dur: 60 },
    { name: '💥 Market Panic', effect: 'price_crash', mag: -0.18, dur: 30 },
    { name: '🚀 FOMO Rally', effect: 'user_surge', mag: 3.5, dur: 60 },
    { name: '🔥 Supply Burn', effect: 'supply_reduce', mag: 0.1, dur: 5},
];

// ── Global State ────────────────────────────────────────────────────────

const state = {
    items: ITEM_DEFS.map(def => {
        const tier = TIERS[def.tierIdx];
        return {
            ...def,
            tier,
            price: tier.basePrice * (0.8 + Math.random() * 0.4),
            priceHistory: [],
            candles: [],
            volume24h: 0,
            high24h: 0,
            low24h: Infinity,
            change24h: 0,
            listedSupply: Math.floor(Math.random() * 20) + 2,
            totalSupply: Math.floor(Math.random() * 400) + 100,
            txHistory: [],
        };
    }),
    selectedIdx: 4, // Phoenix Feather by default
    activeEvents: [],
    totalTrades: 0,
    totalVolume: 0,
    globalUsers: 150,
    tick: 0,
    tradeLog: [],
};

// ──Synthetic Candle Generator ───────────────────────────────────────────────────────

/**
 * Generates N synthetic candles using Geometric Brownian Motion.
 * Used to populate price history on startup.
 */

function genSyntheticCandles(basePrice, n = 60) {
    const candles = [];
    let p = basePrice * (0.5 + Math.random() * 0.5);
    const now = Date.now() / 1000;

    for (let i = 0; i < n; i++) {
        const t = now - (n - i) * 60; // 1-min intervals
        const drift = (Math.random() - 0.48) * 0.04;
        const open = p;
        const close = p * Math.exp(drift);
        const high = Math.max(open, close) * (1 + Math.random() * 0.015);
        const low = Math.min(open, close) * (1 - Math.random() * 0.015);
        const vol = Math.random() * basePrice * 3;

        candles.push({ t, o: open, h: high, l: low, c: close, v: vol });
        p = close;
    }

    return candles;
}

// Initialize every item with synthetic candle history
state.items.forEach(item => {
    item.candles = genSyntheticCandles(item.price);
    item.price = item.candles.at(-1).c;
    item.high24h = Math.max(...item.candles.map(c => c.h));
    item.low24h = Math.min(...item.candles.map(c => c.l));
    item.volume24h = item.candles.reduce((s, c) => s + c.v, 0);
});

// ── Inflation Engine ────────────────────────────────────────────────────────

/**
 * Calculates a new price for an item based on six market factors:
 *   1. Mean reversion     — pulls price back toward base price
 *   2. Volume pressure    — more transactions → upward push
 *   3. User pressure      — more active users → more demand
 *   4. Scarcity           — low listed supply relative to demand → price spike
 *   5. Momentum           — recent price trend carries forward
 *   6. Stochastic noise   — GBM volatility (higher for rarer items)
 */