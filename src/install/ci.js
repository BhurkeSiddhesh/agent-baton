/** Helpers for the optional files written by `init --cloud`, `--hooks` and `--docs` (the file list itself lives in templates/adapters.json `extras`). */

/** The @claude workflow only makes sense when the roster has a claude agent. */
export function extraApplies(spec, config) {
  if (/baton-claude\.ya?ml$/.test(spec.dest)) return (config.agents || []).some((a) => a.kind === 'claude');
  return true;
}

/** Used when templates/hooks/claude-settings.json is missing. `{{cli}}` is rendered by the installer. */
export const FALLBACK_HOOKS_SNIPPET = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: '{{cli}} guard --hook claude' }] }] },
});

/**
 * Named post-render steps from adapters.json `postprocessors`. The built-in `github-expressions` turns `$[[ expr ]]` into
 * `${{ expr }}` (templates cannot contain double braces).
 */
export function postprocess(text, name, defs = {}) {
  const def = defs[name];
  if (def && def.pattern) return text.replace(new RegExp(def.pattern, 'g'), def.replacement ?? '');
  if (name === 'github-expressions') return text.replace(/\$\[\[([\s\S]*?)\]\]/g, (_, expr) => `\${{${expr}}}`);
  return text;
}
