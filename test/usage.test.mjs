import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { meter, usageReport } from '../server/usage.mjs';

test('usage report: counts our API calls and AI tokens, reads provider accounts, flags services close to their limit', async () => {
  const store = new Store(':memory:');
  const fetchImpl = async url => ({ ok: true, status: 200, json: async () => url.includes('serpapi.com/account') ? { plan_name: 'Free Plan', searches_per_month: 250, this_month_usage: 230, plan_searches_left: 20 } : {} });
  const env = { SMS_MODE: 'preview', TICKETMASTER_API_KEY: 'k', GOOGLE_MAPS_API_KEY: 'g', SERP_API_KEY: 's', ANTHROPIC_MONTHLY_BUDGET_USD: '10', PUBLIC_BASE_URL: 'https://rall-e.ai' };
  const sms = new Sms(store, env, undefined, fetchImpl);
  for (let i = 0; i < 3; i++) meter.call('https://app.ticketmaster.com/discovery/v2/events.json?x=1', new Map([['rate-limit-available', '4990'], ['rate-limit', '5000']]));
  meter.call('https://places.googleapis.com/v1/places:searchText'); meter.call('https://maps.googleapis.com/maps/api/geocode/json?address=x');
  meter.ai({ input_tokens: 1_000_000, output_tokens: 500_000 }, new Map());
  const r = await usageReport(sms, env, fetchImpl), card = id => r.cards.find(c => c.id === id);
  assert.deepEqual(card('ticketmaster').meter, { used: 3, limit: 5000, unit: 'calls today' });
  assert.match(card('ticketmaster').facts[0], /4,990 of 5,000/);
  assert.equal(card('serpapi').status, 'critical'); assert.equal(r.cards[0].id, 'serpapi'); // most urgent first
  assert.equal(card('anthropic').meter.used, 7); assert.equal(card('anthropic').status, 'ok'); // $2 in + $5 out = $7 of $10
  assert.match(card('google').facts.join(' '), /text search: 1 of/);
  assert.equal(card('openai').status, 'off'); // no backup key in this test
  store.close();
});

test('usage report: spend is priced per model, and the share of cached input is shown', async () => {
  const store = new Store(':memory:');
  const env = { SMS_MODE: 'preview', ANTHROPIC_MONTHLY_BUDGET_USD: '100', PUBLIC_BASE_URL: 'https://rall-e.ai' }, fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const sms = new Sms(store, env, undefined, fetchImpl);
  meter.ai({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 9_000_000 }, new Map(), 'claude-sonnet-5-5'); // $2 + $10 + $0.90
  meter.ai({ input_tokens: 10_000_000, output_tokens: 1_000_000 }, new Map(), 'claude-haiku-5-5'); // $1 + $0.50
  const card = (await usageReport(sms, env, fetchImpl)).cards.find(c => c.id === 'anthropic');
  assert.equal(card.meter.used, 14.4);
  assert.match(card.facts.join(' '), /Cached input: 45% of input tokens/);
  assert.match(card.facts.join(' '), /By model this month: sonnet-5-5 1 calls ~\$12\.90, haiku-5-5 1 calls ~\$1\.50/);
  store.close();
});

test('demo console roles: the viewer key can only look; the operator key can act; wrong keys are refused', () => {
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'o'.repeat(30), OPS_VIEWER_KEY: 'v'.repeat(30) });
  assert.equal(sms.opsRole('o'.repeat(30), 'a'), 'operator');
  assert.equal(sms.opsRole('v'.repeat(30), 'a'), 'viewer');
  assert.throws(() => sms.opsRole('nope', 'b'), /That key didn’t work/);
  store.close();
});

test('trials: each service card counts down to its trial end, and a Trials card lists them soonest first', async () => {
  const { parseTrials } = await import('../server/usage.mjs');
  assert.deepEqual([...parseTrials('jambase=2026-12-31, Vapi=2027-01-15; bad=soon, =2026-01-01')], [['jambase', '2026-12-31'], ['vapi', '2027-01-15']]);
  const { Store } = await import('../server/store.mjs'), { Sms } = await import('../server/sms.mjs'), { usageReport } = await import('../server/usage.mjs');
  const store = new Store(':memory:'), day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const env = { SMS_MODE: 'preview', PUBLIC_BASE_URL: 'https://rall-e.ai', JAMBASE_KEY: 'jb', SERVICE_TRIALS: `vapi=${day(20)}` };
  const sms = new Sms(store, env, { messages: { create: async () => ({}) } }, async () => ({ ok: false, json: async () => ({}) }));
  const fetchImpl = async url => String(url).includes('jambase') ? { ok: true, status: 200, json: async () => ({ plan: 'Trial', usedCalls: 100, quota: 1000, remainingCalls: 900, periodEnd: `${day(1)}T00:00:00Z` }) } : { ok: false, status: 500, json: async () => ({}) };
  const r = await usageReport(sms, env, fetchImpl);
  const jb = r.cards.find(c => c.id === 'jambase'), trials = r.cards.find(c => c.id === 'trials');
  assert.match(jb.facts[0], /^Trial ends .* \(tomorrow\)$/); assert.equal(jb.status, 'critical'); // 2 days or less: red, and it triggers the demo banner
  assert.match(trials.facts[0], /^JamBase: Trial ends/); assert.match(trials.facts[1], /^vapi: Trial ends .* \(in 20 days\)$/); assert.equal(trials.status, 'critical');
  store.close();
});
