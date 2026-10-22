import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function checksumPackEntry(entry, expectedName, expectedVersion, bytes) {
  if (!entry || entry.name !== expectedName || entry.version !== expectedVersion ||
      entry.filename !== expectedName + '-' + expectedVersion + '.tgz') {
    throw new Error('packed archive name/version differs from package.json');
  }
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  return sha + '  ' + entry.filename + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (!Array.isArray(meta) || meta.length !== 1) throw new Error('expected exactly one packed archive');
  const entry = meta[0];
  // Metadata is untrusted: confirm it matches the expected archive basename before reading it.
  const expected = pkg.name + '-' + pkg.version + '.tgz';
  if (entry.filename !== expected) throw new Error('unexpected tarball path or filename');
  const hashLine = checksumPackEntry(entry, pkg.name, pkg.version, fs.readFileSync(expected));
  fs.writeFileSync(process.argv[3] || 'SHA256SUMS', hashLine);
  console.log('release candidate checksum: ' + hashLine.trim());
}
