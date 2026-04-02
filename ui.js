/* ============================================================
   RAX EXCHANGE — ui.js
   DOM rendering, formatters, event handlers, and main loop
   Depends on: engine.js (state, tick), chart.js (drawChart)
   ============================================================ */

// ── Formatters ───────────────────────────────────────────────

function formatPrice(p) {
  if (p >= 1000) return '$' + p.toLocaleString('en', { maximumFractionDigits: 0 });
  if (p >= 1)    return '$' + p.toFixed(2);
  return '$' + p.toFixed(4);
}

function formatVolume(v) {
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}

// ── Events Ticker ────────────────────────────────────────────

const tickerEvents = [];

function addTickerEvent(name) {
  tickerEvents.unshift(name);
  if (tickerEvents.length > 5) tickerEvents.pop();

  const el  = document.getElementById('tickerContent');
  el.innerHTML = tickerEvents
    .map((e, i) =>
      `<span class="ticker-event">${e}</span>` +
      (i < tickerEvents.length - 1 ? '<span class="ticker-dot">·</span>' : '')
    )
    .join('');
}

// ── Render: Item List ────────────────────────────────────────

function renderItemList() {
  const list = document.getElementById('itemList');
  list.innerHTML = state.items
    .map((item, i) => {
      const up = item.change24h >= 0;
      return `
        <div class="item-row ${i === state.selectedIdx ? 'active' : ''}"
             onclick="selectItem(${i})">
          <div class="item-rarity-dot"
               style="background:${item.tier.color};
                      box-shadow:0 0 6px ${item.tier.color}44">
          </div>
          <div class="item-info">
            <div class="item-name">${item.name}</div>
            <div class="item-rarity">${item.tier.name}</div>
          </div>
          <div class="item-price-col">
            <div class="item-price"
                 style="color:${up ? 'var(--bull)' : 'var(--bear)'}">
              ${formatPrice(item.price)}
            </div>
            <div class="item-change ${up ? 'up' : 'down'}">
              ${up ? '▲' : '▼'} ${Math.abs(item.change24h).toFixed(2)}%
            </div>
          </div>
        </div>`;
    })
    .join('');
}

// ── Render: Chart Header ─────────────────────────────────────

function renderChartHeader() {
  const item = state.items[state.selectedIdx];

  document.getElementById('chartName').textContent = item.name;

  const badge        = document.getElementById('chartBadge');
  badge.textContent  = item.tier.name;
  badge.style.background = item.tier.color + '22';
  badge.style.color      = item.tier.color;
  badge.style.border     = `1px solid ${item.tier.color}44`;

  const up      = item.change24h >= 0;
  const priceEl = document.getElementById('chartPrice');
  priceEl.textContent = formatPrice(item.price);
  priceEl.style.color = up ? 'var(--bull)' : 'var(--bear)';

  document.getElementById('chartHigh').textContent = formatPrice(item.high24h);
  document.getElementById('chartLow').textContent  = formatPrice(item.low24h);
  document.getElementById('chartVol').textContent  = formatVolume(item.volume24h);

  const changeEl       = document.getElementById('chartChange');
  changeEl.textContent = `${up ? '+' : ''}${item.change24h.toFixed(2)}%`;
  changeEl.className   = `chart-meta-item ${up ? 'up' : 'down'}`;
}

// ── Render: Order Book ───────────────────────────────────────

