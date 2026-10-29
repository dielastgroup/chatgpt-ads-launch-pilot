import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { ATTRIBUTION_FIELDS, BUDGETS, UNAVAILABLE, captureAttribution, mountLeadForm, postLead, validEndpoint, validateLead } from '../lead-intake.js';
import { LEAD_ENDPOINT } from '../lead-config.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const endpoint = 'https://receiver.example.test/intelz-applications';
const receipt = { ok: true, lead_id: 'test-lead-1', received_at: '2026-10-29T18:00:00.000Z' };
const validLead = { company: 'Example Business', email: 'owner@example.test', budget: BUDGETS[1], consent: true };
const response = (body = receipt, status = 200) => ({ ok: status >= 200 && status < 300, json: async () => body });
const conversions = win => win.dataLayer.filter(item => item.event === 'verified_lead_submitted');

function fixture({ configuredEndpoint = endpoint, fetchImpl = async () => response(), query = '', referrer } = {}) {
  const dom = new JSDOM(html, { url: `https://dielastgroup.github.io/chatgpt-ads-launch-pilot/${query}`, ...(referrer ? { referrer } : {}) });
  const win = dom.window;
  const doc = win.document;
  const form = doc.getElementById('lead');
  const status = doc.getElementById('status');
  mountLeadForm({ form, status, endpoint: configuredEndpoint, win, doc, fetchImpl });
  const field = name => form.elements.namedItem(name);
  const fill = () => {
    for (const [name, value] of Object.entries(validLead)) {
      if (name === 'consent') field(name).checked = value;
      else field(name).value = value;
    }
  };
  const submit = () => form.dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  return { dom, win, doc, form, status, field, fill, submit };
}

async function until(predicate) {
  for (let i = 0; i < 30; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Expected state was not reached');
}

test('requires company, valid email, an allowed budget and unchecked-by-default consent', () => {
  assert.equal(validateLead(validLead), '');
  for (const bad of [
    { company: '' }, { company: '   ' }, { company: 'x'.repeat(101) },
    { email: '' }, { email: 'bad-email' }, { email: 'a@b' }, { email: `${'x'.repeat(250)}@example.test` },
    { budget: '' }, { budget: 'invented' }, { consent: false }, { consent: 'true' },
  ]) assert.notEqual(validateLead({ ...validLead, ...bad }), '');
  const f = fixture();
  assert.equal(f.field('consent').checked, false);
  for (const name of ['company', 'email', 'budget', 'consent']) assert.equal(f.field(name).required, true);
  assert.equal(f.form.checkValidity(), false);
  f.fill();
  assert.equal(f.form.checkValidity(), true);
  f.dom.window.close();
});

test('invalid fields and missing consent never POST or count a lead', () => {
  let calls = 0;
  const f = fixture({ fetchImpl: async () => { calls++; return response(); } });
  for (const [name, value] of [['company', '   '], ['email', 'not-email'], ['budget', ''], ['consent', false]]) {
    f.fill();
    if (name === 'consent') f.field(name).checked = value;
    else f.field(name).value = value;
    f.submit();
    assert.equal(f.status.dataset.state, 'error');
  }
  assert.equal(calls, 0);
  assert.equal(conversions(f.win).length, 0);
  f.dom.window.close();
});

test('captures all campaign fields, source and clean page path', () => {
  const data = captureAttribution('https://example.test/pilot/?utm_source=chatgpt&utm_medium=paid&utm_campaign=pilot&utm_term=founders&utm_content=ad-a&oppref=partner&email=private@example.test#apply', 'https://search.example.test/results?email=private@example.test');
  assert.deepEqual(data, { utm_source: 'chatgpt', utm_medium: 'paid', utm_campaign: 'pilot', utm_term: 'founders', utm_content: 'ad-a', oppref: 'partner', source: 'chatgpt', page_url: 'https://example.test/pilot/', referrer: 'https://search.example.test' });
  assert.equal(JSON.stringify(data).includes('private'), false);
});

test('attribution uses referrer or direct when UTMs are absent and bounds campaign values', () => {
  assert.equal(captureAttribution('https://example.test/').source, 'direct');
  assert.equal(captureAttribution('https://example.test/', 'https://referrer.example.test/path').source, 'https://referrer.example.test');
  assert.equal(captureAttribution(`https://example.test/?utm_content=${'a'.repeat(500)}`).utm_content.length, 200);
});

test('requires a public HTTPS endpoint without embedded credentials or fragments', () => {
  assert.equal(validEndpoint(endpoint), true);
  for (const value of ['', 'placeholder', '/submit', 'http://example.test', 'mailto:owner@example.test', 'https://user:pass@example.test', 'https://example.test/#fragment']) assert.equal(validEndpoint(value), false);
});

test('empty config and no-JavaScript markup fail closed with an explicit fallback', () => {
  assert.equal(LEAD_ENDPOINT, '');
  const raw = new JSDOM(html);
  assert.equal(raw.window.document.querySelector('fieldset').disabled, true);
  assert.equal(raw.window.document.getElementById('status').textContent, UNAVAILABLE);
  assert.equal(raw.window.document.querySelector('#lead').hasAttribute('action'), false);
  raw.window.close();
  for (const configuredEndpoint of ['', 'bad-url', 'http://example.test/']) {
    let calls = 0;
    const f = fixture({ configuredEndpoint, fetchImpl: async () => { calls++; return response(); } });
    f.fill();
    f.submit();
    assert.equal(f.status.textContent, UNAVAILABLE);
    assert.equal(f.form.querySelector('fieldset').disabled, true);
    assert.equal(calls, 0);
    assert.equal(conversions(f.win).length, 0);
    f.dom.window.close();
  }
});

test('POST uses JSON, CORS and no credentials; accepts a persisted receipt', async () => {
  let request;
  const actual = await postLead(endpoint, validLead, async (url, options) => { request = { url, options }; return response(); });
  assert.equal(actual, receipt);
  assert.equal(request.url, endpoint);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.mode, 'cors');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), validLead);
});

