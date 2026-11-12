/**
 * Personal hook tokens (spec §17).
 *
 * Only the SHA-256 of a token is ever stored, so a database leak does not hand
 * over working credentials. One implementation, shared by the gate that
 * authenticates, the operator endpoint that revokes, and the service that
 * mints: three places hashing the same secret must not drift apart.
 */
import { createHash } from 'crypto';

/** SHA-256 hex digest of a plaintext token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
