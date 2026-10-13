import { makePainter, renderTable, scoreRows, SCORE_COLUMNS } from '../lib/views.js';

export const name = 'scores';
export const group = 'Planning';
export const summary = 'Scoreboard per agent, derived from the ledger';
export const usage = 'baton scores [--json]';
export const description = 'Started, ready, accepted, rejected, rework, first-pass rate, reviews given, findings filed and findings against each agent.';
export const options = { json: { type: 'boolean' } };

export async function run(ctx, args) {
  const { config, plan, events } = ctx.loadState();
  const rows = scoreRows(plan, events, config);
  if (args.json) ctx.json({ agents: Object.fromEntries(rows.map(({ agent, ...rest }) => [agent, rest])) });
  else ctx.out(renderTable(rows, SCORE_COLUMNS, makePainter(ctx.env)).join('\n'));
  return 0;
}
