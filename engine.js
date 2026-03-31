/* ===============================================
RAX ENGINE - engine.js
Market simulation: tiers, inflation model, events, state
=============================================== */

// ── Rarity Tiers ────────────────────────────────────────────────────────

const TIERS = [
    { code: 'CM', name: 'Common', dropRate: 0.600, basePrice: 10, color: '#9CA3AF', maxSupply: null }, { code: 'UC', name: 'Uncommon', dropRate: 0.250, basePrice: 50, color: '#22C55E', maxSuplly: null }, { code: 'RR', name: 'Rare', dropRate: 0.100, basePrice: 250, color: '#3B82F6', maxSupply: null }, { code: 'EP', name: 'Epic', dropRate: 0.040, basePrice: 1500, color: '#A855F7', maxSupply: 10000 }, { code: 'LG', name: 'Legendary', dropRate: 0.009, basePrice: 10000, color: '#F59E0B', maxSupply: 1000 }, { code: 'MK', name: 'Mythic', dropRate: 0.000, basePrice: 100000, color: '#EF4444', maxSupply: 100 }
];