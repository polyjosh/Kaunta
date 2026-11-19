// Outlines text from a WOFF 1 TrueType font into an SVG path (no dependencies).
// Used to draw the logo wordmark (public/brand/lockup-*.svg) in Manrope.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export function loadWoff(file) {
  const b = readFileSync(file);
  const n = b.readUInt16BE(12);
  const tables = {};
  for (let i = 0; i < n; i++) {
    const o = 44 + i * 20;
    const tag = b.toString('ascii', o, o + 4);
    const off = b.readUInt32BE(o + 4), comp = b.readUInt32BE(o + 8), orig = b.readUInt32BE(o + 12);
    const raw = b.subarray(off, off + comp);
    tables[tag] = comp < orig ? inflateSync(raw) : Buffer.from(raw);
  }
  const head = tables.head, hhea = tables.hhea, maxp = tables.maxp;
  const unitsPerEm = head.readUInt16BE(18);
  const longLoca = head.readInt16BE(50) === 1;
  const numGlyphs = maxp.readUInt16BE(4);
  const numHMetrics = hhea.readUInt16BE(34);
  const loca = [];
  for (let i = 0; i <= numGlyphs; i++) loca.push(longLoca ? tables.loca.readUInt32BE(i * 4) : tables.loca.readUInt16BE(i * 2) * 2);
  const advance = (g) => tables.hmtx.readUInt16BE(Math.min(g, numHMetrics - 1) * 4);
  // cmap format 4
  const cmap = tables.cmap;
  let sub = null;
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const pid = cmap.readUInt16BE(4 + i * 8), eid = cmap.readUInt16BE(6 + i * 8), off = cmap.readUInt32BE(8 + i * 8);
    if (cmap.readUInt16BE(off) === 4 && (pid === 3 || pid === 0)) { sub = off; if (pid === 3 && eid === 1) break; }
  }
  const glyphOf = (code) => {
    const segX2 = cmap.readUInt16BE(sub + 6), segs = segX2 / 2;
    const ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let s = 0; s < segs; s++) {
      const end = cmap.readUInt16BE(ends + s * 2), start = cmap.readUInt16BE(starts + s * 2);
      if (code > end) continue;
      if (code < start) return 0;
      const delta = cmap.readInt16BE(deltas + s * 2), ro = cmap.readUInt16BE(ranges + s * 2);
      if (ro === 0) return (code + delta) & 0xffff;
      const g = cmap.readUInt16BE(ranges + s * 2 + ro + (code - start) * 2);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
  const contours = (g) => {
    const glyf = tables.glyf, o = loca[g];
    if (loca[g + 1] === o) return [];
    const nc = glyf.readInt16BE(o);
    if (nc < 0) throw new Error('composite glyph ' + g + ' not supported');
    let p = o + 10;
    const endPts = [];
    for (let i = 0; i < nc; i++, p += 2) endPts.push(glyf.readUInt16BE(p));
    const nPts = endPts[nc - 1] + 1;
    p += 2 + glyf.readUInt16BE(p);
    const flags = [];
    while (flags.length < nPts) {
      const f = glyf[p++]; flags.push(f);
      if (f & 8) { let r = glyf[p++]; while (r--) flags.push(f); }
    }
    const read = (short, same) => {
      const out = []; let v = 0;
      for (const f of flags) {
        if (f & short) { const d = glyf[p++]; v += f & same ? d : -d; }
        else if (!(f & same)) { v += glyf.readInt16BE(p); p += 2; }
        out.push(v);
      }
      return out;
    };
    const xs = read(2, 16), ys = read(4, 32);
    const cs = []; let s = 0;
    for (const e of endPts) { cs.push(flags.slice(s, e + 1).map((f, i) => ({ x: xs[s + i], y: ys[s + i], on: !!(f & 1) }))); s = e + 1; }
    return cs;
  };
  return { unitsPerEm, glyphOf, advance, contours };
}

const r = (n) => Math.round(n * 1000) / 1000;

/** SVG path data for `text` at `size` px, baseline at y = 0, starting at x = 0. Returns { d, width }. */
export function textPath(font, text, size) {
  const k = size / font.unitsPerEm;
  let pen = 0; let d = '';
  for (const ch of text) {
    const g = font.glyphOf(ch.codePointAt(0));
    for (const pts of font.contours(g)) {
      const P = (q) => [r((pen + q.x) * k), r(-q.y * k)];
      // Start at an on-curve point (or the midpoint of two off-curve points).
      let start = pts.findIndex((q) => q.on);
      let seq = start >= 0 ? [...pts.slice(start), ...pts.slice(0, start)] : pts;
      if (start < 0) { const m = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2, on: true }; seq = [m, ...pts.slice(1), pts[0]]; }
      const [sx, sy] = P(seq[0]); d += `M${sx} ${sy}`;
      for (let i = 1; i <= seq.length; i++) {
        const cur = seq[i % seq.length];
        if (cur.on) { const [x, y] = P(cur); d += `L${x} ${y}`; continue; }
        let next = seq[(i + 1) % seq.length];
        let end = next;
        if (!next.on) end = { x: (cur.x + next.x) / 2, y: (cur.y + next.y) / 2 };
        else i++;
        const [cx, cy] = P(cur), [ex, ey] = P(end);
        d += `Q${cx} ${cy} ${ex} ${ey}`;
      }
      d += 'Z';
    }
    pen += font.advance(g);
  }
  return { d, width: pen * k };
}
