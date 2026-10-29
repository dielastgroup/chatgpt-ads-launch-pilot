# Application intake setup

Status: implementation ready for review; receiver not connected. `main` and the live GitHub Pages site are unchanged by this PR. No real application has been submitted during development.

## One configuration value

In `lead-config.js`, set **`LEAD_ENDPOINT`** to the full, owned, public **HTTPS POST URL for Intelz sprint applications**. The exact compatible URL was not found, so the committed value is intentionally empty. Do not put an API key, password, bearer token, or private/admin URL in this public file.

The existing Intelz newsletter form is linked from [intelz.com](https://intelz.com/). It collects newsletter email addresses; it has not been verified to accept this application's company, budget, consent and attribution fields or return the receipt below. Do not paste its hosted signup URL, a Brevo list ID, the Brevo authenticated contacts API, or a Google Forms view URL into this config. A compatible existing receiver or server-side adapter is required. This PR creates no receiver, account or automation.

With the value empty or invalid, the form is disabled and displays: “Applications are temporarily unavailable. No information is being collected or sent. Please return later to apply.” This is also the default HTML state if JavaScript fails or is disabled.

## Receiver contract

The receiver must allow cross-origin JSON POSTs from the GitHub Pages origin, answer OPTIONS/preflight for `Content-Type: application/json`, and include the matching `Access-Control-Allow-Origin` on POST responses, including errors. Requests omit cookies/credentials. Redirects are rejected; `no-cors` is never used.

POST body fields:

| Fields | Meaning |
| --- | --- |
| `company`, `email`, `budget` | Required contact details and one of the four on-page spend ranges |
| `consent` | Boolean `true`; required, unchecked by default |
| `consent_text`, `consent_version` | Exact accepted contact permission and `application-contact-v1` |
| `submitted_at`, `submission_id` | Browser UTC ISO time and UUID; browser time is not authoritative |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `oppref` | Initial page campaign fields, also populated into hidden inputs |
| `source` | UTM source, otherwise referrer origin, otherwise `direct` |
| `page_url`, `referrer` | Page origin/path and referrer origin; omit other query values and fragments |

Validate fields and consent again on the server. Apply abuse/rate controls, store the complete application and consent evidence, record a **server** timestamp, and deduplicate retries by `submission_id` before acknowledging. Return the original receipt for an already persisted ID. Do not add these applicants to a newsletter automatically. Provider credentials stay server-side.

After durable storage, return a 2xx JSON response:

```json
{"ok":true,"lead_id":"your-stored-record-id","received_at":"2026-10-29T18:00:00.000Z"}
```

Return non-2xx on failure; do not acknowledge a merely queued job as a stored lead. A 2xx without the above receipt, HTML, redirects, network/CORS errors or a 15-second timeout show an error, preserve the typed details and fire no conversion. Retrying identical application details within the page reuses the submission ID and original browser timestamp. Editing company, email, budget or consent text creates a new application ID. This cannot amend or erase a prior request that may already have been stored before its response was lost; the receiver may contain both versions. Reloading creates a new ID. The page cannot prove storage if the receiver falsely acknowledges it; verify the destination record below.

Only a confirmed receipt fires `verified_lead_submitted` once. Existing `landing_view` and CTA events remain non-conversion events. Contact details and consent are excluded from the dataLayer. There is still no external analytics destination configured.

## Verify one real submission after configuration and publication are approved

1. Set the single config value and run `npm ci` followed by `npm test`. Review/merge this PR separately; this change has not been merged or published.
2. Open the GitHub Pages page with `?utm_source=manual_qa&utm_medium=owned&utm_campaign=intelz_intake_check&utm_term=founder&utm_content=real_submission`. Use an email you own and a unique company label such as `Intelz QA YYYYMMDD-HHMM`.
3. Check consent, submit once and wait for “Application received.” In the browser Network panel confirm POST, a 2xx JSON receipt, a nonempty `lead_id` and a UTC `received_at`. There must be exactly one `verified_lead_submitted` in `window.dataLayer`, after the response, containing no contact fields.
4. Open the receiver's destination list/table/CRM. Find that **exact lead ID** and verify company, email, budget, contact consent/text/version, `submitted_at`, **server received timestamp**, `source=manual_qa`, all UTM fields and page path. Record the record URL/ID and timestamp as evidence. A UI success or notification email alone is insufficient.
5. At phone width, test missing consent and invalid email: no POST. Temporarily simulate offline or block the POST in developer tools: clear error, retained fields and no conversion. Restore connectivity and retry; confirm one stored record for the submission ID. No paid traffic until this receipt check passes.

## Automated verification

Requires Node 20+; `npm ci` installs the pinned test-only jsdom dependency. `npm test` runs real form markup through jsdom plus request/response unit tests; all network responses are local test doubles. Tests cover validation, consent, disabled/no-JavaScript fallback, success acknowledgement, server/application/network errors, timeout, retries/deduplication ID, hidden attribution, contact-free analytics and unchanged offer copy. These are automated DOM tests, not a real-provider receipt or full-browser/device certification.

Decision: supply an existing compatible application receiver URL, or authorize adapting the existing Intelz intake infrastructure to this contract. Until then, keep the config empty and the fallback visible.
