import { UsageError } from '../lib/errors.js';
import { addFinding, resolveFinding, findingsOf, postMessage, SEVERITIES, RESOLUTIONS } from '../lib/engine.js';

export const name = 'finding';
export const group = 'Execution';
export const summary = 'File, list and resolve audit findings';
export const usage = [
  'baton finding add --packet <id> --by <auditor> --severity BLOCKER|MAJOR|MINOR --text "..." [--file f --line n --evidence "..." --fix "..."]',
  'baton finding list [--packet <id>] [--open] [--json]',
  'baton finding resolve <FID> --by <agent> --resolution fixed|wontfix|invalid [--note "..."]   (the filer closes it with --confirm)',
].join('\n       ');
export const options = {
  packet: { type: 'string', alias: 'p', description: 'packet id' },
  by: { type: 'string', description: 'acting agent (or BATON_AGENT)' },
  agent: { type: 'string', alias: 'a', description: 'alias of --by' },
  severity: { type: 'string', description: 'BLOCKER | MAJOR | MINOR' },
  text: { type: 'string', description: 'what is wrong' },
  file: { type: 'string', description: 'file the finding is about' },
  line: { type: 'number', description: 'line number' },
  evidence: { type: 'string', description: 'failing command, output or file:line proof' },
  fix: { type: 'string', description: 'suggested fix' },
  open: { type: 'boolean', description: 'list: only findings that are not closed' },
  resolution: { type: 'string', description: 'resolve: fixed | wontfix | invalid' },
  note: { type: 'string', description: 'resolve: note' },
  confirm: { type: 'boolean', description: 'resolve: the filer confirms a resolved finding (closes it)' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

function row(f) {
  const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : '';
  return `${f.fid} ${f.severity} ${f.status}${f.resolution ? `(${f.resolution})` : ''} ${f.packet}${where} by ${f.by} against ${f.against || 'n/a'}: ${f.text}`;
}

export async function run(ctx, args) {
  const sub = args._[0];
  if (sub === 'add') {
    if (!args.packet) throw new UsageError(`missing --packet. Usage: ${usage}`);
    const by = ctx.agent(args.by || args.agent);
    const severity = String(args.severity || '').toUpperCase();
    if (!SEVERITIES.includes(severity)) throw new UsageError(`--severity must be one of ${SEVERITIES.join('|')}`);
    const { fid } = addFinding(ctx.root, {
      packet: args.packet, by, severity, text: args.text, file: args.file || '', line: args.line || 0,
      evidence: args.evidence || '', fix: args.fix || '',
    });
    const f = findingsOf(ctx.loadState().events).find((x) => x.fid === fid);
    postMessage(ctx.root, { from: by, to: f.against && f.against !== by ? f.against : 'all', type: 'NOTICE', packet: args.packet, text: `${fid} ${severity} filed against ${args.packet}: ${args.text}` });
    if (args.json) ctx.json(f);
    else ctx.out(`filed ${fid} (${severity}) against ${args.packet}`);
    return 0;
  }
  if (sub === 'list') {
    let list = findingsOf(ctx.loadState().events, args.packet || null);
    if (args.open) list = list.filter((f) => f.status !== 'closed');
    if (args.json) ctx.json({ findings: list, count: list.length });
    else if (!list.length) ctx.out('no findings');
    else for (const f of list) ctx.out(row(f));
    return 0;
  }
  if (sub === 'resolve') {
    const fid = args._[1];
    if (!fid) throw new UsageError(`missing finding id. Usage: ${usage}`);
    const by = ctx.agent(args.by || args.agent);
    const resolution = args.resolution ? String(args.resolution).toLowerCase() : undefined;
    if (resolution && !RESOLUTIONS.includes(resolution)) throw new UsageError(`--resolution must be one of ${RESOLUTIONS.join('|')}`);
    const ev = resolveFinding(ctx.root, fid, { by, resolution, confirm: args.confirm, note: args.note || '' });
    const f = findingsOf(ctx.loadState().events).find((x) => x.fid === fid);
    const to = f.by !== by ? f.by : 'all';
    postMessage(ctx.root, { from: by, to, type: 'NOTICE', packet: f.packet, text: `${fid} ${args.confirm ? 'confirmed closed' : `resolved as ${ev.data.resolution}`}${args.note ? `: ${args.note}` : ''}` });
    if (args.json) ctx.json(f);
    else ctx.out(`${fid} is now ${f.status}${f.resolution ? ` (${f.resolution})` : ''}${f.status === 'resolved' ? `; ${f.by} must confirm with "baton finding resolve ${fid} --by ${f.by} --confirm"` : ''}`);
    return 0;
  }
  throw new UsageError(`usage:\n       ${usage}`);
}
