import {
  buildGateResponseBody,
  buildHookFile,
  gateDecisionFor,
  mapHookEventToAction,
} from '../src/core/gate';

describe('gate — hook event mapping', () => {
  it('maps a Bash tool call to a command target', () => {
    const action = mapHookEventToAction({
      toolName: 'Bash',
      args: { command: 'npm test' },
    });
    expect(action.target).toBe('npm test');
    expect(action.command).toBe('npm test');
  });

  it('matches shell tool names case-insensitively', () => {
    const action = mapHookEventToAction({
      toolName: 'shell',
      args: { command: 'ls -la' },
    });
    expect(action.target).toBe('ls -la');
    expect(action.command).toBe('ls -la');
  });

  it('maps an Edit tool call to file_path', () => {
    const action = mapHookEventToAction({
      toolName: 'Edit',
      args: { file_path: '/repo/src/index.ts' },
    });
    expect(action.target).toBe('/repo/src/index.ts');
    expect(action.command).toBeUndefined();
  });

  it('maps Write and NotebookEdit to their path arguments', () => {
    expect(
      mapHookEventToAction({ toolName: 'Write', args: { file_path: 'a.txt' } })
        .target,
    ).toBe('a.txt');
    expect(
      mapHookEventToAction({
        toolName: 'NotebookEdit',
        args: { notebook_path: 'nb.ipynb' },
      }).target,
    ).toBe('nb.ipynb');
  });

  it('declares class A-01 for read-only tools', () => {
    const read = mapHookEventToAction({
      toolName: 'Read',
      args: { file_path: 'src/index.ts' },
    });
    expect(read.declaredClass).toBe('A-01');
    expect(read.target).toBe('src/index.ts');

    const grep = mapHookEventToAction({
      toolName: 'Grep',
      args: { pattern: 'TODO' },
    });
    expect(grep.declaredClass).toBe('A-01');
    expect(grep.target).toBe('TODO');
  });

  it('falls back to the tool name for unknown tools without throwing', () => {
    const action = mapHookEventToAction({
      toolName: 'MysteryTool',
      args: { foo: 'bar' },
    });
    expect(action.target).toBe('MysteryTool');
    expect(action.description).toContain('bar');
    expect(() =>
      mapHookEventToAction({ toolName: 'Weird', args: {} }),
    ).not.toThrow();
  });

  it('coerces non-string args without throwing', () => {
    const action = mapHookEventToAction({
      toolName: 'Bash',
      args: { command: 42 },
    });
    expect(action.target).toBe('42');
    expect(action.command).toBe('42');

    const write = mapHookEventToAction({
      toolName: 'Write',
      args: { file_path: { nested: true } },
    });
    expect(typeof write.target).toBe('string');
  });

  it('propagates project and issue keys', () => {
    const action = mapHookEventToAction(
      { toolName: 'Bash', args: { command: 'ls' } },
      { projectKey: 'PRJ', issueKey: 'PRJ-42' },
    );
    expect(action.projectId).toBe('PRJ');
    expect(action.issueKey).toBe('PRJ-42');
  });
});