function renderOrderBook() {
  const item       = state.items[state.selectedIdx];
  const price      = item.price;
  const spreadPct  = 0.001 + Math.random() * 0.002;

  // Synthetic sell orders (above market price)
  const sellOrders = Array.from({ length: 8 }, (_, i) => {
    const p = price * (1 + spreadPct * (i + 1));
    const q = Math.floor(Math.random() * 5) + 1;
    return { price: p, qty: q, total: p * q };
  }).reverse();

  // Synthetic buy orders (below market price)
  const buyOrders = Array.from({ length: 8 }, (_, i) => {
    const p = price * (1 - spreadPct * (i + 1));
    const q = Math.floor(Math.random() * 5) + 1;
    return { price: p, qty: q, total: p * q };
  });

  const maxTotal = Math.max(...[...sellOrders, ...buyOrders].map(o => o.total));

  const buildRows = (orders, side) =>
    orders
      .map(o => {
        const pct = (o.total / maxTotal * 100).toFixed(1);
        return `
          <div class="ob-row">
            <span style="color:${side === 'sell' ? 'var(--bear)' : 'var(--bull)'}">
              ${formatPrice(o.price)}
            </span>
            <span>${o.qty}</span>
            <span>${formatPrice(o.total)}</span>
            <div class="ob-depth-bar" style="width:${pct}%"></div>
          </div>`;
      })
      .join('');

  document.getElementById('obSell').innerHTML = buildRows(sellOrders, 'sell');
  document.getElementById('obBuy').innerHTML  = buildRows(buyOrders,  'buy');

  const spread    = sellOrders.at(-1).price - buyOrders[0].price;
  const spreadStr = (spread / price * 100).toFixed(3);
  document.getElementById('obSpread').textContent =
    `${formatPrice(spread)} (${spreadStr}%)`;
}

// ── Render: Trade Feed ───────────────────────────────────────

function renderTradeFeed() {
  const rows = state.tradeLog.slice(0, 20);
  document.getElementById('feedRows').innerHTML = rows
    .map(t => `
      <div class="feed-row ${t.side === 'buy' ? 'buy-row' : 'sell-row'}">
        <span class="feed-time">${t.time}</span>
        <span>${t.itemName}</span>
        <span class="${t.side === 'buy' ? 'feed-side-buy' : 'feed-side-sell'}">
          ${t.side.toUpperCase()}
        </span>
        <span>${formatPrice(t.price)}</span>
        <span style="color:var(--muted)">×${t.qty} = ${formatPrice(t.total)}</span>
      </div>`)
    .join('');
}

// ── Render: Header Stats ─────────────────────────────────────

function renderHeader() {
  document.getElementById('hdrUsers').textContent  = Math.round(state.globalUsers).toLocaleString();
  document.getElementById('hdrVolume').textContent = formatVolume(state.totalVolume);
  document.getElementById('hdrTrades').textContent = state.totalTrades.toLocaleString();
}

// ── Render: All ──────────────────────────────────────────────

function renderAll() {
  renderItemList();
  renderChartHeader();
  drawChart();
  renderOrderBook();
  renderTradeFeed();
  renderHeader();
}

// ── User Interactions ────────────────────────────────────────

function selectItem(idx) {
  state.selectedIdx = idx;
  renderAll();
}

function setInterval2(iv, evt) {
  document.querySelectorAll('.interval-btn').forEach(b => b.classList.remove('active'));
  evt.target.classList.add('active');
  // In production, this switches the candle aggregation window
  drawChart();
}

// ── Loading Screen ───────────────────────────────────────────

const LOAD_MESSAGES = [
  'Initializing market engine...',
  'Loading rarity tiers...',
  'Generating price history...',
  'Connecting to order book...',
  'Calibrating inflation index...',
  'Market ready.',
];

async function runLoadingScreen() {
  const fill = document.getElementById('loadFill');
  const text = document.getElementById('loadText');

  for (let i = 0; i < LOAD_MESSAGES.length; i++) {
    text.textContent  = LOAD_MESSAGES[i];
    fill.style.width  = `${(i / (LOAD_MESSAGES.length - 1)) * 100}%`;
    await new Promise(r => setTimeout(r, 350));
  }

  await new Promise(r => setTimeout(r, 200));
  const loadEl        = document.getElementById('loading');
  loadEl.style.opacity = '0';
  setTimeout(() => loadEl.remove(), 500);
}

// ── Main Loop ────────────────────────────────────────────────

runLoadingScreen().then(() => {
  renderAll();

  // Simulation tick every 1.5s
  setInterval(() => {
    const event = tick();
    if (event) addTickerEvent(event.name);
    renderAll();
  }, 1500);

  // Chart redraws more frequently for smooth price-line updates
  setInterval(drawChart, 500);

  // Auto-reset de sesión cada 60 minutos
  setInterval(() => {
    resetMarketSession();
    addTickerEvent('🔄 Session Reset — New epoch started');
    renderAll();
  }, RESET_INTERVAL_MS);
});