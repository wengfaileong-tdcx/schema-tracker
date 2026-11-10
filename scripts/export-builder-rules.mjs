// Turns a saved copy of the LLMSource Schema Flow page into the rules file
// the schema builder loads into the private "builder rules" sheet tab.
//
//   node scripts/export-builder-rules.mjs <schema-flow.html> <out.json> [label]
//
// It copies Schema Flow's own generator (LLMSgen) and data unchanged, so the
// builder makes exactly the templates Schema Flow shows. The output holds
// internal rules: keep it out of this public repo.
import fs from 'node:fs';

const [src, out, label = 'Schema Flow'] = process.argv.slice(2);
if (!src || !out) { console.error('usage: export-builder-rules.mjs <schema-flow.html> <out.json> [label]'); process.exit(1); }
const html = fs.readFileSync(src, 'utf8');
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
const dataTag = scripts.find(m => /id="data"/.test(m[1]));
const genTag = scripts.find(m => /function LLMSgen\(D\)/.test(m[2]));
if (!dataTag || !genTag) { console.error('Could not find the data and the generator in ' + src); process.exit(1); }
const D = JSON.parse(dataTag[2]);
const gen = genTag[2].trim();

// Check it runs before writing anything.
const LLMSgen = new Function(gen + ';return LLMSgen;')();
const bv = {};
D.bv.forEach(r => { const { pilot, ...row } = r; (bv[r.id] = bv[r.id] || []).push(row); });
let made = 0;
D.tax.forEach(t => {
  const G = LLMSgen({ tax: D.tax, anc: D.anc, range: D.range, bv: bv[t.id] || [] });
  (bv[t.id] || []).forEach(r => ['single', 'multi', 'none'].forEach(sc => { const p = G.page(r, t, sc); if (p && p.json) made++; }));
});

const rules = {
  format: 'schema-tracker-builder-rules', v: 1, label: label,
  exported: new Date().toISOString().slice(0, 10),
  gen: gen, tax: D.tax, anc: D.anc, range: D.range, bv: bv
};
fs.writeFileSync(out, JSON.stringify(rules));
console.log('wrote', out, (fs.statSync(out).size / 1e6).toFixed(1) + ' MB', '·', D.tax.length, 'categories ·', D.bv.length, 'page rows ·', made, 'templates checked');
