// Small SVG chart kit: line (crosshair tooltip), horizontal bars and scatter (per-mark tooltips).
// Colors: validated dark-mode categorical palette, assigned per player on first sight and never re-cycled.
const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  const OTHER = '#8b95a5'; // 9th+ player: neutral, never a generated hue
  const assigned = new Map();
  const colorFor = name => {
    if (!assigned.has(name)) assigned.set(name, PALETTE[assigned.size] ?? OTHER);
    return assigned.get(name);
  };

  const tip = document.createElement('div');
  tip.className = 'charttip';
  tip.hidden = true;
  document.body.append(tip);

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    parent?.append(e);
    return e;
  }
  const text = (parent, attrs, str) => (el('text', attrs, parent).textContent = str);

  // Labels are player-supplied, so everything goes in via textContent.
  function showTip(evt, rows, title) {
    tip.replaceChildren();
    if (title) {
      const h = document.createElement('div');
      h.className = 'tt-title';
      h.textContent = title;
      tip.append(h);
    }
    for (const r of rows) {
      const d = document.createElement('div');
      d.className = 'tt-row';
      if (r.color) {
        const k = document.createElement('i');
        k.style.background = r.color;
        d.append(k);
      }
      const b = document.createElement('b');
      b.textContent = r.value;
      const s = document.createElement('span');
      s.textContent = r.label;
      d.append(b, s);
      tip.append(d);
    }
    tip.hidden = false;
    tip.style.left = Math.min(evt.clientX + 14, innerWidth - tip.offsetWidth - 8) + 'px';
    tip.style.top = Math.min(evt.clientY + 14, innerHeight - tip.offsetHeight - 8) + 'px';
  }
  const hideTip = () => (tip.hidden = true);

  function ticks(lo, hi, n = 4) {
    if (lo === hi) lo -= 1, hi += 1;
    const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
    const out = [];
    for (let v = Math.floor(lo / step) * step; v < hi + step * 0.999; v += step) out.push(+v.toFixed(10));
    return out;
  }
  const fmt = v => (Math.abs(v) >= 10000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(Math.round(v * 10) / 10));

  function empty(host, msg = 'No data yet') {
    const p = document.createElement('p');
    p.className = 'muted chart-empty';
    p.textContent = msg;
    host.append(p);
  }

  function legend(host, series) {
    if (series.length < 2) return;
    const box = document.createElement('div');
    box.className = 'legend';
    for (const s of series) {
      const item = document.createElement('span');
      const key = document.createElement('i');
      key.style.background = s.color;
      item.append(key, document.createTextNode(s.name));
      box.append(item);
    }
    host.append(box);
  }

  // series: [{ name, color, points: [{ x, y }] }]
  function line(host, { series, height = 200, xLabel = 'Hand', zero = false }) {
    host.replaceChildren();
    const xs = series.flatMap(s => s.points.map(p => p.x)), ys = series.flatMap(s => s.points.map(p => p.y));
    if (!xs.length) return empty(host);
    const W = Math.max(240, host.clientWidth), H = height, m = { l: 44, r: series.length > 1 && series.length <= 4 ? 64 : 12, t: 10, b: 22 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Line chart of ${series.map(s => s.name).join(', ')}` }, host);
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (x0 === x1) x1 = x0 + 1;
    const yt = ticks(Math.min(...ys, ...(zero ? [0] : [])), Math.max(...ys, ...(zero ? [0] : [])));
    const y0 = yt[0], y1 = yt.at(-1);
    const X = x => m.l + ((x - x0) / (x1 - x0)) * (W - m.l - m.r);
    const Y = y => H - m.b - ((y - y0) / (y1 - y0)) * (H - m.t - m.b);
    for (const v of yt) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: zero && v === 0 ? 'axis' : 'grid' }, svg);
      text(svg, { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, fmt(v));
    }
    text(svg, { x: m.l, y: H - 6, class: 'tick' }, `${xLabel} ${x0}`);
    text(svg, { x: W - m.r, y: H - 6, 'text-anchor': 'end', class: 'tick' }, `${x1}`);
    for (const s of series) {
      el('polyline', { points: s.points.map(p => `${X(p.x)},${Y(p.y)}`).join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      const last = s.points.at(-1);
      if (series.length > 1 && series.length <= 4 && last) text(svg, { x: X(last.x) + 6, y: Y(last.y) + 4, class: 'dlabel' }, s.name.slice(0, 10));
    }
    // Crosshair snaps to the nearest hand; one tooltip lists every series.
    const cross = el('line', { y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' }, svg);
    const dots = series.map(s => el('circle', { r: 4, fill: s.color, stroke: 'var(--panel)', 'stroke-width': 2, visibility: 'hidden' }, svg));
    const allX = [...new Set(xs)].sort((a, b) => a - b);
    const hit = el('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', e => {
      const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) * W) / r.width;
      const xv = allX.reduce((b, v) => (Math.abs(X(v) - px) < Math.abs(X(b) - px) ? v : b), allX[0]);
      cross.setAttribute('x1', X(xv));
      cross.setAttribute('x2', X(xv));
      cross.setAttribute('visibility', 'visible');
      const rows = [];
      series.forEach((s, i) => {
        const p = s.points.find(q => q.x === xv);
        dots[i].setAttribute('visibility', p ? 'visible' : 'hidden');
        if (!p) return;
        dots[i].setAttribute('cx', X(xv));
        dots[i].setAttribute('cy', Y(p.y));
        rows.push({ value: fmt(p.y), label: s.name, color: s.color, y: p.y });
      });
      showTip(e, rows.sort((a, b) => b.y - a.y), `${xLabel} ${xv}`);
    });
    hit.addEventListener('pointerleave', () => {
      hideTip();
      cross.setAttribute('visibility', 'hidden');
      dots.forEach(d => d.setAttribute('visibility', 'hidden'));
    });
    legend(host, series);
  }

  // items: [{ label, value, color? }]; handles negative values around a zero line.
  function bars(host, { items, unit = '', color = PALETTE[0] }) {
    host.replaceChildren();
    if (!items.length) return empty(host);
    const W = Math.max(240, host.clientWidth), rowH = 26, m = { l: 124, r: 56 }, H = items.length * rowH + 6;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Bar chart' }, host);
    const max = Math.max(...items.map(i => Math.abs(i.value)), 1e-9);
    const neg = items.some(i => i.value < 0);
    const span = W - m.l - m.r, zeroX = neg ? m.l + span / 2 : m.l, scale = (neg ? span / 2 : span) / max;
    if (neg) el('line', { x1: zeroX, x2: zeroX, y1: 0, y2: H, class: 'axis' }, svg);
    items.forEach((it, k) => {
      const y = k * rowH + 4, w = Math.max(2, Math.abs(it.value) * scale), x = it.value < 0 ? zeroX - w : zeroX;
      text(svg, { x: m.l - 8, y: y + 13, 'text-anchor': 'end', class: 'tick' }, it.label.length > 17 ? it.label.slice(0, 16) + '…' : it.label);
      const bar = el('rect', { x, y, width: w, height: rowH - 10, rx: 4, fill: it.color || color, class: 'bar' }, svg);
      text(svg, { x: it.value < 0 ? x - 4 : x + w + 4, y: y + 13, 'text-anchor': it.value < 0 ? 'end' : 'start', class: 'dlabel' }, fmt(it.value) + unit);
      const hit = el('rect', { x: 0, y: y - 2, width: W, height: rowH, fill: 'transparent' }, svg);
      hit.addEventListener('pointermove', e => { bar.classList.add('hover'); showTip(e, [{ value: fmt(it.value) + unit, label: it.label }]); });
      hit.addEventListener('pointerleave', () => { bar.classList.remove('hover'); hideTip(); });
    });
  }

  // points: [{ label, x, y }], one series; every dot is direct-labelled.
  function scatter(host, { points, xLabel, yLabel, xMax = 100, yMax = 60, corners = [] }) {
    host.replaceChildren();
    if (!points.length) return empty(host);
    const W = Math.max(240, host.clientWidth), H = 240, m = { l: 40, r: 16, t: 12, b: 34 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Scatter of ${yLabel} against ${xLabel}` }, host);
    const X = x => m.l + (Math.min(x, xMax) / xMax) * (W - m.l - m.r);
    const Y = y => H - m.b - (Math.min(y, yMax) / yMax) * (H - m.t - m.b);
    for (const v of ticks(0, yMax)) if (v <= yMax) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }, svg);
      text(svg, { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, v + '%');
    }
    for (const v of ticks(0, xMax)) if (v <= xMax) text(svg, { x: X(v), y: H - m.b + 14, 'text-anchor': 'middle', class: 'tick' }, v + '%');
    text(svg, { x: W - m.r, y: H - 4, 'text-anchor': 'end', class: 'tick' }, xLabel + ' →');
    text(svg, { x: m.l + 4, y: m.t + 10, class: 'tick' }, '↑ ' + yLabel);
    corners.forEach(([label, cx, cy]) => text(svg, { x: cx ? W - m.r - 4 : m.l + 4, y: cy ? m.t + 26 : H - m.b - 6, 'text-anchor': cx ? 'end' : 'start', class: 'corner' }, label));
    const placed = []; // label boxes, so stacked players don't print on top of each other
    for (const p of points) {
      el('circle', { cx: X(p.x), cy: Y(p.y), r: 5, fill: p.color || PALETTE[0], stroke: 'var(--panel)', 'stroke-width': 2 }, svg);
      const lx = X(p.x) + 8, w = Math.min(12, p.label.length) * 6.5;
      let ly = Y(p.y) + 4;
      while (ly > m.t + 10 && placed.some(b => lx < b.x + b.w && b.x < lx + w && Math.abs(b.y - ly) < 12)) ly -= 12;
      if (ly > m.t + 10) placed.push({ x: lx, y: ly, w }), text(svg, { x: lx, y: ly, class: 'dlabel' }, p.label.slice(0, 12));
      const hit = el('circle', { cx: X(p.x), cy: Y(p.y), r: 12, fill: 'transparent' }, svg);
      hit.addEventListener('pointermove', e => showTip(e, [{ value: `${p.x}%`, label: xLabel }, { value: `${p.y}%`, label: yLabel }], p.label));
      hit.addEventListener('pointerleave', hideTip);
    }
  }

  return { line, bars, scatter, colorFor };
})();
