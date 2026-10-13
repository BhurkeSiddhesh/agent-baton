import path from 'node:path';
import { BatonError } from '../lib/errors.js';
import { parseTime, readJson, stamp, utcnow, writeJsonAtomic } from '../lib/util.js';
import { stateDir } from '../lib/store.js';
import { digestLines, digestModel } from '../lib/views.js';

export const name = 'digest';
export const group = 'Planning';
export const summary = 'What changed since the last digest, plus what needs attention';
export const usage = 'baton digest [--since <iso|last|all>] [--no-mark] [--json]';
export const description = [
  'The orchestrator\'s day-open and day-close report. "--since last" (the default) covers events after the previous digest;',
  'the position is remembered in the local state directory. An explicit --since <iso> never moves the marker.',
].join('\n');
export const options = {
  since: { type: 'string', description: 'ISO timestamp, "last" (default) or "all"' },
  mark: { type: 'boolean', default: true, description: 'remember this digest as the new "last" (use --no-mark to peek)' },
  json: { type: 'boolean' },
};

const markerFile = (root) => path.join(stateDir(root), 'digest.json');

export async function run(ctx, args) {
  const loaded = ctx.loadState();
  const now = utcnow();
  const mode = args.since === undefined || args.since === 'last' ? 'last' : args.since === 'all' ? 'all' : 'time';
  let events = loaded.events;
  let since = null;
  if (mode === 'last') {
    const marker = readJson(markerFile(ctx.root), null);
    if (marker?.event) { events = events.filter((e) => e.id > marker.event); since = { ts: marker.ts, event: marker.event }; }
  } else if (mode === 'time') {
    const t = parseTime(args.since);
    if (!t) throw new BatonError(`--since expects an ISO timestamp, "last" or "all"; got "${args.since}"`, { code: 'BAD_SINCE' });
    events = events.filter((e) => parseTime(e.ts) > t);
    since = { ts: stamp(t), event: null };
  }
  const model = digestModel(loaded, events, { since, now });
  if (mode === 'last' && args.mark) {
    const last = loaded.events[loaded.events.length - 1];
    writeJsonAtomic(markerFile(ctx.root), { ts: stamp(now), event: last?.id ?? since?.event ?? null });
  }
  if (args.json) ctx.json(model);
  else ctx.out(digestLines(model).join('\n'));
  return 0;
}
