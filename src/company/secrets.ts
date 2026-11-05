// Secrets at rest: a company's model API key is sealed with AES-256-GCM under a
// master key the server keeps in a mode 600 file next to the database, and the
// company id is bound in as additional authenticated data, so a row copied to
// another company (or another database) does not open. The key is read back
// only to be placed in a request header; it is never returned by the API.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

const PREFIX = 'v1.';

export class Secrets {
  private constructor(private master: Buffer) {}

  /** A Secrets bound to a 32-byte master key. */
  static fromKey(master: Buffer): Secrets {
    if (master.length !== 32) throw new Error('master key must be 32 bytes');
    return new Secrets(master);
  }

  /** Load the master key from a file, creating it (mode 600) on first use. */
  static fromFile(path: string): Secrets {
    if (!existsSync(path)) {
      writeFileSync(path, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
    }
    try { chmodSync(path, 0o600); } catch { /* not ours to change */ }
    const raw = readFileSync(path, 'utf8').trim();
    const master = Buffer.from(raw, 'base64url');
    if (master.length !== 32) throw new Error(`${path} does not hold a 32-byte key`);
    return new Secrets(master);
  }

  /** An ephemeral Secrets for tests. */
  static ephemeral(): Secrets {
    return new Secrets(randomBytes(32));
  }

  seal(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.master, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64url');
  }

  /** The plaintext, or null when the blob was not sealed under this key for this aad. */
  open(blob: string, aad: string): string | null {
    if (!blob.startsWith(PREFIX)) return null;
    try {
      const raw = Buffer.from(blob.slice(PREFIX.length), 'base64url');
      if (raw.length < 28) return null;
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ct = raw.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', this.master, iv);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}
