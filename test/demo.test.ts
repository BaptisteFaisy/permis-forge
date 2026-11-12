/**
 * Tests for the offline acceptance demo (spec §21) and the example files that
 * ship with it. The scenarios run the real engine, so this suite is also a
 * regression net for the eleven acceptance criteria themselves.
 */
import fs from 'fs';
import path from 'path';
import { SCENARIOS, runScenarios } from '../scripts/scenarios';
import { createMemoryRepositories } from '../src/storage/memory';
import { buildHookFile } from '../src/core/gate';
import { PolicyRule, ProjectSettings, Zone } from '../src/core/types';

const EXAMPLES = path.join(__dirname, '..', 'examples');

function readJson(relative: string): any {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLES, relative), 'utf8'));
}

describe('acceptance scenarios (spec §21)', () => {
  it('covers exactly the eleven scenarios, numbered in order', () => {
    expect(SCENARIOS).toHaveLength(11);
    expect(SCENARIOS.map((scenario) => scenario.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('passes every scenario against the real engine', async () => {
    const results = await runScenarios();
    const failures = results.filter((item) => !item.passed);
    expect(failures.map((item) => `${item.id}: ${item.detail}`)).toEqual([]);
    expect(results).toHaveLength(11);
  }, 60_000);
});

describe('example files', () => {
  it('ships a Claude Code hooks file that fails closed', () => {
    const hooks = readJson('hooks/claude-code-settings.json');
    const generated = buildHookFile({ gateUrl: 'https://x.webtrigger.atlassian.app/gate' });

    const entry = hooks.hooks.PreToolUse[0].hooks[0];
    expect(entry.type).toBe('http');
    expect(entry.onFailure).toBe('block');
    expect(entry.allowedEnvVars).toEqual(['PERMIS_AGENT_TOKEN']);
    expect(entry.headers.Authorization).toBe('Bearer $PERMIS_AGENT_TOKEN');
    // Same shape as what the app generates, so the example cannot drift silently.
    expect(hooks.hooks.PreToolUse[0].matcher).toBe(generated.hooks.PreToolUse[0].matcher);
    expect(Object.keys(entry).sort()).toEqual(Object.keys(generated.hooks.PreToolUse[0].hooks[0]).sort());
  });

  it('ships a Cursor hooks file using the command bridge with failClosed', () => {
    const cursor = readJson('hooks/cursor-hooks.json');
    const hook = cursor.hooks.preToolUse[0];
    expect(hook.failClosed).toBe(true);
    expect(hook.command).toContain('gate-bridge.sh');
    expect(fs.existsSync(path.join(EXAMPLES, 'hooks', 'gate-bridge.sh'))).toBe(true);
  });

  it('ships an MCP client config listing every exposed tool', () => {
    const config = readJson('mcp/client-config.json');
    expect(config.mcpServers['permis-agir'].url).toContain('https://mcp.atlassian.com/forge/');
    expect(config.mcpServers['permis-agir'].auth.type).toBe('oauth2');
    expect(config.expectedTools).toHaveLength(12);
    expect(config.expectedTools).toContain('check-permission');
    expect(config.expectedTools).toContain('detect-drift');
    expect(config.expectedTools).toContain('delegate-permit');
    expect(config.expectedTools).toContain('suggest-policy');
  });

  it('ships a seed policy whose fields load into the real storage', async () => {
    const seed = readJson('policy/seed-payments.json');
    const repos = createMemoryRepositories();

    for (const zone of seed.zones as Zone[]) {
      expect(zone.id).toBeTruthy();
      expect(zone.projectId).toBe('PAY');
      await repos.zones.upsertZone(zone);
    }
    for (const rule of [...seed.rules, ...seed.orgFloor] as PolicyRule[]) {
      expect(rule.level).toBeGreaterThanOrEqual(0);
      expect(rule.level).toBeLessThanOrEqual(5);
      expect(['enforce', 'observe']).toContain(rule.mode);
      await repos.policies.upsertRule(rule);
    }

    expect(await repos.zones.listZones('PAY')).toHaveLength(seed.zones.length);
    expect(await repos.policies.listRules('PAY')).toHaveLength(seed.rules.length + seed.orgFloor.length);
    // At least one rule runs in observe mode (spec §7.4).
    expect(seed.rules.some((rule: PolicyRule) => rule.mode === 'observe')).toBe(true);
    // Settings keys match the ProjectSettings contract.
    const settings = seed.settings as ProjectSettings;
    expect(settings.projectId).toBe('PAY');
    expect(settings.defaultPermitTtlMinutes).toBe(120);
  });

  it('never lets a project rule soften the organisation floor', () => {
    const seed = readJson('policy/seed-payments.json');
    const floors = new Map<string, number>(
      (seed.orgFloor as PolicyRule[]).map((rule) => [rule.actionClass, rule.level]),
    );
    for (const rule of seed.rules as PolicyRule[]) {
      const floor = floors.get(rule.actionClass);
      if (floor === undefined) continue;
      expect(rule.level).toBeLessThanOrEqual(floor);
    }
  });
});

describe('the shipped hook file declares the action after it ran', () => {
  it('carries a PostToolUse hook on the same gate, failing closed', () => {
    const hooks = readJson('hooks/claude-code-settings.json');
    const generated = buildHookFile({ gateUrl: 'https://x.webtrigger.atlassian.app/gate' });

    expect(hooks.hooks.PostToolUse).toHaveLength(1);
    expect(hooks.hooks.PostToolUse[0].matcher).toBe(generated.hooks.PostToolUse![0].matcher);
    expect(hooks.hooks.PostToolUse[0].hooks[0].type).toBe('http');
    expect(hooks.hooks.PostToolUse[0].hooks[0].onFailure).toBe('block');
    expect(hooks.hooks.PostToolUse[0].hooks[0].headers.Authorization).toBe('Bearer $PERMIS_AGENT_TOKEN');
  });
});
