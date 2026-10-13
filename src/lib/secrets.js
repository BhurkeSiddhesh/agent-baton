import fs from 'node:fs';
import path from 'node:path';
import { decodeText } from './util.js';
import { git } from './git.js';

export const ALLOW_MARKER = 'baton:allow-secret';
// honoured only as a trailing comment, never inside a string literal next to a real key
const ALLOW_RE = /(?:#|\/\/|--|\/\*|<!--|;)\s*baton:allow-secret\b[^'"`]*$/;

/** Each pattern has a stable id (reported instead of the matched text, so findings never leak secrets). */
export const SECRET_PATTERNS = [
  { id: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'google-oauth-token', re: /ya29\.[0-9A-Za-z_-]{20,}/ },
  { id: 'google-refresh-token', re: /\b1\/\/[0-9A-Za-z_-]{30,}/ },
  { id: 'google-client-secret', re: /GOCSPX-[0-9A-Za-z_-]{10,}/ },
  { id: 'github-token', re: /\bgh[pousr]_[0-9A-Za-z]{30,}/ },
  { id: 'slack-token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { id: 'openai-anthropic-key', re: /\bsk-(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{20,}/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { id: 'github-fine-grained-token', re: /\bgithub_pat_[0-9A-Za-z_]{22,}/ },
  { id: 'stripe-key', re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}/ },
  { id: 'npm-token', re: /\bnpm_[0-9A-Za-z]{36}/ },
  { id: 'url-credentials', re: /:\/\/[^/\s:@]+:[^/\s@]{6,}@/ },
  { id: 'aws-secret-key', re: /aws_secret_access_key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{30,}/i },
  { id: 'bearer-header', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{30,}/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: 'env-assignment', re: /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY)[A-Z0-9_]*\s*=\s*[A-Za-z0-9._~+/!@#$%^&*=-]{16,}\s*$/ },
  { id: 'yaml-secret', re: /^\s*(?:password|passwd|secret|api[_-]?key|token)\s*:\s*[A-Za-z0-9._~+/!@#$%^&*=-]{12,}\s*$/i },
  { id: 'token-assignment', re: /(?:access|refresh|bearer|auth|api)[_-]?(?:token|key)["']?\s*[:=]\s*["'][A-Za-z0-9._~+/-]{24,}["']/i },
  { id: 'secret-assignment', re: /(?:client[_-]?secret|secret[_-]?key|password|passwd)["']?\s*[:=]\s*["'][A-Za-z0-9._~+/!@#$%^&*-]{12,}["']/i },
];

/**
 * Scan text line by line. A line containing `baton:allow-secret` is skipped.
 * @param {string} label file name or other label
 * @param {string} text
 * @returns {{label: string, line: number, pattern: string}[]}
 */
export function scanText(label, text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ALLOW_RE.test(line)) continue;
    for (const p of SECRET_PATTERNS) if (p.re.test(line)) out.push({ label, line: i + 1, pattern: p.id });
  }
  return out;
}

/** Scan repo-relative files that exist. Unreadable files are reported with pattern "unreadable". */
export function scanFiles(root, rels) {
  const hits = [];
  for (const rel of rels) {
    const file = path.join(root, rel);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    try {
      hits.push(...scanText(rel, decodeText(fs.readFileSync(file))));
    } catch {
      hits.push({ label: rel, line: 0, pattern: 'unreadable' });
    }
  }
  return hits;
}

/** Secrets added in any commit of base..HEAD, even if removed again later. [] when base is null or git fails. */
export function scanHistory(root, base) {
  if (!base) return [];
  const r = git(root, ['log', '--first-parent', '--no-merges', '-p', '-U0', '--pretty=format:', `${base}..HEAD`]);
  if (!r || r.status !== 0) return [];
  const added = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
  return scanText('commit history', added);
}

/** Human-readable line for a finding. */
export function formatSecretHit(h) {
  return h.line ? `${h.label}:${h.line}: matches secret pattern ${h.pattern}` : `${h.label}: ${h.pattern}`;
}
