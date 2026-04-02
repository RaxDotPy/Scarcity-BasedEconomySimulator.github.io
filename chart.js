/* ============================================================
   RAX EXCHANGE — chart.js
   Candlestick chart renderer (Canvas 2D)
   Depends on: engine.js (state)
   ============================================================ */

const canvas = document.getElementById('chart');
const ctx    = canvas.getContext('2d');

// ── Canvas resize ────────────────────────────────────────────

function resizeCanvas() {
  const rect   = canvas.parentElement.getBoundingClientRect();
  canvas.width  = rect.width;
  canvas.height = rect.height;
}

window.addEventListener('resize', () => {
  resizeCanvas();
  drawChart();
});

resizeCanvas();

// ── Main draw function ───────────────────────────────────────

/**
 * Renders the full candlestick chart for the currently selected item.
 * Includes: background, grid, area fill, candles, current-price line,
 * price tag, X-axis labels, and volume bars.
 */
function drawChart() {
  const item = state.items[state.selectedIdx];
  if (!item || !item.candles.length) return;

  const W       = canvas.width;
  const H       = canvas.height;
  const candles = item.candles.slice(-80);
  const PAD     = { top: 20, right: 60, bottom: 40, left: 10 };
  const plotW   = W - PAD.left - PAD.right;
  const plotH   = H - PAD.top  - PAD.bottom;

  ctx.clearRect(0, 0, W, H);

  // ── Background ──
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, '#080c10');
  bgGrad.addColorStop(1, '#0a0f15');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // ── Price range with padding ──
  const prices = candles.flatMap(c => [c.h, c.l]);
  const minP   = Math.min(...prices);
  const maxP   = Math.max(...prices);
  const range  = maxP - minP || 1;
  const padded = range * 0.08;
  const lo     = minP - padded;
  const hi     = maxP + padded;

  // Coordinate helpers
  const px  = p  => PAD.top  + plotH * (1 - (p  - lo) / (hi - lo));
  const cx  = i  => PAD.left + (i + 0.5) * (plotW / candles.length);
  const cw  = Math.max(1, plotW / candles.length * 0.65);

  // ── Horizontal grid lines ──
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth   = 1;

  for (let i = 0; i <= 5; i++) {
    const price = lo + (hi - lo) * (i / 5);
    const y     = px(price);

    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(W - PAD.right, y);
    ctx.stroke();

    ctx.fillStyle  = 'rgba(74,85,104,0.8)';
    ctx.font       = '9px JetBrains Mono';
    ctx.textAlign  = 'left';
    ctx.fillText(formatPrice(price), W - PAD.right + 4, y + 3);
  }

  // ── Area fill under close line ──
  const isUp    = candles.at(-1).c >= candles[0].o;
  const areaGrd = ctx.createLinearGradient(0, 0, 0, H);
  areaGrd.addColorStop(0, isUp ? 'rgba(0,200,150,0.06)' : 'rgba(255,69,96,0.06)');
  areaGrd.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.beginPath();
  candles.forEach((c, i) => {
    if (i === 0) ctx.moveTo(cx(i), px(c.c));
    else         ctx.lineTo(cx(i), px(c.c));
  });
  ctx.lineTo(cx(candles.length - 1), H);
  ctx.lineTo(cx(0), H);
  ctx.closePath();
  ctx.fillStyle = areaGrd;
  ctx.fill();

  // ── Candlestick bodies & wicks ──
  candles.forEach((c, i) => {
    const x     = cx(i);
    const bull  = c.c >= c.o;
    const color = bull ? '#00c896' : '#ff4560';

    // Wick
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x, px(c.h));
    ctx.lineTo(x, px(c.l));
    ctx.stroke();

    // Body
    const bodyY = px(Math.max(c.o, c.c));
    const bodyH = Math.max(1, Math.abs(px(c.o) - px(c.c)));

    ctx.fillStyle   = cw < 4 ? color : (bull ? 'rgba(0,200,150,0.85)' : 'rgba(255,69,96,0.85)');
    ctx.strokeStyle = color;
    ctx.lineWidth   = 0.5;
    ctx.fillRect(x - cw / 2, bodyY, cw, bodyH);
    if (cw >= 4) ctx.strokeRect(x - cw / 2, bodyY, cw, bodyH);
  });

  // ── Current price dashed line ──
  const lastPrice = candles.at(-1).c;
  const lineY     = px(lastPrice);

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(0,245,196,0.4)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(PAD.left, lineY);
  ctx.lineTo(W - PAD.right, lineY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Price tag pill
  ctx.fillStyle = '#00f5c4';
  ctx.fillRect(W - PAD.right + 1, lineY - 9, PAD.right - 2, 18);
  ctx.fillStyle  = '#080c10';
  ctx.font       = 'bold 9px JetBrains Mono';
  ctx.textAlign  = 'center';
  ctx.fillText(
    formatPrice(lastPrice),
    W - PAD.right + (PAD.right - 2) / 2,
    lineY + 3
  );

  // ── X-axis time labels ──
  ctx.fillStyle  = 'rgba(74,85,104,0.6)';
  ctx.font       = '9px JetBrains Mono';
  ctx.textAlign  = 'center';
  const labelStep = Math.max(1, Math.floor(candles.length / 8));

  candles.forEach((c, i) => {
    if (i % labelStep === 0) {
      const d     = new Date(c.t * 1000);
      const label = d.getHours().toString().padStart(2, '0') + ':' +
                    d.getMinutes().toString().padStart(2, '0');
      ctx.fillText(label, cx(i), H - PAD.bottom + 14);
    }
  });

  // ── Volume bars (bottom strip, 12% of plot height) ──
  const maxVol = Math.max(...candles.map(c => c.v));
  const volH   = plotH * 0.12;

  candles.forEach((c, i) => {
    const x = cx(i);
    const h = Math.max(1, (c.v / maxVol) * volH);
    ctx.fillStyle = c.c >= c.o ? 'rgba(0,200,150,0.3)' : 'rgba(255,69,96,0.3)';
    ctx.fillRect(x - cw / 2, PAD.top + plotH - h, cw, h);
  });
}
