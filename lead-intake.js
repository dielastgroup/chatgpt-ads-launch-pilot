export const ATTRIBUTION_FIELDS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'oppref',
];
export const BUDGETS = ['$0–$2,500', '$2,500–$10,000', '$10,000–$50,000', '$50,000+'];
export const UNAVAILABLE = 'Applications are temporarily unavailable. No information is being collected or sent. Please return later to apply.';

export function validEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function captureAttribution(href, referrer = '') {
  const url = new URL(href);
  // Keep only the path and approved campaign fields; other query values may contain personal data.
  const fields = Object.fromEntries(ATTRIBUTION_FIELDS.map(key => [key, (url.searchParams.get(key) || '').slice(0, 200)]));
  let referrerOrigin = '';
  try { referrerOrigin = new URL(referrer).origin; } catch { /* Direct visit. */ }
  return { ...fields, source: fields.utm_source || referrerOrigin || 'direct',
    page_url: url.origin + url.pathname, referrer: referrerOrigin };
}

export function validateLead(lead) {
  if (!lead.company?.trim() || lead.company.trim().length > 100) return 'Enter your company name (up to 100 characters).';
  if (!lead.email?.trim() || lead.email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email.trim())) return 'Enter a valid work email address.';
  if (!BUDGETS.includes(lead.budget)) return 'Choose your current monthly ad spend.';
  if (lead.consent !== true) return 'Please consent to being contacted about your application.';
  return '';
}

export async function postLead(endpoint, payload, fetchImpl = globalThis.fetch, timeoutMs = 15000) {
  if (!validEndpoint(endpoint)) throw new Error('Intake unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal,
    });
    if (!response.ok) throw new Error('Receipt not confirmed');
    const receipt = await response.json();
    // A generic 200 page, queued request, or newsletter redirect is not an application receipt.
    if (receipt?.ok !== true || typeof receipt.lead_id !== 'string' || !receipt.lead_id.trim()
      || typeof receipt.received_at !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(receipt.received_at)
      || !Number.isFinite(Date.parse(receipt.received_at))) throw new Error('Invalid receipt');
    return receipt;
  } finally {
    clearTimeout(timer);
  }
}

export function mountLeadForm({ form, status, endpoint, win = window, doc = document, fetchImpl = win.fetch.bind(win) }) {
  const fields = form.querySelector('fieldset');
  const button = form.querySelector('button[type="submit"]');
  const attribution = captureAttribution(win.location.href, doc.referrer);
  for (const [key, value] of Object.entries(attribution)) form.elements.namedItem(key).value = value;
  const analytics = () => ({ source: attribution.source, ...Object.fromEntries(ATTRIBUTION_FIELDS.map(key => [key, attribution[key]])) });
  const track = event => {
    // Analytics failure must never turn an acknowledged application into an apparent error.
    try { (win.dataLayer = win.dataLayer || []).push({ event, ...analytics() }); } catch { /* Intake still succeeds. */ }
  };
  track('landing_view');
  doc.querySelectorAll('[data-event]').forEach(link => link.addEventListener('click', () => track(link.dataset.event)));
  const available = validEndpoint(endpoint);
  let pending = false;
  let completed = false;
  const submissionId = win.crypto.randomUUID();
  fields.disabled = !available;
  status.dataset.state = available ? 'ready' : 'unavailable';
  status.textContent = available ? 'Submit your application securely. We will contact you about the sprint; this does not subscribe you to a newsletter.' : UNAVAILABLE;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || completed) return;
    if (!available) { status.textContent = UNAVAILABLE; return; }
    const lead = { company: form.elements.namedItem('company').value.trim(), email: form.elements.namedItem('email').value.trim(),
      budget: form.elements.namedItem('budget').value, consent: form.elements.namedItem('consent').checked };
    const error = validateLead(lead);
    if (error || !form.checkValidity()) {
      status.dataset.state = 'error';
      status.textContent = error || 'Please complete the required fields.';
      form.reportValidity();
      return;
    }
    const payload = { ...lead, ...attribution, submission_id: submissionId,
      submitted_at: new Date().toISOString(), consent_version: 'application-contact-v1',
      consent_text: form.querySelector('[data-consent-text]').textContent.trim() };
    pending = true;
    fields.disabled = true;
    form.setAttribute('aria-busy', 'true');
    button.textContent = 'Sending application…';
    status.dataset.state = 'pending';
    status.textContent = 'Sending your application. Please wait for confirmation.';
    let receipt;
    try {
      receipt = await postLead(endpoint, payload, fetchImpl);
    } catch {
      fields.disabled = false;
      button.textContent = 'Retry application →';
      status.dataset.state = 'error';
      status.textContent = 'We could not confirm receipt. Your details are still here. Please retry. If you already received confirmation, do not resubmit.';
    } finally {
      pending = false;
      form.removeAttribute('aria-busy');
    }
    if (receipt) {
      completed = true;
      button.textContent = 'Application received';
      status.dataset.state = 'success';
      status.textContent = 'Application received. Thank you — we will contact you about the sprint.';
      track('verified_lead_submitted');
    }
  });
}
