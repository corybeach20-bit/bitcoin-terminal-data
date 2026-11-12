// Daily data snapshot. Runs once a day (GitHub Actions, see .github/workflows/daily-snapshot.yml), fetches the
// series that bitcoin-data.com limits to 15 requests/day, and writes them as plain JSON files that every copy
// of the app can read. One server-side fetch per day replaces one fetch per user.
//
//   node tools/snapshot/snapshot.mjs <output-folder>
//
// Environment (all optional):
//   BG_BASE   API root                       default https://bitcoin-data.com/v1
//   BG_TOKEN  API token, if you have one     sent as a Bearer token
//   PACE_MS   wait between requests (ms)     default 390000 (free plan: 10 requests/hour)
//   MAX_REQ   most requests per run          default 13 (free plan: 15/day, leaving some spare)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = (process.env.BG_BASE ?? 'https://bitcoin-data.com/v1').replace(/\/+$/, '');
const PACE = Number(process.env.PACE_MS ?? 390_000);
const MAX = Number(process.env.MAX_REQ ?? 13);
const out = process.argv[2];
if (!out) {
  console.error('usage: node snapshot.mjs <output-folder>');
  process.exit(2);
}

// Fetched every day: what the Supply & Movement and Address Balances charts need.
export const CORE = [
  'balance-addr-1-BTC',
  'balance-addr-10-1-BTC',
  'balance-addr-100-10-BTC',
  'balance-addr-1K-100-BTC',
  'balance-addr-10K-1K-BTC',
  'balance-addr-10K-BTC',
  'hodl-waves-supply',
];
// Rotated through, a few per day, so every one is refreshed every few days within the daily limit.
export const ROTATING = [
  'realized-cap-hodl-waves', 'cdd', 'vdd-multiple', 'supply-adjusted-cdd', 'sth-mvrv', 'lth-mvrv',
  'utxos-in-profit-pct', 'utxos-in-loss-pct', 'lth-realized-price', 'sth-realized-price', 'realized-price', 'terminal-price',
];

export function plan(dayNumber, max = MAX) {
  const extra = Math.max(0, max - CORE.length);
  const start = (dayNumber * extra) % ROTATING.length;
  const picks = [];
  for (let i = 0; i < Math.min(extra, ROTATING.length); i++) picks.push(ROTATING[(start + i) % ROTATING.length]);
  return [...CORE, ...picks];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { accept: 'application/json', 'user-agent': 'bitcoin-terminal-snapshot/1' };
if (process.env.BG_TOKEN) headers.authorization = `Bearer ${process.env.BG_TOKEN}`;

/** Accept only what the app can use: an array of rows with a date and at least one number. */
export function validRows(rows) {
  if (!Array.isArray(rows) || rows.length < 30) return false;
  const r = rows[rows.length - 1];
  if (!r || typeof r !== 'object' || !(r.d || r.unixTs || r.date)) return false;
  return Object.entries(r).some(([k, v]) => !['d', 'unixTs', 'date'].includes(k) && Number.isFinite(Number(v)));
}

async function main() {
  await mkdir(out, { recursive: true });
  let index = { updated: null, endpoints: {} };
  try { index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8')); } catch { /* first run */ }
  const day = Math.floor(Date.now() / 86_400_000);
  const todo = plan(day).slice(0, MAX);
  let ok = 0;
  let requests = 0;
  for (const ep of todo) {
    if (requests > 0 && PACE > 0) await sleep(PACE);
    requests++;
    try {
      const res = await fetch(`${BASE}/${ep}`, { headers });
      if (res.status === 429) {
        console.warn(`${ep}: rate limited — stopping, keeping the previous files`);
        break;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      if (!validRows(rows)) throw new Error('response did not look like a data series');
      await writeFile(join(out, `${ep}.json`), JSON.stringify(rows));
      index.endpoints[ep] = { updated: new Date().toISOString(), rows: rows.length, last: rows[rows.length - 1].d ?? null };
      ok++;
      console.log(`${ep}: ${rows.length} rows`);
    } catch (e) {
      // a failed endpoint keeps yesterday's file, so the app always has something
      console.warn(`${ep}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (ok > 0) index.updated = new Date().toISOString();
  await writeFile(join(out, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`done: ${ok}/${todo.length} refreshed`);
  if (ok === 0) process.exitCode = 1; // makes the workflow show red when nothing worked
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
