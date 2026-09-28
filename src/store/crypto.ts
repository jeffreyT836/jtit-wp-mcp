import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT_VERSION = 'v1';

/** Thrown when the encryption key is malformed or a ciphertext cannot be decrypted. */
export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretCryptoError';
  }
}

/**
 * Parses `SITES_ENCRYPTION_KEY` (base64 of exactly 32 random bytes, e.g.
 * `openssl rand -base64 32`). Never includes the key itself in the error message.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === '') {
    throw new SecretCryptoError(
      'SITES_ENCRYPTION_KEY is not set (generate one with: openssl rand -base64 32)',
    );
  }
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new SecretCryptoError('SITES_ENCRYPTION_KEY must be base64');
  }
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new SecretCryptoError(
      `SITES_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}

/**
 * Encrypts `plaintext` with AES-256-GCM. `aad` binds the ciphertext to its context (the
 * site id), so a ciphertext copied onto another site's row fails to decrypt.
 * Output format: `v1.<iv>.<tag>.<ciphertext>`, each part base64.
 */
export function encryptSecret(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv, tag, ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64')))
    .join('.');
}

/** Reverses {@link encryptSecret}; throws {@link SecretCryptoError} on any tampering or key mismatch. */
export function decryptSecret(payload: string, key: Buffer, aad: string): string {
  const [version, ivB64, tagB64, ctB64, ...rest] = payload.split('.');
  if (version !== FORMAT_VERSION || !ivB64 || !tagB64 || ctB64 === undefined || rest.length > 0) {
    throw new SecretCryptoError('unrecognised secret format');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretCryptoError('secret could not be decrypted (wrong SITES_ENCRYPTION_KEY?)');
  }
}
