/**
 * Execution identity provenance and session tracking.
 * Differentiates verified GitHub Actions runner identity from unauthenticated local claims.
 */

/**
 * Detect runtime execution provenance and session tracking.
 * @param {Record<string,string|undefined>} [env]
 * @returns {{session: string, trust: 'github-verified'|'ci-environment'|'local-unverified', runner: string, adapter: string, gh?: object}}
 */
export function resolveExecutionProvenance(env = process.env) {
  const isGitHub = env?.GITHUB_ACTIONS === 'true';
  const isCI = isGitHub || env?.CI === 'true' || env?.CONTINUOUS_INTEGRATION === 'true';

  let trust = 'local-unverified';
  let runner = 'local';
  const adapter = env?.BATON_ADAPTER || 'cli';

  if (isGitHub) {
    trust = 'github-verified';
    runner = 'github-actions';
  } else if (isCI) {
    trust = 'ci-environment';
    runner = 'ci';
  }

  const session = env?.BATON_SESSION_ID
    || (isGitHub && env?.GITHUB_RUN_ID ? `gh-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || 1}` : null)
    || `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const prov = {
    session,
    trust,
    runner,
    adapter,
  };

  if (isGitHub) {
    prov.gh = {
      actor: env.GITHUB_ACTOR || null,
      workflow: env.GITHUB_WORKFLOW || null,
      job: env.GITHUB_JOB || null,
      runId: env.GITHUB_RUN_ID || null,
      sha: env.GITHUB_SHA || null,
      ref: env.GITHUB_REF || null,
    };
  }

  return prov;
}
