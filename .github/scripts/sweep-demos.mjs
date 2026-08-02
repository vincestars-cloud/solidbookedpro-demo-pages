#!/usr/bin/env node
// Deletes every demo directory EXCEPT prospects who replied positively.
//
// Fail-safe by design: any uncertainty (missing creds, failed query, empty
// keep-list, suspiciously large delete) ABORTS without touching a file.
// Deleting a demo for a warm lead is far more expensive than keeping a cold one.

import { execSync } from 'node:child_process';
import { readdirSync, statSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { appendFileSync } from 'node:fs';

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  KEEP_DISPOSITIONS = '', DEMO_GRACE_HOURS = '48', MAX_DELETE_PCT = '97', MIN_KEEP_PHONES = '50',
} = process.env;
const DRY = process.env.DRY_RUN !== 'false';

const NEVER_DELETE = new Set(['assets', 'screenshots', '.github', '.git']);
const log = (m) => console.log(m);
const summary = (m) => { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, m + '\n'); } catch {} };
const abort = (why) => { summary(`### Demos\n- **ABORTED** — ${why}\n- nothing deleted`); log(`ABORT: ${why}`); process.exit(0); };

// normalise exactly like the Supabase classifier: lower, trim, non-letters -> _
const norm = (s) => String(s ?? '').toLowerCase().trim().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
const last10 = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  abort('SUPABASE_URL / SUPABASE_SERVICE_KEY not set — cannot resolve the keep-list');
}

async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Accept-Profile': 'scalingsos',
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on ${path.slice(0, 80)}`);
  return r.json();
}

async function pageAll(table, select, extra = '') {
  const out = []; const step = 1000;
  for (let from = 0; ; from += step) {
    const rows = await sb(`${table}?select=${select}${extra}&limit=${step}&offset=${from}`);
    out.push(...rows);
    if (rows.length < step) break;
    if (out.length > 200000) throw new Error('runaway pagination');
  }
  return out;
}

// ---------------------------------------------------------------- keep-list
const KEEP = new Set(KEEP_DISPOSITIONS.split(',').map(norm).filter(Boolean));
if (!KEEP.size) abort('KEEP_DISPOSITIONS is empty');

let businesses, prospects;
try {
  businesses = await pageAll('businesses', 'slug,phone,created_at');
  prospects = await pageAll('prospects', 'phone,disposition,disposition_locked');
} catch (e) {
  abort(`Supabase query failed (${e.message})`);
}
if (!businesses.length) abort('businesses returned 0 rows');
if (!prospects.length) abort('prospects returned 0 rows');

// phone(last10) -> keep?
const keepPhones = new Set();
for (const p of prospects) {
  const d = norm(p.disposition);
  // disposition_locked === manually curated by a human. Never auto-delete those.
  if (KEEP.has(d) || p.disposition_locked === true) {
    const k = last10(p.phone);
    if (k.length === 10) keepPhones.add(k);
  }
}

const keepSlugs = new Set();
const graceMs = Number(DEMO_GRACE_HOURS) * 3600 * 1000;
const now = Date.now();
let graceKept = 0;
for (const b of businesses) {
  if (!b.slug) continue;
  if (keepPhones.has(last10(b.phone))) keepSlugs.add(b.slug);
  // Freshly built demos may not have been screenshotted/sent yet.
  const built = Date.parse(b.created_at ?? '');
  if (Number.isFinite(built) && now - built < graceMs) { keepSlugs.add(b.slug); graceKept++; }
}

// protected.json — manual allow-list, always wins
if (existsSync('protected.json')) {
  try {
    const j = JSON.parse(readFileSync('protected.json', 'utf8'));
    for (const s of (Array.isArray(j) ? j : j.protected ?? [])) keepSlugs.add(String(s));
  } catch (e) { abort(`protected.json is unreadable (${e.message}) — refusing to run blind`); }
}

if (!keepSlugs.size) abort('keep-list resolved to 0 slugs — refusing to delete everything');
// Most demos SHOULD be deleted (only positive replies survive), so a high delete
// percentage is expected. The real failure mode is the keep-list collapsing —
// a renamed disposition value, a schema change, a broken phone join. Guard that.
if (keepPhones.size < Number(MIN_KEEP_PHONES)) {
  abort(`only ${keepPhones.size} prospects matched KEEP_DISPOSITIONS (floor is ${MIN_KEEP_PHONES}) — the keep-list looks broken, not genuinely small`);
}

// ------------------------------------------------------------------- sweep
const dirs = readdirSync('.', { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !NEVER_DELETE.has(d.name))
  .map((d) => d.name);

const doomed = dirs.filter((d) => !keepSlugs.has(d));
const pct = dirs.length ? (doomed.length / dirs.length) * 100 : 0;

const du = (p) => { let t = 0; const walk = (x) => { for (const e of readdirSync(x, { withFileTypes: true })) { const f = `${x}/${e.name}`; e.isDirectory() ? walk(f) : (t += statSync(f).size); } }; try { walk(p); } catch {} return t; };
const freed = doomed.reduce((a, d) => a + du(d), 0);

log(`demo dirs=${dirs.length} keep=${dirs.length - doomed.length} delete=${doomed.length} (${pct.toFixed(1)}%) freeing ${(freed / 1048576).toFixed(0)} MB`);
log(`  keep breakdown: positive-reply=${keepSlugs.size - graceKept} within-${DEMO_GRACE_HOURS}h-grace=${graceKept}`);
// --- diagnostics: how well does the DB keep-list line up with what's on disk?
const onDisk = new Set(dirs);
const keepOnDisk = [...keepSlugs].filter((s) => onDisk.has(s));
const keepMissing = [...keepSlugs].filter((s) => !onDisk.has(s));
log(`  DIAG businesses rows=${businesses.length} prospects rows=${prospects.length}`);
log(`  DIAG keep-slugs total=${keepSlugs.size} | present on disk=${keepOnDisk.length} | not in this repo=${keepMissing.length}`);
log(`  DIAG keepPhones (positive dispositions)=${keepPhones.size}`);
log(`  DIAG sample KEEP on disk: ${keepOnDisk.slice(0, 12).join(', ')}`);
log(`  DIAG sample keep NOT on disk: ${keepMissing.slice(0, 6).join(', ')}`);
log(`  DIAG sample DOOMED: ${doomed.slice(0, 12).join(', ')}`);
summary([
  '### Demos',
  `- on disk: **${dirs.length}**`,
  `- keep: **${dirs.length - doomed.length}** (positive reply, locked, protected, or <${DEMO_GRACE_HOURS}h old)`,
  `- delete: **${doomed.length}** (${pct.toFixed(1)}%) freeing **${(freed / 1048576).toFixed(0)} MB**`,
  `- mode: ${DRY ? '**DRY RUN**' : 'LIVE'}`,
].join('\n'));

if (pct > Number(MAX_DELETE_PCT)) {
  abort(`would delete ${pct.toFixed(1)}% of demos, above MAX_DELETE_PCT=${MAX_DELETE_PCT} — looks like a bad keep-list`);
}

if (DRY) {
  log('DRY RUN — nothing removed. Sample:');
  doomed.slice(0, 15).forEach((d) => log(`  would delete ${d}/`));
  process.exit(0);
}

for (const d of doomed) rmSync(d, { recursive: true, force: true });
execSync('git add -A', { stdio: 'inherit' });
log(`removed ${doomed.length} demo directories`);
