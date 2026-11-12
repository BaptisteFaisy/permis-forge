/**
 * Unit tests for src/services/policy-lint.ts — one per finding code, plus the
 * ordering and the summary the settings screen shows.
 */
import { LintInput, PolicyFinding, lintPolicy, summarizeFindings } from '../src/services/policy-lint';
import { PolicyRule, Zone } from '../src/core/types';

const PROJECT = 'PAY';
const NOW = '2026-11-12T12:00:00.000Z';

function rule(overrides: Partial<PolicyRule> & Pick<PolicyRule, 'id' | 'actionClass' | 'level'>): PolicyRule {
  return { scope: 'project', projectId: PROJECT, mode: 'enforce', ...overrides };
}

function zone(overrides: Partial<Zone> & Pick<Zone, 'id' | 'name'>): Zone {
  return { projectId: PROJECT, pathPatterns: [], ...overrides };
}

/** Lint with defaults, so each test states only what it exercises. */
function lint(overrides: Partial<LintInput> = {}): PolicyFinding[] {
  return lintPolicy({ projectId: PROJECT, rules: [], zones: [], now: NOW, ...overrides });
}

/** The codes found, for readable assertions. */
function codes(findings: PolicyFinding[]): string[] {
  return findings.map((finding) => finding.code);
}

describe('SOFTER_THAN_FLOOR', () => {
  it('reports a project rule softer than the organisation floor as an error', () => {
    const findings = lint({
      rules: [
        rule({ id: 'org-1', scope: 'org', projectId: undefined, actionClass: 'A-05', level: 2 }),
        rule({ id: 'p-1', actionClass: 'A-05', level: 4 }),
      ],
    });
    const finding = findings.find((item) => item.code === 'SOFTER_THAN_FLOOR');

    expect(finding?.severity).toBe('error');
    expect(finding?.ruleId).toBe('p-1');
    expect(finding?.message).toContain('organisation floor is N2');
  });

  it('says nothing when the project hardens the floor', () => {
    const findings = lint({
      rules: [
        rule({ id: 'org-1', scope: 'org', projectId: undefined, actionClass: 'A-05', level: 3 }),
        rule({ id: 'p-1', actionClass: 'A-05', level: 1 }),
      ],
    });
    expect(codes(findings)).not.toContain('SOFTER_THAN_FLOOR');
  });
});

describe('UNREACHABLE_RULE', () => {
  it('reports the looser of two competing rules on the same class and zone', () => {
    const findings = lint({
      rules: [
        rule({ id: 'strict', actionClass: 'A-08', zoneId: 'z1', level: 1 }),
        rule({ id: 'loose', actionClass: 'A-08', zoneId: 'z1', level: 4 }),
      ],
    });
    const finding = findings.find((item) => item.code === 'UNREACHABLE_RULE');

    expect(finding?.ruleId).toBe('loose');
    expect(finding?.message).toContain('shadowed by strict');
    expect(codes(findings).filter((code) => code === 'UNREACHABLE_RULE')).toHaveLength(1);
  });

  it('does not report two rules on different zones', () => {
    const findings = lint({
      rules: [
        rule({ id: 'a', actionClass: 'A-08', zoneId: 'z1', level: 1 }),
        rule({ id: 'b', actionClass: 'A-08', zoneId: 'z2', level: 4 }),
      ],
    });
    expect(codes(findings)).not.toContain('UNREACHABLE_RULE');
  });
});

describe('DUPLICATE_RULE', () => {
  it('reports two rules on the same class, zone and mode, once', () => {
    const findings = lint({
      rules: [
        rule({ id: 'a', actionClass: 'A-07', zoneId: 'z1', level: 2 }),
        rule({ id: 'b', actionClass: 'A-07', zoneId: 'z1', level: 3 }),
      ],
    });
    expect(codes(findings).filter((code) => code === 'DUPLICATE_RULE')).toHaveLength(1);
  });
});

describe('CLASS_WITHOUT_RULE', () => {
  it('reports every uncovered class, and stays quiet about locked ones', () => {
    const findings = lint({
      rules: [rule({ id: 'org-1', scope: 'org', projectId: undefined, actionClass: 'A-10', level: 0 })],
    });
    const uncovered = findings.filter((item) => item.code === 'CLASS_WITHOUT_RULE');

    expect(uncovered.length).toBe(14);
    expect(uncovered.map((item) => item.actionClass)).not.toContain('A-10');
    // A-15 is locked: no rule can soften it, so an uncovered locked class is informational.
    const locked = uncovered.find((item) => item.actionClass === 'A-15');
    expect(locked?.severity).toBe('info');
    expect(locked?.suggestion).toContain('locked');
  });
});

