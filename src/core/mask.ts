/**
 * Secret masking (spec §19 Sobriété).
 *
 * The app receives tool names, paths and commands — never file contents.
 * Commands are masked before they are stored so a leaked ledger cannot leak
 * a credential. Masking is idempotent: an already masked text is unchanged.
 */

export interface SecretPattern {
  label: string;
  re: RegExp;
}

const REDACTED = /\[REDACTED:[a-z-]+\]/g;

/**
 * Ordered patterns. The first ones are the most specific so that a generic
 * assignment pattern does not swallow a well-known token shape.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  { label: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  {
    // Swallow the scheme and the credential, but never the following URL.
    label: 'authorization-header',
    re: /\b(authorization|proxy-authorization)\s*[:=]\s*[^\s"]+(?:\s+(?!https?:\/\/)[^\s"]+)?/gi,
  },
  { label: 'bearer-token', re: /\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi },
  { label: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { label: 'stripe-key', re: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}\b/g },
  { label: 'password-flag', re: /(-p|--password|--passwd|--pwd)([=\s]+)\S+/gi },
  {
    label: 'secret-assignment',
    re: /\b([A-Z0-9_]*(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"',;]+/gi,
  },
];

/** Replace every recognised secret with [REDACTED:<label>]. */
export function maskSecrets(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';
  let masked = text;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern.re, (match) => redact(match, pattern.label));
  }
  return masked;
}

/** Keep a redaction stable and never nest one inside another. */
function redact(match: string, label: string): string {
  if (REDACTED.test(match)) {
    REDACTED.lastIndex = 0;
    return match;
  }
  REDACTED.lastIndex = 0;
  const assignment = match.match(/^([A-Za-z0-9_.-]+\s*[=:]\s*)/);
  if (assignment) return `${assignment[1]}[REDACTED:${label}]`;
  const flag = match.match(/^(-p|--password|--passwd|--pwd)([=\s]+)/i);
  if (flag) return `${flag[1]}${flag[2]}[REDACTED:${label}]`;
  return `[REDACTED:${label}]`;
}

/** True when the text still looks like it carries a secret. */
export function hasSecrets(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.re.test(text));
}
