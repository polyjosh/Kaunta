// Adds "Book" to the logo wordmark (Kaunta → Kaunta Book) in public/brand/lockup-*.svg,
// outlined from the same Manrope ExtraBold the wordmark is drawn in, after a word space.
// The existing (kerned) "Kaunta" outline is kept as it is. Run once: node scripts/brand-wordmark.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { loadWoff, textPath } from './font-outline.mjs';

const font = loadWoff('node_modules/@fontsource/manrope/files/manrope-latin-800-normal.woff');
const WORD = 'Book';
const r = (n) => Math.round(n * 100) / 100;

/** Right edge of path data written with M/L/H/V/Q/C/Z commands (only x coordinates counted). */
function rightEdge(d) {
  let max = -Infinity;
  const re = /([MLHVQCZ])([^MLHVQCZ]*)/g;
  for (const [, cmd, args] of d.matchAll(re)) {
    const n = args.trim() ? args.trim().split(/[ ,]+/).map(Number) : [];
    if (cmd === 'H') n.forEach((x) => (max = Math.max(max, x)));
    else if (cmd === 'M' || cmd === 'L' || cmd === 'Q' || cmd === 'C') n.forEach((v, i) => i % 2 === 0 && (max = Math.max(max, v)));
  }
  return max;
}

function addWord(file, { stacked }) {
  let svg = readFileSync(file, 'utf8');
  if (svg.includes('aria-label="Kaunta Book"')) return console.log(file, 'already done');
  const [vbW, vbH] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).slice(1).map(Number);
  const paths = [...svg.matchAll(/<path transform="translate\(([\d.]+),([\d.]+)\)" d="([^"]+)" fill="(#[0-9A-Fa-f]+)"\/>/g)];
  // The two text lines: the wordmark (taller) and the tagline under it.
  const [mark, tagline] = paths.sort((a, b) => Number(a[2]) - Number(b[2]));
  const [wx, wy, wd, wfill] = [Number(mark[1]), Number(mark[2]), mark[3], mark[4]];
  const size = (/^M([\d.]+)/.exec(wd)[1] / 140) * font.unitsPerEm; // K's left side bearing is 140 units
  const kaunta = textPath(font, 'Kaunta', size);
  const rsb = kaunta.width - rightEdge(kaunta.d);
  const space = (font.advance(font.glyphOf(32)) / font.unitsPerEm) * size;
  const offset = rightEdge(wd) + rsb + space;
  const book = textPath(font, WORD, size);
  const wordmarkRight = offset + rightEdge(book.d);
  const pad = vbW - (wx + rightEdge(wd));
  const W = r(wx + wordmarkRight + pad);
  const bookPath = `<path transform="translate(${r(wx + offset)},${wy})" d="${book.d}" fill="${wfill}"/>`;
  svg = svg.replace(mark[0], mark[0] + bookPath);

  if (stacked) {
    // Mark and tagline stay centred over the wider wordmark.
    svg = svg.replace(/<g transform="translate\(([\d.]+),8\) scale\(2\)">/, () => `<g transform="translate(${r((W - 128) / 2)},8) scale(2)">`);
    const tw = rightEdge(tagline[3]);
    svg = svg.replace(tagline[0], tagline[0].replace(/translate\([\d.]+,/, `translate(${r((W - tw) / 2)},`));
  }
  svg = svg
    .replace(`viewBox="0 0 ${vbW} ${vbH}"`, `viewBox="0 0 ${W} ${vbH}"`)
    .replace(`width="${vbW}"`, `width="${W}"`)
    .replace(/aria-label="Kaunta"/, 'aria-label="Kaunta Book"')
    .replace('<title>Kaunta</title>', '<title>Kaunta Book</title>')
    // The signed content credentials described the original file; they no longer match it.
    .replace(/<metadata>[\s\S]*?<\/metadata>/, '')
    .replace(' xmlns:c2pa="http://c2pa.org/manifest"', '');
  writeFileSync(file, svg);
  console.log(file, `${vbW}×${vbH} → ${W}×${vbH}`, `(wordmark ${r(size)}px, Book at +${r(offset)})`);
}

addWord('public/brand/lockup-horizontal-dark.svg', { stacked: false });
addWord('public/brand/lockup-horizontal-light.svg', { stacked: false });
addWord('public/brand/lockup-stacked-dark.svg', { stacked: true });
