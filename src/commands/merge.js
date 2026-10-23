import { BatonError, UsageError } from '../lib/errors.js';
import { load, postMessage, checkIdentity, readVerifyMarker } from '../lib/engine.js';
import { appendEvent, assertSensitiveReplay, readEvents } from '../lib/store.js';
import { git, gitOk, gitOut, isGit, mainRef, listWorktrees } from '../lib/git.js';
import { getAgent } from '../lib/config.js';
import { isProtected, matchPath, normPath } from '../lib/glob.js';

export const name = 'merge';
export const group = 'Execution';
export const summary = 'Fast-forward main to an ACCEPTED packet commit (never creates merge commits)';
export const usage = 'baton merge <packet> --by <orchestrator> [--hosted] [--json]';
export const description = 'Only ACCEPTED packets whose begin base is in integration history; main must fast-forward to the exact reviewed commit. Unfinished packets may sync and reverify after main advances; accepted packets need a replacement if main advances. Publish ledger events on main after merge.';
export const options = {
  by: { type: 'string', description: 'the orchestrator (or BATON_AGENT)' },
  agent: { type: 'string', alias: 'a', description: 'alias of --by' },
  hosted: { type: 'boolean', description: 'enforce hosted platform CI and review policies' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const root = ctx.root;
  const by = ctx.agent(args.by || args.agent);
  const { config, plan, state } = load(root);
  assertSensitiveReplay(root, { packet: pid, action: 'merge', config });
  checkIdentity(by, ctx.env, config);
  if (by !== config.orchestrator && by !== 'human') throw new BatonError(`only the orchestrator (${config.orchestrator}) or human may merge; got ${by}`, { code: 'NOT_ORCHESTRATOR' });
  const p = plan.packets.find((x) => x.id === pid);
  if (!p) throw new BatonError(`unknown packet ${pid}`, { code: 'UNKNOWN_PACKET' });
  const s = state.packets[pid];
  if (s.status !== 'ACCEPTED') throw new BatonError(`${pid} is ${s.status}; only ACCEPTED packets can be merged`, { code: 'NOT_ACCEPTED' });
  if (!s.commit) throw new BatonError(`${pid} has no recorded commit (shared-tree work); there is nothing to merge`, { code: 'NO_COMMIT' });
  if (!isGit(root)) throw new BatonError('merge needs a git repository', { code: 'NOT_GIT' });
  const main = mainRef(root, config.branches?.main);
  if (!main) throw new BatonError('no main branch found', { code: 'NO_MAIN' });
  if (!gitOk(root, ['cat-file', '-e', `${s.commit}^{commit}`])) throw new BatonError(`commit ${s.commit} is not in this repository`, { code: 'COMMIT_MISSING' });

  // 1. Validate that a packet's accepted commit has valid verification evidence matching exact commit SHA
  const marker = readVerifyMarker(root, pid);
  if (marker) {
    if (marker.ok === false) {
      throw new BatonError(`packet ${pid} verification failed; cannot merge unverified commit`, { code: 'UNVERIFIED_COMMIT' });
    }
    if (marker.commit && marker.commit !== s.commit) {
      throw new BatonError(`commit ${s.commit.slice(0, 8)} does not match verified marker (${marker.commit.slice(0, 8)})`, { code: 'VERIFY_MISMATCH' });
    }
  }

  const events = readEvents(root);
  const verifyEvents = events.filter((e) => e.packet === pid && e.kind === 'verify' && e.data?.ok);
  const latestVerify = verifyEvents[verifyEvents.length - 1];
  const matchingVerify = verifyEvents.find((e) => e.data?.commit === s.commit);

  if (!matchingVerify && (!marker || marker.commit !== s.commit || !marker.ok)) {
    throw new BatonError(`commit ${s.commit.slice(0, 8)} has no valid verification evidence matching exact commit SHA`, { code: 'UNVERIFIED_COMMIT' });
  }

  // 2. Validate verdict event and actor identities (reject forged or mismatched actor)
  const verdictEvents = events.filter((e) => e.packet === pid && e.kind === 'verdict' && e.to === 'ACCEPTED');
  const verdictEvent = verdictEvents[verdictEvents.length - 1];
  if (!verdictEvent) {
    throw new BatonError(`packet ${pid} has no recorded acceptance verdict in ledger`, { code: 'NOT_ACCEPTED' });
  }

  if (by !== 'human') {
    const orchAgent = getAgent(config, by);
    if (orchAgent?.github && ctx.env?.GITHUB_ACTIONS === 'true' && ctx.env?.GITHUB_ACTOR) {
      if (ctx.env.GITHUB_ACTOR.toLowerCase() !== orchAgent.github.toLowerCase()) {
        throw new BatonError(`GitHub actor "${ctx.env.GITHUB_ACTOR}" does not match orchestrator "${by}" (expected "${orchAgent.github}")`, {
          code: 'IDENTITY_MISMATCH',
        });
      }
    }
  }

  if (verdictEvent.by && verdictEvent.by !== 'human') {
    const revAgent = getAgent(config, verdictEvent.by);
    if (revAgent?.github && verdictEvent.prov?.gh?.actor) {
      if (verdictEvent.prov.gh.actor.toLowerCase() !== revAgent.github.toLowerCase()) {
        throw new BatonError(`verdict on ${pid} has identity mismatch: GitHub actor "${verdictEvent.prov.gh.actor}" does not match reviewer "${verdictEvent.by}" (${revAgent.github})`, {
          code: 'IDENTITY_MISMATCH',
        });
      }
    }
  }

  // 3. Enforce config.security?.requireHumanReview on sensitive/risky changes
  if (config.security?.requireHumanReview) {
    let changed = [];
    if (s.base && gitOk(root, ['cat-file', '-e', `${s.base}^{commit}`])) {
      const diff = gitOut(root, ['diff', '--name-only', s.base, s.commit]);
      if (diff) changed = diff.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
    } else {
      const diff = gitOut(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', s.commit]);
      if (diff) changed = diff.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
    }
    const allPaths = [...new Set([...changed, ...(p.owns || [])])];
    const extraProtected = config.protected?.globs || [];
    const humanReviewGlobs = Array.isArray(config.security.requireHumanReview) ? config.security.requireHumanReview : [];

    const isRisky = (f) => {
      if (isProtected(f, extraProtected)) return true;
      const lower = normPath(f).toLowerCase();
      if (lower === 'security.md' || lower.includes('/security') || lower.startsWith('security/') || lower.includes('security.')) return true;
      if (lower.startsWith('.github/workflows/')) return true;
      if (humanReviewGlobs.length && humanReviewGlobs.some((g) => matchPath(g, f, true))) return true;
      return false;
    };

    const riskyFiles = allPaths.filter(isRisky);
    if (riskyFiles.length > 0) {
      const isHumanApproved = verdictEvent.by === 'human' || verdictEvent.data?.humanApproval === true || verdictEvent.data?.humanReview === true;
      if (!isHumanApproved) {
        throw new BatonError(`packet ${pid} includes sensitive/risky changes (${riskyFiles.join(', ')}) requiring human review (config.security.requireHumanReview); accepted by agent "${verdictEvent.by}"`, {
          code: 'HUMAN_REVIEW_REQUIRED',
          hint: 'have a human review and accept the packet before merge',
        });
      }
    }
  }

  // 4. In hosted mode (--hosted or config.merge?.requireCi), check CI checks and platform review policies
  const isHosted = Boolean(args.hosted || config.merge?.requireCi || config.merge?.requirePlatformReview || config.merge?.hosted);
  if (isHosted) {
    const hasPlatformReview = verdictEvent.prov?.trust === 'github-verified'
      || verdictEvent.data?.platformReview === true
      || verdictEvent.data?.platformApproval === true
      || verdictEvent.data?.gh_review === 'APPROVED';

    if (!hasPlatformReview) {
      throw new BatonError(`packet ${pid} review was self-asserted locally by "${verdictEvent.by}"; hosted platform review approval is required before merge`, {
        code: 'PLATFORM_REVIEW_REQUIRED',
        hint: 'require approved GitHub pull request review or execute review inside verified CI runner',
      });
    }

    const verifyEv = matchingVerify || latestVerify;
    if (verifyEv) {
      if (verifyEv.data?.ok === false || verifyEv.data?.ci_status === 'failure') {
        throw new BatonError(`packet ${pid} commit ${s.commit.slice(0, 8)} failed required CI checks`, {
          code: 'CI_FAILED',
        });
      }
      if (config.merge?.requireCi) {
        const hasCiEvidence = verifyEv.prov?.trust === 'github-verified'
          || verifyEv.prov?.trust === 'ci-environment'
          || verifyEv.data?.ci === true
          || verifyEv.data?.ci_status === 'success'
          || ctx.env?.CI === 'true'
          || ctx.env?.GITHUB_ACTIONS === 'true';

        if (!hasCiEvidence) {
          throw new BatonError(`packet ${pid} commit ${s.commit.slice(0, 8)} lacks required CI verification evidence (config.merge.requireCi)`, {
            code: 'CI_REQUIRED',
          });
        }
      }
    }
  }

  const mainSha = gitOut(root, ['rev-parse', `refs/heads/${main}`]);
  let moved = false;
  if (gitOk(root, ['merge-base', '--is-ancestor', s.commit, mainSha])) {
    // Already part of main (merged by hand, or a repeated run): only the ledger may be missing.
    if (s.merged) {
      if (args.json) ctx.json({ packet: pid, commit: s.commit, main, moved: false, alreadyMerged: true });
      else ctx.out(`${pid} is already merged into ${main}`);
      return 0;
    }
  } else {
    if (!gitOk(root, ['merge-base', '--is-ancestor', mainSha, s.commit])) {
      throw new BatonError(`${main} is not an ancestor of ${s.commit}: not a fast-forward. The accepted commit cannot be resubmitted after rebase; plan a replacement packet from updated ${main}, then verify, submit and review that new work.`, { code: 'NOT_FAST_FORWARD' });
    }
    // The original begin base must belong to integration history. This prevents
    // unverified ancestors from a foreign feature branch being fast-forwarded into main,
    // while allowing unfinished packets that were legitimately rebased onto newer main.
    if (s.base && !gitOk(root, ['merge-base', '--is-ancestor', s.base, mainSha])) {
      throw new BatonError(`${pid} began from ${s.base.slice(0, 8)}, which is not in the history of ${main} (${mainSha.slice(0, 8)}); merging could include unverified ancestor commits. Create a packet branch from ${main} and re-run the lifecycle.`, { code: 'UNVERIFIED_ANCESTORS' });
    }
    const wt = listWorktrees(root).find((w) => w.branch === main);
    const r = wt
      ? git(wt.path, ['merge', '--ff-only', s.commit])
      : git(root, ['update-ref', '-m', `baton merge ${pid}`, `refs/heads/${main}`, s.commit, mainSha]);
    if (!r || r.status !== 0) throw new BatonError(`could not fast-forward ${main}: ${(r?.stderr || r?.stdout || 'git missing').trim()}`, { code: 'GIT_FAILED' });
    moved = true;
  }
  appendEvent(root, { packet: pid, kind: 'merged', by, note: `fast-forwarded ${main}`, data: { commit: s.commit, branch: main } });
  postMessage(root, { from: by, to: 'all', type: 'NOTICE', packet: pid, text: `${pid} merged into ${main} at ${s.commit.slice(0, 8)}` });
  if (args.json) ctx.json({ packet: pid, commit: s.commit, main, moved, alreadyMerged: false });
  else {
    ctx.out(`${main} ${moved ? 'fast-forwarded to' : 'already contained'} ${s.commit.slice(0, 8)} (${pid})`);
    ctx.out('IMPORTANT: From the main worktree, run "baton ledger export", then commit .baton/ledger/ to persist the final verify, review and merge events for fresh clones.');
  }
  return 0;
}
