import { UsageError } from '../lib/errors.js';
import { postMessage, MESSAGE_TYPES } from '../lib/engine.js';
import { readEvents } from '../lib/store.js';
import { parseTime } from '../lib/util.js';

export const name = 'bus';
export const group = 'Execution';
export const summary = 'Post and read bus messages (claims, requests, notices, verdicts)';
export const usage = [
  'baton bus post --from <agent> [--to all|<agent>] --type NOTICE|REQUEST|QUESTION|BLOCKER --text "..." [--packet <id>]',
  'baton bus list [--since <iso>] [--type T] [--packet <id>] [--json]',
  'baton bus tail [--limit n] [--json]',
].join('\n       ');
export const options = {
  from: { type: 'string', description: 'sender (or BATON_AGENT)' },
  agent: { type: 'string', alias: 'a', description: 'alias of --from' },
  to: { type: 'string', description: 'recipient: all or an agent id', default: 'all' },
  type: { type: 'string', description: 'message type' },
  text: { type: 'string', description: 'message text' },
  packet: { type: 'string', alias: 'p', description: 'packet the message is about' },
  since: { type: 'string', description: 'list: only messages at or after this ISO time' },
  limit: { type: 'number', description: 'tail/list: show at most n (tail default 10)' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

const POSTABLE = ['NOTICE', 'REQUEST', 'QUESTION', 'BLOCKER'];

function messages(root) {
  return readEvents(root).filter((e) => e.kind === 'message').map((e) => ({
    id: e.id, ts: e.ts, from: e.by, to: e.data?.to || 'all', type: e.data?.type || 'NOTICE', packet: e.packet || null, text: e.data?.text || '',
  }));
}

const line = (m) => `${m.ts} [${m.type}] ${m.from} -> ${m.to}${m.packet ? ` (${m.packet})` : ''}: ${m.text}`;

export async function run(ctx, args) {
  const sub = args._[0];
  if (sub === 'post') {
    const from = ctx.agent(args.from || args.agent);
    const type = String(args.type || '').toUpperCase();
    if (!POSTABLE.includes(type)) throw new UsageError(`--type must be one of ${POSTABLE.join('|')} (claims, releases, sign-offs and verdicts are posted automatically)`);
    if (!MESSAGE_TYPES.includes(type)) throw new UsageError(`unknown type ${type}`);
    const ev = postMessage(ctx.root, { from, to: args.to || 'all', type, text: args.text, packet: args.packet || null });
    if (args.json) ctx.json({ id: ev.id, ts: ev.ts, from, to: args.to || 'all', type, packet: args.packet || null, text: args.text });
    else ctx.out(`posted ${type} ${ev.id}`);
    return 0;
  }
  if (sub === 'list' || sub === 'tail') {
    let list = messages(ctx.root);
    if (args.since) {
      const t = parseTime(args.since);
      if (!t) throw new UsageError(`--since must be an ISO timestamp, got "${args.since}"`);
      list = list.filter((m) => parseTime(m.ts) >= t);
    }
    if (args.type) list = list.filter((m) => m.type === String(args.type).toUpperCase());
    if (args.packet) list = list.filter((m) => m.packet === args.packet);
    const limit = args.limit ?? (sub === 'tail' ? 10 : 0);
    if (limit > 0) list = list.slice(-limit);
    if (args.json) ctx.json({ messages: list, count: list.length });
    else if (!list.length) ctx.out('no messages');
    else for (const m of list) ctx.out(line(m));
    return 0;
  }
  throw new UsageError(`usage:\n       ${usage}`);
}
