import crypto from 'node:crypto';
import { eventSha } from './store.js';

/**
 * Distinguish integrity checksums from cryptographic authenticity:
 * SHA-256 (event.sha) provides tamper-evident integrity of on-disk contents,
 * but does not prove the identity or authorization of the actor.
 * Cryptographic attestation (event.sig) provides non-repudiation using asymmetric keys.
 */

function resolveKey(key, type) {
  if (key && typeof key.asymmetricKeyType === 'string') {
    return key;
  }
  return type === 'private'
    ? crypto.createPrivateKey(key)
    : crypto.createPublicKey(key);
}

function resolveAlgorithm(keyObj, preferredAlg) {
  const keyType = keyObj.asymmetricKeyType?.toLowerCase();
  if (keyType === 'ed25519' || keyType === 'ed448') {
    return null;
  }
  return preferredAlg || 'sha256';
}

/**
 * Creates an asymmetric digital signature over the canonical event SHA.
 * @param {object} ev The event object (with or without existing sig)
 * @param {string|Buffer|crypto.KeyObject} privateKey PEM or KeyObject
 * @param {{keyId?: string, alg?: string}} [opts]
 * @returns {{alg: string, key: string, sig: string}}
 */
export function createEventAttestation(ev, privateKey, { keyId = 'default', alg } = {}) {
  const keyObj = resolveKey(privateKey, 'private');
  const digestAlg = resolveAlgorithm(keyObj, alg);
  const hash = eventSha(ev);
  const data = Buffer.from(hash, 'utf8');
  const signatureBuffer = crypto.sign(digestAlg, data, keyObj);
  return {
    alg: alg || (digestAlg ? digestAlg.toLowerCase() : keyObj.asymmetricKeyType || 'ed25519'),
    key: keyId,
    sig: signatureBuffer.toString('base64'),
  };
}

/**
 * Verifies the cryptographic attestation on an event against a public key.
 * @param {object} ev The event object
 * @param {string|Buffer|crypto.KeyObject} publicKey PEM or KeyObject
 * @returns {{valid: boolean, reason: string|null}}
 */
export function verifyEventAttestation(ev, publicKey) {
  if (!ev.sig || typeof ev.sig !== 'object') {
    return { valid: false, reason: 'event does not contain an attestation (sig)' };
  }
  try {
    const keyObj = resolveKey(publicKey, 'public');
    const digestAlg = resolveAlgorithm(keyObj, ev.sig.alg);
    const hash = eventSha(ev);
    const data = Buffer.from(hash, 'utf8');
    const signatureBuffer = Buffer.from(ev.sig.sig, 'base64');
    const valid = crypto.verify(digestAlg, data, keyObj, signatureBuffer);
    return { valid, reason: valid ? null : 'signature does not match event payload' };
  } catch (err) {
    return { valid: false, reason: `verification error: ${err.message}` };
  }
}

/**
 * Signs an event in-place and updates its sha.
 * @param {object} ev
 * @param {string|Buffer|crypto.KeyObject} privateKey
 * @param {{keyId?: string, alg?: string}} [opts]
 * @returns {object} The signed event
 */
export function signEvent(ev, privateKey, opts = {}) {
  ev.sig = createEventAttestation(ev, privateKey, opts);
  ev.sha = eventSha(ev);
  return ev;
}
