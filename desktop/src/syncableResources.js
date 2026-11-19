// The bounded Phase-1 set of endpoints that work offline (view/add/edit leads, sales
// invoices, segments, country-language map, conversions) — everything else (sending
// WhatsApp/Telegram/email, live Chatwoot conversations, Meta templates, the Sales/ERP live
// pull, Lead Intelligence) is a plain pass-through proxy with no local cache/queue at all,
// because the action itself needs a live third-party call no matter where the app runs.
//
// Each resource names the GET path(s) it's keyed by for caching, and — for a write — which
// resource key(s) it affects so that resource's cache gets invalidated (online) or flagged
// dirty (offline) once the write lands.
const READABLE = [
  { key: 'me', method: 'GET', test: (p) => p === '/api/me' },
  { key: 'contacts', method: 'GET', test: (p) => p === '/whizz-get-contacts' },
  { key: 'salesStored', method: 'GET', test: (p) => p === '/api/sales-invoices/stored' },
  { key: 'salesCustomers', method: 'GET', test: (p) => p === '/api/sales-invoices/customers' },
  { key: 'salesReport', method: 'GET', test: (p) => p === '/api/sales-invoices/report' },
  { key: 'segments', method: 'GET', test: (p) => p === '/api/audience-segments' },
  { key: 'countryLang', method: 'GET', test: (p) => p === '/api/country-language-map' },
];

const WRITABLE = [
  { test: (p, m) => m === 'POST' && p === '/whizz-update-contact', affects: ['contacts'] },
  { test: (p, m) => m === 'POST' && p === '/whizz-delete-contact', affects: ['contacts'] },
  { test: (p, m) => m === 'POST' && p === '/whizz-bulk-delete-contacts', affects: ['contacts'] },
  { test: (p, m) => m === 'POST' && p === '/api/automation/whizz-save-contact', affects: ['contacts'] },
  { test: (p, m) => m === 'POST' && p === '/whizz-mark-conversion', affects: ['contacts'] },
  { test: (p, m) => m === 'POST' && p === '/api/sales-invoices/match', affects: ['salesCustomers', 'salesReport'] },
  { test: (p, m) => m === 'POST' && p === '/api/sales-invoices/import', affects: ['salesStored', 'salesCustomers', 'salesReport'] },
  { test: (p, m) => m === 'POST' && p === '/api/audience-segments', affects: ['segments'] },
  { test: (p, m) => m === 'DELETE' && /^\/api\/audience-segments\/\d+$/.test(p), affects: ['segments'] },
  { test: (p, m) => m === 'POST' && p === '/api/country-language-map', affects: ['countryLang'] },
  { test: (p, m) => m === 'DELETE' && p.startsWith('/api/country-language-map/'), affects: ['countryLang'] },
];

function matchRead(pathname, method) {
  return READABLE.find((r) => r.method === method && r.test(pathname)) || null;
}
function matchWrite(pathname, method) {
  return WRITABLE.find((w) => w.test(pathname, method)) || null;
}

module.exports = { matchRead, matchWrite };
