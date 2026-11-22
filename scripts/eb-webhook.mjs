#!/usr/bin/env node
// List / register the Eventbrite org webhook that feeds the Worker's sync.
//
//   node scripts/eb-webhook.mjs           # dry run (GET only): lists webhooks, prints what --apply would create
//   node scripts/eb-webhook.mjs --apply   # POSTs the webhook (needs EB_WEBHOOK_SECRET); refuses if one already points at the Worker
//
// Tokens: EVENTBRITE_TOKEN and EB_WEBHOOK_SECRET from proxy/.dev.vars (read here, never printed;
// the path secret is masked in all output). EB_WEBHOOK_SECRET must equal the Worker secret.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WORKER_ORIGIN = 'https://est-planning-proxy.eastsidetribe.workers.dev';
export const WEBHOOK_ACTIONS = 'event.created,event.published,event.updated,event.unpublished';
const BASE = 'https://www.eventbriteapi.com/v3';
const PATH_PREFIX = '/webhooks/eventbrite/';

// Pure: hide the path secret of a Worker webhook URL; any other service's URL (which can
// carry its own token) shows host only.
export function maskEndpoint(url) {
  if (!url) return '';
  const s = String(url);
  const i = s.indexOf(PATH_PREFIX);
  if (s.startsWith(WORKER_ORIGIN) && i >= 0) return s.slice(0, i + PATH_PREFIX.length) + '****';
  try { return new URL(s).origin + '/\u2026'; } catch { return '(unparseable url)'; }
}

// Pure: KEY=value lines of a .dev.vars file. Quoted values keep everything inside the quotes;
// unquoted values lose a trailing " # comment".
export function parseDevVars(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    const q = /^(["'])(.*?)\1/.exec(v);
    v = q ? q[2] : v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

const isWorkerHook = w => !!w && typeof w.endpoint_url === 'string' && w.endpoint_url.startsWith(WORKER_ORIGIN + PATH_PREFIX);

// Pure: given the org's existing webhooks, decide create vs exists (any secret counts as existing).
export function planWebhook(existing, endpoint) {
  const hit = (existing || []).find(isWorkerHook);
  if (hit) return { action: 'exists', existing: hit };
  return { action: 'create', body: { endpoint_url: endpoint, actions: WEBHOOK_ACTIONS } };
}

function readVars() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const text = fs.readFileSync(path.join(dir, '../proxy/.dev.vars'), 'utf8');
  const vars = parseDevVars(text);
  const get = k => vars[k] || '';
  const toml = fs.readFileSync(path.join(dir, '../proxy/wrangler.toml'), 'utf8');
  const org = /^\s*EVENTBRITE_ORG_ID\s*=\s*"([^"]+)"/m.exec(toml);
  return { token: get('EVENTBRITE_TOKEN'), secret: get('EB_WEBHOOK_SECRET'), org: org && org[1] };
}

async function ebFetch(token, url, init) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  if (!r.ok) {
    let why = '';
    try { const j = await r.json(); why = j && j.error_description ? `: ${j.error_description}` : ''; } catch { /* no body */ }
    throw new Error(`Eventbrite ${(init && init.method) || 'GET'} ${r.status}${why}`);
  }
  return r.json();
}

async function listWebhooks(token, org) {
  const all = [];
  let url = `${BASE}/organizations/${org}/webhooks/`;
  while (url) {
    const j = await ebFetch(token, url);
    all.push(...(j.webhooks || []));
    const c = j.pagination && j.pagination.has_more_items && j.pagination.continuation;
    url = c ? `${BASE}/organizations/${org}/webhooks/?continuation=${encodeURIComponent(c)}` : null;
  }
  return all;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { token, secret, org } = readVars();
  if (!token) throw new Error('EVENTBRITE_TOKEN not found in proxy/.dev.vars');
  if (!org) throw new Error('EVENTBRITE_ORG_ID not found in proxy/wrangler.toml');
  if (apply && !secret) throw new Error('EB_WEBHOOK_SECRET not found in proxy/.dev.vars; refusing to --apply');

  const hooks = await listWebhooks(token, org);
  console.log(`${hooks.length} webhook(s) on organization ${org}:`);
  for (const w of hooks) console.log(`  ${w.id}  ${maskEndpoint(w.endpoint_url)}  ${w.actions || ''}`);

  const plan = planWebhook(hooks, `${WORKER_ORIGIN}${PATH_PREFIX}${secret || '<EB_WEBHOOK_SECRET>'}`);
  if (plan.action === 'exists') {
    console.log(`\nA webhook to the Worker already exists (${plan.existing.id}); nothing to create.`);
    if (apply) process.exitCode = 1;
    return;
  }
  console.log(`\n${apply ? 'Creating' : 'Would create (re-run with --apply)'}: POST /organizations/${org}/webhooks/`);
  console.log(`  endpoint_url: ${maskEndpoint(plan.body.endpoint_url)}`);
  console.log(`  actions:      ${plan.body.actions}`);
  if (!apply) return;
  const made = await ebFetch(token, `${BASE}/organizations/${org}/webhooks/`, { method: 'POST', body: JSON.stringify(plan.body) });
  console.log(`\nCreated webhook ${made.id}  ${maskEndpoint(made.endpoint_url)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
