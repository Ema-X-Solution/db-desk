// Small DOM and formatting helpers shared by the renderer modules.
export function el(tag: string, attrs: Record<string, string> = {}, text = '') {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

export function bytes(n: number) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

export function duration(sec: number) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export function ago(iso: string | number) {
  const sec = Math.max(0, (Date.now() - (typeof iso === 'number' ? iso * 1000 : new Date(iso).getTime())) / 1000);
  if (sec < 90) return 'just now';
  return duration(sec) + ' ago';
}

/** A horizontal bar. Turns amber above 70% and red above 90% when `warn` is set. */
export function bar(percent: number, warn = true) {
  const p = Math.max(0, Math.min(100, percent));
  const outer = el('div', { class: 'bar-outer' }); const inner = el('div', { class: 'bar-inner' + (warn && p >= 90 ? ' red' : warn && p >= 70 ? ' amber' : '') });
  inner.style.width = p + '%'; outer.append(inner); return outer;
}

/** A tiny line chart for a series of numbers (newest last). */
export function spark(values: number[], max?: number) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 120 28'); svg.setAttribute('class', 'spark'); svg.setAttribute('preserveAspectRatio', 'none');
  if (values.length === 1) values = [values[0], values[0]];
  const top = max ?? Math.max(1, ...values);
  const pts = values.map((v, i) => `${values.length < 2 ? 0 : (i / (values.length - 1)) * 120},${26 - (Math.min(v, top) / top) * 24}`).join(' ');
  const line = document.createElementNS(ns, 'polyline'); line.setAttribute('points', pts); line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#7aa2ff'); line.setAttribute('stroke-width', '1.5');
  svg.append(line); return svg;
}

/** A titled card with rows of "label  value". */
export function card(title: string) {
  const c = el('div', { class: 'card' }); c.append(el('div', { class: 'card-title' }, title)); return c;
}
export function kv(label: string, value: string) {
  const r = el('div', { class: 'kv' }); r.append(el('span', { class: 'muted' }, label), el('span', {}, value)); return r;
}
