#!/usr/bin/env node
// Choose a client's tier (agency only; needs the client's SETUP_TOKEN).
//   MERCHANT_URL=https://api.acme.tg SETUP_TOKEN=... node scripts/set-tier.mjs standard --sells physical,digital [--extra offers,ads] [--max-products 100] [--max-staff 2]
//   node scripts/set-tier.mjs --list     show the tiers and what is stored (same env vars)
const args = process.argv.slice(2);
const base = (process.env.MERCHANT_URL || 'http://localhost:8787').replace(/\/$/, '');
const token = process.env.SETUP_TOKEN;
if (!token) { console.error('Set SETUP_TOKEN (the secret of this client\'s API).'); process.exit(1); }
const flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
const headers = { 'X-Setup-Token': token, 'Content-Type': 'application/json' };
if (args.includes('--list') || !args[0]) {
  const r = await fetch(`${base}/v1/tier`, { headers }); console.log(JSON.stringify(await r.json(), null, 2)); process.exit(r.ok ? 0 : 1);
}
const body = { tier: args[0] };
if (flag('sells')) body.sells = flag('sells').split(',').map((s) => s.trim());
if (flag('extra')) body.extra_modules = flag('extra').split(',').map((s) => s.trim());
if (flag('max-products')) body.max_products = flag('max-products') === 'none' ? null : Number(flag('max-products'));
if (flag('max-staff')) body.max_staff = flag('max-staff') === 'none' ? null : Number(flag('max-staff'));
const r = await fetch(`${base}/v1/tier`, { method: 'PUT', headers, body: JSON.stringify(body) });
const out = await r.json(); console.log(JSON.stringify(out, null, 2)); process.exit(r.ok ? 0 : 1);
