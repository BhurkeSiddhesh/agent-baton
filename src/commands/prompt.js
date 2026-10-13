import path from 'node:path';
import { UsageError } from '../lib/errors.js';
import { render } from '../lib/template.js';
import { PROMPT_NAMES, buildPromptVars, loadPromptTemplate } from '../lib/views.js';

export const name = 'prompt';
export const group = 'Planning';
export const summary = 'Print a role prompt with project variables filled in';
export const usage = `baton prompt <${PROMPT_NAMES.join('|')}> [--agent <id>] [goal]`;
export const description = 'For agents without native slash commands: paste or pipe the output into the agent. "split" accepts the goal as extra words.';
export const examples = ['baton prompt worker --agent codex', 'baton prompt split "Ship invoice export"'];
export const options = {
  agent: { type: 'string', alias: 'a', description: 'agent the prompt is for' },
  json: { type: 'boolean' },
};

export async function run(ctx, args) {
  const [role, ...rest] = args._;
  if (!role) throw new UsageError(`prompt needs a role: ${PROMPT_NAMES.join('|')}`);
  if (!PROMPT_NAMES.includes(role)) throw new UsageError(`unknown prompt "${role}" (one of ${PROMPT_NAMES.join(', ')})`);
  const loaded = ctx.loadState();
  const agent = ctx.agent(args.agent, { required: false });
  const tpl = loadPromptTemplate(role, ctx.env);
  const vars = buildPromptVars({ root: ctx.root, ...loaded, env: ctx.env }, { role, agent, goal: rest.join(' ').trim() });
  const text = render(tpl.text, vars, { partialsDir: path.join(tpl.dir, 'partials') });
  if (args.json) ctx.json({ role, agent, prompt: text });
  else ctx.out(text);
  return 0;
}