for (const [label, fetchImpl] of [
  ['HTTP 400', async () => response({}, 400)],
  ['HTTP 500', async () => response({}, 500)],
  ['application rejection in 200', async () => response({ ...receipt, ok: false })],
  ['missing lead ID', async () => response({ ...receipt, lead_id: '' })],
  ['missing server timestamp', async () => response({ ...receipt, received_at: undefined })],
  ['invalid server timestamp', async () => response({ ...receipt, received_at: 'today' })],
  ['HTML instead of JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('HTML'); } })],
  ['network or CORS failure', async () => { throw new TypeError('Failed to fetch'); }],
]) test(`${label} shows a retryable error and never fires conversion`, async () => {
  const f = fixture({ fetchImpl });
  f.fill();
  f.submit();
  await until(() => f.status.dataset.state === 'error');
  assert.equal(f.form.querySelector('fieldset').disabled, false);
  assert.equal(f.field('email').value, validLead.email);
  assert.match(f.status.textContent, /could not confirm receipt/);
  assert.equal(conversions(f.win).length, 0);
  f.dom.window.close();
});

test('a stalled request times out instead of remaining pending forever', async () => {
  const fetchImpl = (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(postLead(endpoint, validLead, fetchImpl, 5), /aborted/);
});

test('success posts contact, consent, timestamp and hidden attribution, then fires once', async () => {
  let resolveFetch;
  const requests = [];
  const f = fixture({ query: '?utm_source=chatgpt&utm_medium=paid&utm_campaign=qa&utm_term=founders&utm_content=ad-b&oppref=owner', fetchImpl: (url, options) => { requests.push({ url, options }); return new Promise(resolve => { resolveFetch = resolve; }); } });
  f.fill();
  for (const key of [...ATTRIBUTION_FIELDS, 'source', 'page_url', 'referrer']) assert.equal(f.field(key).type, 'hidden');
  assert.equal(f.field('utm_term').value, 'founders');
  assert.equal(f.field('source').value, 'chatgpt');
  f.submit();
  f.submit();
  assert.equal(f.status.dataset.state, 'pending');
  assert.equal(f.form.getAttribute('aria-busy'), 'true');
  assert.equal(requests.length, 1);
  assert.equal(conversions(f.win).length, 0);
  const payload = JSON.parse(requests[0].options.body);
  for (const [key, value] of Object.entries(validLead)) assert.equal(payload[key], value);
  assert.equal(payload.utm_campaign, 'qa');
  assert.equal(payload.utm_term, 'founders');
  assert.equal(payload.utm_content, 'ad-b');
  assert.equal(payload.oppref, 'owner');
  assert.equal(payload.page_url, 'https://dielastgroup.github.io/chatgpt-ads-launch-pilot/');
  assert.ok(Number.isFinite(Date.parse(payload.submitted_at)));
  assert.ok(payload.submission_id);
  assert.equal(payload.consent_version, 'application-contact-v1');
  assert.equal(payload.consent_text, f.form.querySelector('[data-consent-text]').textContent);
  resolveFetch(response());
  await until(() => f.status.dataset.state === 'success');
  assert.equal(f.form.querySelector('fieldset').disabled, true);
  assert.equal(f.form.hasAttribute('aria-busy'), false);
  assert.equal(conversions(f.win).length, 1);
  assert.equal(conversions(f.win)[0].utm_campaign, 'qa');
  assert.equal(JSON.stringify(f.win.dataLayer).includes(validLead.email), false);
  assert.equal(JSON.stringify(f.win.dataLayer).includes(validLead.company), false);
  f.submit();
  assert.equal(requests.length, 1);
  assert.equal(conversions(f.win).length, 1);
  f.dom.window.close();
});

test('retry keeps contact details and reuses the submission ID for receiver deduplication', async () => {
  const payloads = [];
  const f = fixture({ fetchImpl: async (_, options) => { payloads.push(JSON.parse(options.body)); return response(payloads.length === 1 ? {} : receipt, payloads.length === 1 ? 503 : 200); } });
  f.fill();
  f.submit();
  await until(() => f.status.dataset.state === 'error');
  f.submit();
  await until(() => f.status.dataset.state === 'success');
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].submission_id, payloads[1].submission_id);
  assert.deepEqual(payloads[0], payloads[1]);
  assert.equal(payloads[1].email, validLead.email);
  assert.equal(conversions(f.win).length, 1);
  f.dom.window.close();
});