describe('zones', () => {
  it('reports a zone no rule refers to', () => {
    const findings = lint({ zones: [zone({ id: 'z1', name: 'Migrations', pathPatterns: ['**/migrations/**'] })] });
    const finding = findings.find((item) => item.code === 'ZONE_WITHOUT_RULE');

    expect(finding?.zoneId).toBe('z1');
    expect(finding?.severity).toBe('info');
  });

  it('reports nested zones carrying different levels for one class', () => {
    const findings = lint({
      zones: [
        zone({ id: 'wide', name: 'Database', pathPatterns: ['db/**'] }),
        zone({ id: 'narrow', name: 'Migrations', pathPatterns: ['db/migrations/**'] }),
      ],
      rules: [
        rule({ id: 'r-wide', actionClass: 'A-08', zoneId: 'wide', level: 3 }),
        rule({ id: 'r-narrow', actionClass: 'A-08', zoneId: 'narrow', level: 1 }),
      ],
    });
    const overlaps = findings.filter((item) => item.code === 'OVERLAPPING_ZONES');

    expect(overlaps.length).toBeGreaterThan(0);
    expect(overlaps[0].message).toContain('the stricter one wins');
  });

  it('stays quiet about two zones with the same level', () => {
    const findings = lint({
      zones: [
        zone({ id: 'wide', name: 'Database', pathPatterns: ['db/**'] }),
        zone({ id: 'narrow', name: 'Migrations', pathPatterns: ['db/migrations/**'] }),
      ],
      rules: [
        rule({ id: 'r-wide', actionClass: 'A-08', zoneId: 'wide', level: 2 }),
        rule({ id: 'r-narrow', actionClass: 'A-08', zoneId: 'narrow', level: 2 }),
      ],
    });
    expect(codes(findings)).not.toContain('OVERLAPPING_ZONES');
  });
});

describe('OBSERVE_TOO_LONG', () => {
  const observeRule = rule({ id: 'obs', actionClass: 'A-05', level: 3, mode: 'observe' });

  it('reports an observation older than the window', () => {
    const since = new Date(Date.parse(NOW) - 40 * 86_400_000).toISOString();
    const findings = lint({ rules: [observeRule], observeSince: { obs: since } });

    expect(codes(findings)).toContain('OBSERVE_TOO_LONG');
    expect(findings.find((item) => item.code === 'OBSERVE_TOO_LONG')?.message).toContain('40 days');
  });

  it('stays quiet inside the window', () => {
    const since = new Date(Date.parse(NOW) - 5 * 86_400_000).toISOString();
    expect(codes(lint({ rules: [observeRule], observeSince: { obs: since } }))).not.toContain('OBSERVE_TOO_LONG');
  });

  it('is not reported at all without the observation dates', () => {
    expect(codes(lint({ rules: [observeRule] }))).not.toContain('OBSERVE_TOO_LONG');
  });
});

describe('ordering and summary', () => {
  it('puts errors before warnings, and warnings before information', () => {
    const findings = lint({
      zones: [zone({ id: 'z1', name: 'Unused' })],
      rules: [
        rule({ id: 'org-1', scope: 'org', projectId: undefined, actionClass: 'A-05', level: 2 }),
        rule({ id: 'p-1', actionClass: 'A-05', level: 4 }),
      ],
    });
    const ranks = findings.map((item) => ({ error: 0, warning: 1, info: 2 })[item.severity]);

    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(findings[0].code).toBe('SOFTER_THAN_FLOOR');
  });

  it('counts the findings by severity', () => {
    const findings = lint({ zones: [zone({ id: 'z1', name: 'Unused' })] });
    const summary = summarizeFindings(findings);

    expect(summary.error + summary.warning + summary.info).toBe(findings.length);
    expect(summary.info).toBeGreaterThan(0);
  });

  it('every finding carries a message and a way out', () => {
    for (const finding of lint({ zones: [zone({ id: 'z1', name: 'Unused' })] })) {
      expect(finding.message.length).toBeGreaterThan(10);
      expect(finding.suggestion.length).toBeGreaterThan(5);
    }
  });
});
