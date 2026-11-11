/**
 * Unit tests for src/core/mask.ts — secret masking (spec §19 Sobriété).
 */
import { SECRET_PATTERNS, hasSecrets, maskSecrets } from '../src/core/mask';

describe('maskSecrets', () => {
  it('masks a GitHub token', () => {
    const masked = maskSecrets('git push https://ghp_abcdefghijklmnopqrstuvwx@github.com');
    expect(masked).not.toContain('ghp_abcdefghijklmnopqrstuvwx');
    expect(masked).toContain('[REDACTED:github-token]');
  });

  it('masks a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(maskSecrets(`Authorization: Bearer ${jwt}`)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('masks an AWS access key', () => {
    expect(maskSecrets('aws --key AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED:aws-access-key]');
  });

  it('masks password flags and assignments', () => {
    expect(maskSecrets('mysql --password=hunter2 -h db')).not.toContain('hunter2');
    expect(maskSecrets('export API_KEY=abcdef123456')).not.toContain('abcdef123456');
    expect(maskSecrets('DB_PASSWORD: s3cr3t')).toContain('[REDACTED:secret-assignment]');
  });

  it('masks a private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(maskSecrets(pem)).toContain('[REDACTED:private-key]');
    expect(maskSecrets(pem)).not.toContain('MIIEowIBAAKCAQEA');
  });

  it('leaves harmless commands untouched', () => {
    const command = 'git commit -m "fix: handle null user" && npm test';
    expect(maskSecrets(command)).toBe(command);
  });

  it('is idempotent', () => {
    const once = maskSecrets('export TOKEN=abcdef123456');
    expect(maskSecrets(once)).toBe(once);
  });

  it('handles empty and non-string input safely', () => {
    expect(maskSecrets('')).toBe('');
    expect(maskSecrets(undefined as unknown as string)).toBe('');
  });
});

describe('pattern table', () => {
  it('labels every pattern so the redaction says what was hidden', () => {
    for (const pattern of SECRET_PATTERNS) {
      expect(pattern.label.length).toBeGreaterThan(0);
      expect(pattern.re.global).toBe(true);
    }
  });
});

describe('hasSecrets', () => {
  it('detects a token and ignores plain text', () => {
    expect(hasSecrets('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(hasSecrets('npm install')).toBe(false);
  });
});
