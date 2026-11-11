#!/usr/bin/env node
/**
 * Offline acceptance demo — the eleven scenarios of spec §21, run against the
 * real decision engine with the in-memory storage. No Jira site, no network.
 *
 * The project is TypeScript (CommonJS), so this runner first compiles src/ and
 * scripts/ into .demo-build/ with the local tsc, then requires the compiled
 * scenarios. Usage:
 *
 *   npm ci
 *   node scripts/demo.mjs
 *
 * Exit code 0 when every scenario passes, 1 otherwise.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, '.demo-build');
const TIMEOUT_MS = 240_000;

function compile() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  execFileSync('npx', ['tsc', '-p', 'tsconfig.demo.json'], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: TIMEOUT_MS,
  });
}

function printHeader(total) {
  console.log('Permis d\'agir — offline acceptance demo (spec §21)');
  console.log('='.repeat(58));
  console.log(`Engine: real decision pipeline. Storage: in-memory adapter. Scenarios: ${total}\n`);
}

function printResult(item) {
  const mark = item.passed ? 'PASS' : 'FAIL';
  console.log(`[${String(item.id).padStart(2, ' ')}] ${mark}  ${item.title}`);
  console.log(`      ${item.detail}`);
}

async function main() {
  compile();
  const require = createRequire(import.meta.url);
  const scenarios = require(path.join(OUT_DIR, 'scripts', 'scenarios.js'));
  const results = await scenarios.runScenarios();

  printHeader(results.length);
  for (const item of results) printResult(item);

  const passed = results.filter((item) => item.passed).length;
  console.log('');
  console.log(`${passed}/${results.length} scenarios passed`);
  if (passed !== results.length) {
    const failed = results.filter((item) => !item.passed).map((item) => item.id);
    console.error(`Failed scenarios: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Demo failed to run:', error?.message ?? error);
  process.exitCode = 1;
});
