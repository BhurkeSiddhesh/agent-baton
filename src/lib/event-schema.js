export const LEDGER_VERSION = 1;
export const MIN_LEDGER_VERSION = 0;
export const EVENT_KINDS = ['begin', 'heartbeat', 'reclaim', 'status', 'ready', 'verdict', 'reviewer', 'handoff', 'verify', 'merged',
  'finding', 'finding_resolved', 'message', 'gate', 'plan', 'init', 'ack'];
export const EVENT_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

const packetKinds = new Set(['begin', 'heartbeat', 'reclaim', 'status', 'ready', 'verdict', 'reviewer', 'handoff', 'verify', 'merged', 'finding', 'finding_resolved']);
const transitionKinds = new Set(['begin', 'reclaim', 'status', 'ready', 'verdict']);
const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string';
const optionalString = (value) => value == null || string(value);
const optionalBoolean = (value) => value == null || typeof value === 'boolean';
const optionalNumber = (value) => value == null || (typeof value === 'number' && Number.isFinite(value));

const dataRules = {
  begin: { base: optionalString, lease_until: optionalString, dep_commits: (v) => v == null || isObject(v), expected_rev: (v) => v == null || (Number.isInteger(v) && v >= 0), lease_token: optionalNumber },
  heartbeat: { lease_until: string, lease_token: optionalNumber },
  reclaim: { lease_until: optionalString, from: optionalString },
  ready: { commit: optionalString, tests: optionalString },
  verdict: { commit: optionalString, score: optionalNumber },
  reviewer: { reviewer: string },
  handoff: { agent: string, from: optionalString },
  verify: { ok: (v) => typeof v === 'boolean', commit: optionalString, mode: optionalString, lease_token: optionalNumber },
  merged: { commit: string, branch: optionalString },
  finding: { fid: string, severity: string, file: optionalString, line: optionalNumber, evidence: optionalString, fix: optionalString, against: optionalString },
  finding_resolved: { fid: string, resolution: string, confirm: optionalBoolean },
  message: { type: string, to: string, text: string },
  gate: { gate: string, open: (v) => typeof v === 'boolean' },
  plan: { hash: string },
  init: { version: optionalString, agents: (v) => v == null || (Array.isArray(v) && v.every(string)) },
  ack: { event: (v) => string(v) && EVENT_ID_RE.test(v) },
};

/** Validate an on-disk event shape. Lifecycle authorization belongs to engine.js. */
export function validateEventSchema(ev, { allowLegacy = true } = {}) {
  const problems = [];
  if (!isObject(ev)) return ['event must be a JSON object'];
  const version = ev.hv ?? 0;
  if (!Number.isInteger(version) || version < 0) problems.push('hv must be a non-negative integer');
  else if (version > LEDGER_VERSION) problems.push(`event format v${version} is newer than supported v${LEDGER_VERSION}`);
  else if (version < MIN_LEDGER_VERSION || (!allowLegacy && version !== LEDGER_VERSION)) problems.push(`event format v${version} is not supported`);
  if (!string(ev.id) || !EVENT_ID_RE.test(ev.id)) problems.push('id must match YYYYMMDDTHHMMSSZ-xxxxxx');
  if (!string(ev.ts) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(ev.ts) || !Number.isFinite(Date.parse(ev.ts))) problems.push('ts must be a UTC ISO timestamp');
  if (!EVENT_KINDS.includes(ev.kind)) problems.push(`unknown event kind ${JSON.stringify(ev.kind)}`);
  if (!(ev.packet == null || string(ev.packet))) problems.push('packet must be a string or null');
  if (!(ev.to == null || string(ev.to))) problems.push('to must be a string or null');
  if (!(ev.by == null || string(ev.by))) problems.push('by must be a string or null');
  if (!string(ev.note)) problems.push('note must be a string');
  if (!isObject(ev.data)) problems.push('data must be an object');
  if (!(ev.rev == null || (Number.isInteger(ev.rev) && ev.rev >= 1))) problems.push('rev must be a positive integer when present');
  if (!(ev.parents == null || (Array.isArray(ev.parents) && new Set(ev.parents).size === ev.parents.length && ev.parents.every((id) => string(id) && EVENT_ID_RE.test(id))))) {
    problems.push('parents must be unique event ids when present');
  }
  if (!string(ev.sha) || !/^[0-9a-f]{64}$/.test(ev.sha)) problems.push('sha must be a lowercase SHA-256 hex digest');
  if (!(ev.op_id == null || string(ev.op_id))) problems.push('op_id must be a string or null');
  if (!(ev.sig == null || (isObject(ev.sig) && string(ev.sig.alg) && string(ev.sig.key) && string(ev.sig.sig)))) {
    problems.push('sig must be an object with alg, key, sig when present');
  }
  if (packetKinds.has(ev.kind) && !string(ev.packet)) problems.push(`${ev.kind}.packet is required`);
  if (transitionKinds.has(ev.kind) && !string(ev.to)) problems.push(`${ev.kind}.to is required`);
  if (!string(ev.by)) problems.push(`${ev.kind || 'event'}.by is required`);
  if (isObject(ev.data) && dataRules[ev.kind]) {
    for (const [field, valid] of Object.entries(dataRules[ev.kind])) {
      if (!valid(ev.data[field])) problems.push(`${ev.kind}.data.${field} has an invalid or missing value`);
    }
  }
  return problems;
}
