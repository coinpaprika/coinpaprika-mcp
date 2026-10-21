// keyInfo hands the account's /key/info answer to the model. The model is not the key owner,
// so only fields named here pass, each with the type it is documented to have: the plan, its
// status and start date, and the monthly request counters. Anything else the API adds later,
// such as a key, a customer id or a per-account portal link, is dropped.

const STRING_FIELDS = ['plan', 'plan_status', 'plan_started_at'];
const MAX_STRING = 64;

function safeString(value, apiKey) {
  if (typeof value !== 'string' || value.length > MAX_STRING) return undefined;
  if (apiKey && value.includes(apiKey)) return undefined;
  return value;
}

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function pickKeyInfo(body, apiKey) {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const field of STRING_FIELDS) {
    const v = safeString(body[field], apiKey);
    if (v !== undefined) out[field] = v;
  }
  const usage = body.usage;
  if (usage && typeof usage === 'object') {
    const picked = {};
    const message = safeString(usage.message, apiKey);
    if (message !== undefined) picked.message = message;
    const month = usage.current_month;
    if (month && typeof month === 'object') {
      const counters = {};
      for (const field of ['requests_made', 'requests_left']) {
        const v = safeNumber(month[field]);
        if (v !== undefined) counters[field] = v;
      }
      picked.current_month = counters;
    }
    out.usage = picked;
  }
  return out;
}