describe('gate — decision table', () => {
  it('allows N5 without logging', () => {
    expect(gateDecisionFor(5, { hasValidPermit: false })).toEqual({
      decision: 'allow',
      log: false,
    });
  });

  it('allows N4 and logs it', () => {
    expect(gateDecisionFor(4, { hasValidPermit: false })).toEqual({
      decision: 'allow',
      log: true,
    });
  });

  it('asks at N3 and logs it', () => {
    expect(gateDecisionFor(3, { hasValidPermit: false })).toEqual({
      decision: 'ask',
      log: true,
    });
  });

  it('allows N2 and N1 when a valid permit covers the action', () => {
    expect(gateDecisionFor(2, { hasValidPermit: true })).toEqual({
      decision: 'allow',
      log: true,
    });
    expect(gateDecisionFor(1, { hasValidPermit: true })).toEqual({
      decision: 'allow',
      log: true,
    });
  });

  it('denies N2 and N1 without a permit', () => {
    const n2 = gateDecisionFor(2, { hasValidPermit: false });
    expect(n2.decision).toBe('deny');
    expect(n2.log).toBe(true);
    expect(n2.reason).toBe('no valid permit covers this action');

    const n1 = gateDecisionFor(1, { hasValidPermit: false });
    expect(n1.decision).toBe('deny');
    expect(n1.reason).toBe('no valid permit covers this action');
  });

  it('denies N0 as forbidden by policy', () => {
    const result = gateDecisionFor(0, { hasValidPermit: true });
    expect(result.decision).toBe('deny');
    expect(result.log).toBe(true);
    expect(result.reason).toBe('forbidden by policy');
  });

  it('forces allow in observe mode and keeps the initial decision visible', () => {
    const result = gateDecisionFor(0, {
      hasValidPermit: false,
      observeOnly: true,
    });
    expect(result.decision).toBe('allow');
    expect(result.log).toBe(true);
    expect(result.reason).toContain('observe mode');
    expect(result.reason).toContain('deny');
  });

  it('forces allow in observe mode even without a permit at N2', () => {
    const result = gateDecisionFor(2, {
      hasValidPermit: false,
      observeOnly: true,
    });
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('observe mode');
    expect(result.reason).toContain('deny');
  });
});

describe('gate — hook file generation', () => {
  it('builds the default hook configuration', () => {
    const file = buildHookFile({ gateUrl: 'https://gate.example/hook' });
    const entries = file.hooks.PreToolUse;
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe('Bash|Edit|Write|MultiEdit');
    const hook = entries[0].hooks[0];
    expect(hook.type).toBe('http');
    expect(hook.url).toBe('https://gate.example/hook');
    expect(hook.timeout).toBe(10);
    expect(hook.onFailure).toBe('block');
    expect(hook.headers.Authorization).toBe('Bearer $PERMIS_AGENT_TOKEN');
    // The ticket is named by the hook, through the environment: without it the
    // gate has no ticket and refuses anything beyond N4.
    expect(hook.headers['X-Permis-Issue']).toBe('$PERMIS_AGENT_ISSUE');
    expect(hook.allowedEnvVars).toEqual(['PERMIS_AGENT_TOKEN', 'PERMIS_AGENT_ISSUE']);
  });

  it('honours custom token var, timeout and matchers', () => {
    const file = buildHookFile({
      gateUrl: 'https://gate.example/hook',
      tokenEnvVar: 'MY_TOKEN',
      timeoutSeconds: 3,
      matchers: ['Bash', 'Read'],
    });
    expect(file.hooks.PreToolUse).toHaveLength(2);
    expect(file.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(file.hooks.PreToolUse[1].matcher).toBe('Read');
    const hook = file.hooks.PreToolUse[0].hooks[0];
    expect(hook.timeout).toBe(3);
    expect(hook.headers.Authorization).toBe('Bearer $MY_TOKEN');
    expect(hook.allowedEnvVars).toEqual(['MY_TOKEN', 'PERMIS_AGENT_ISSUE']);
  });
});

describe('gate — hook response body', () => {
  it('carries the permission decision and the request id', () => {
    const body = buildGateResponseBody({
      decision: 'ask',
      reason: 'pilot confirmation required',
      requestId: 'RQ-2026-0001',
      level: 3,
    });
    const output = body.hookSpecificOutput as Record<string, unknown>;
    expect(output.hookEventName).toBe('PreToolUse');
    expect(output.permissionDecision).toBe('ask');
    const reason = String(output.permissionDecisionReason);
    expect(reason).toContain('pilot confirmation required');
    expect(reason).toContain('RQ-2026-0001');
    expect(reason).toContain('N3');
  });

  it('omits the request id and level when not provided', () => {
    const body = buildGateResponseBody({
      decision: 'allow',
      reason: 'ok',
    });
    const output = body.hookSpecificOutput as Record<string, unknown>;
    expect(output.permissionDecision).toBe('allow');
    expect(String(output.permissionDecisionReason)).toBe('ok');
  });
});
