/**
 * The manifest guard tests itself: it must accept the real manifest and reject
 * the drifts it exists to catch. Runs the script as a child process, offline.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts', 'check-manifest.mjs');

interface GuardRun {
  status: number;
  output: string;
}

/** Run the guard against a copy of the repo manifest, optionally tampered. */
function runGuard(mutate?: (manifest: string) => string): GuardRun {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-guard-'));
  try {
    fs.cpSync(path.join(ROOT, 'src'), path.join(workdir, 'src'), { recursive: true });
    let manifest = fs.readFileSync(path.join(ROOT, 'manifest.yml'), 'utf8');
    if (mutate) manifest = mutate(manifest);
    fs.writeFileSync(path.join(workdir, 'manifest.yml'), manifest);
    // The skill check reads SKILL.md relative to the manifest directory.
    fs.cpSync(path.join(ROOT, 'skills'), path.join(workdir, 'skills'), { recursive: true });
    const output = execFileSync(process.execPath, [GUARD], {
      cwd: workdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error: any) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

describe('manifest guard', () => {
  it('accepts the repository manifest', () => {
    const run = runGuard();
    expect(run.status).toBe(0);
    expect(run.output).toContain('manifeste cohérent');
  }, 60_000);

  it('rejects a handler that does not exist', () => {
    const run = runGuard((manifest) => manifest.replace('index.checkPermission', 'index.nope'));
    expect(run.status).toBe(1);
    expect(run.output).toContain("n'est pas exporté");
  }, 60_000);

  it('rejects an MCP tool without its action', () => {
    const run = runGuard((manifest) => manifest.replace('        - check-permission\n', ''));
    expect(run.status).toBe(1);
    expect(run.output).toContain('non exposées en MCP');
  }, 60_000);

  it('rejects a property the rovo:skill module does not accept', () => {
    const run = runGuard((manifest) =>
      manifest.replace('    - key: permis-skill\n      source:', '    - key: permis-skill\n      name: Interdit\n      source:'),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain('propriété non prévue name');
  }, 60_000);

  it('rejects an unknown actionVerb', () => {
    const run = runGuard((manifest) => manifest.replace('      actionVerb: GET', '      actionVerb: READ'));
    expect(run.status).toBe(1);
    expect(run.output).toContain('actionVerb invalide');
  }, 60_000);

  it('rejects an agent name longer than 30 characters', () => {
    const run = runGuard((manifest) =>
      manifest.replace(
        "- key: permis-agent\n      name: Permis d'agir\n",
        "- key: permis-agent\n      name: Permis d'agir pour les agents de code du projet\n",
      ),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain('name > 30 caractères');
  }, 60_000);

  it('rejects an input without a description', () => {
    const run = runGuard((manifest) =>
      manifest.replace('          description: "Jira issue key, e.g. PAY-123. Required for any action beyond N4."\n', ''),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain('sans description');
  }, 60_000);

  it('rejects a skill whose SKILL.md name differs from its directory', () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-skill-'));
    try {
      fs.cpSync(path.join(ROOT, 'src'), path.join(workdir, 'src'), { recursive: true });
      fs.cpSync(path.join(ROOT, 'skills'), path.join(workdir, 'skills'), { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'manifest.yml'), path.join(workdir, 'manifest.yml'));
      const skill = path.join(workdir, 'skills', 'permis-skill', 'SKILL.md');
      fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8').replace('name: permis-skill', 'name: autre-nom'));

      execFileSync(process.execPath, [GUARD], { cwd: workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      throw new Error('the guard should have failed');
    } catch (error: any) {
      expect(error.status).toBe(1);
      expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('≠ dossier');
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }, 60_000);

  it('rejects a duplicate module key', () => {
    const run = runGuard((manifest) => manifest.replace('    - key: get-policy\n', '    - key: check-permission\n'));
    expect(run.status).toBe(1);
    expect(run.output).toContain('dupliqué');
  }, 60_000);

  it('rejects a missing app.runtime', () => {
    const run = runGuard((manifest) => manifest.replace('  runtime:\n    name: nodejs24.x\n', ''));
    expect(run.status).toBe(1);
    expect(run.output).toContain('app.runtime.name absent');
  }, 60_000);

  it('rejects an app.version, which the Forge schema does not accept', () => {
    const run = runGuard((manifest) =>
      manifest.replace('  runtime:\n', '  version:\n    major: 1\n  runtime:\n'),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("app.version n'est pas accepté");
  }, 60_000);

  it('rejects a function key longer than 23 characters', () => {
    const run = runGuard((manifest) =>
      manifest.replace('    - key: gate-fn\n', '    - key: gate-fn-beaucoup-trop-long\n'),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain('clé de fonction trop longue');
  }, 60_000);

  it('rejects an action description longer than 255 characters', () => {
    const run = runGuard((manifest) =>
      manifest.replace('        Decide whether an action is allowed.', `        ${'x'.repeat(260)}`),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain('> 255');
  }, 60_000);

  it('rejects a sql engine other than mysql', () => {
    const run = runGuard((manifest) => manifest.replace('      engine: mysql', '      engine: postgres'));
    expect(run.status).toBe(1);
    expect(run.output).toContain('engine doit valoir mysql');
  }, 60_000);
});
