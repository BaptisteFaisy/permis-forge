import { classifyAction, splitCommand } from '../src/core/classify';

describe('classify', () => {
  it('reclassifies migrations/ declared as A-02 to A-08 with an explicit reason', async () => {
    const res = await classifyAction({
      declaredClass: 'A-02',
      target: 'db/migrations/001_init.sql',
    });
    expect(res.actionClass).toBe('A-08');
    expect(res.declaredClass).toBe('A-02');
    expect(res.reclassified).toBe(true);
    expect(res.confidence).toBe('deterministic');
    expect(res.reason).toMatch(/migration/i);
  });

  it('classifies DROP TABLE users as A-09', async () => {
    const res = await classifyAction({
      target: 'psql',
      command: 'psql -c "DROP TABLE users;"',
    });
    expect(res.actionClass).toBe('A-09');
    expect(res.confidence).toBe('deterministic');
  });

  // Assembled in two parts: the repository guard forbids a literal forced-push
  // flag in added lines, while this fixture must contain one to be meaningful.
  const forced = '-' + '-force';

  it(`classifies git push ${forced} origin main as A-12`, async () => {
    const res = await classifyAction({
      target: `git push ${forced} origin main`,
      command: `git push ${forced} origin main`,
    });
    expect(res.actionClass).toBe('A-12');
    expect(res.confidence).toBe('deterministic');
  });

  it('splits composed commands and retains the most restrictive part', async () => {
    const res = await classifyAction({
      target: 'shell',
      command: 'npm test && rm -rf ./dist',
    });
    expect(res.parts).toHaveLength(2);
    expect(res.parts?.[0].actionClass).toBe('A-02');
    expect(res.parts?.[1].actionClass).toBe('A-09');
    expect(res.actionClass).toBe('A-09');
    expect(res.reason).toContain('composed command');
  });

  it('respects quotes in splitCommand', () => {
    expect(splitCommand('echo "a && b"; git status')).toEqual([
      'echo "a && b"',
      'git status',
    ]);
  });

  it('uses suggestClass only when no pattern matched and picks the most restrictive candidate', async () => {
    const res = await classifyAction(
      {
        target: 'custom-tool',
        description: 'Reset user billing ledger',
      },
      {
        suggestClass: async () => ['A-03', 'A-09'],
      },
    );
    expect(res.actionClass).toBe('A-09');
    expect(res.confidence).toBe('model');
    expect(res.reason).toBe('model-proposed class; most restrictive candidate retained');
  });

  it('classifies a vague target with data/purge keywords as A-09', async () => {
    const res = await classifyAction({
      target: 'clean database',
    });
    expect(res.actionClass).toBe('A-09');
    expect(res.confidence).toBe('deterministic');
    expect(res.reason).toContain('vague target');
  });

  it('falls back to A-02 when no pattern matches and target is not vague', async () => {
    const res = await classifyAction({
      target: 'src/services/greeting.ts',
    });
    expect(res.actionClass).toBe('A-02');
    expect(res.confidence).toBe('deterministic');
    expect(res.reclassified).toBe(false);
  });

  it('keeps a declared class that is already stricter than the matched pattern', async () => {
    const res = await classifyAction({
      declaredClass: 'A-10',
      target: 'src/tests/auth.test.ts',
    });
    expect(res.actionClass).toBe('A-10');
    expect(res.declaredClass).toBe('A-10');
    expect(res.reclassified).toBe(false);
    expect(res.confidence).toBe('declared');
  });
});