test('analytics failure cannot turn a received application into an error', async () => {
  const f = fixture();
  f.win.dataLayer.push = () => { throw new Error('Analytics unavailable'); };
  f.fill();
  f.submit();
  await until(() => f.status.dataset.state === 'success');
  assert.equal(f.form.querySelector('fieldset').disabled, true);
  f.dom.window.close();
});

test('edited application after an uncertain response gets a new deduplication ID', async () => {
  const stored = new Map();
  const payloads = [];
  const f = fixture({ fetchImpl: async (_, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    if (!stored.has(payload.submission_id)) stored.set(payload.submission_id, payload);
    if (payloads.length === 1) throw new TypeError('Response lost after storage');
    return response();
  } });
  f.fill();
  f.submit();
  await until(() => f.status.dataset.state === 'error');
  f.field('email').value = 'corrected@example.test';
  f.submit();
  await until(() => f.status.dataset.state === 'success');
  assert.notEqual(payloads[0].submission_id, payloads[1].submission_id);
  assert.equal(stored.get(payloads[1].submission_id).email, 'corrected@example.test');
  assert.equal(conversions(f.win).length, 1);
  f.dom.window.close();
});

test('keeps the six offer bullets, price and separate-media-budget wording unchanged', () => {
  const dom = new JSDOM(html);
  assert.deepEqual([...dom.window.document.querySelectorAll('#offer li')].map(li => li.textContent), [
    'Campaign setup and context targeting', 'Three creative variants', 'One landing-page conversion improvement',
    'Click and lead attribution setup', '14-day optimization and scorecard', 'Your business retains account and budget control',
  ]);
  assert.equal(dom.window.document.querySelector('.price').textContent, '$2,500');
  assert.ok(html.includes('One-time service fee. Advertising budget is separate.'));
  assert.ok(html.includes('Your company owns the ad account and pays media spend directly. No sales or ROI guarantees.'));
  assert.ok(html.includes('No. You control and fund your own approved media budget. Promotional credit eligibility is determined by OpenAI.'));
  assert.ok(html.includes('type="module" src="./lead-page.js"'));
  assert.equal(html.includes('mailto:'), false);
  dom.window.close();
});
