#!/usr/bin/env node
/**
 * Compile the TypeScript sources once, then run the command-line fuzz of the
 * gate. Same build step as `scripts/demo.mjs` (`tsconfig.demo.json`), so the
 * fuzz exercises the real compiled engine rather than a copy of it.
 *
 *   node scripts/fuzz-gate.mjs [--cases N] [--seed S]
 *
 * Exit code 0 when no invariant is broken, 1 with the offending inputs.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, '.demo-build');

fs.rmSync(OUT_DIR, { recursive: true, force: true });
execFileSync('npx', ['tsc', '-p', 'tsconfig.demo.json'], {
  cwd: ROOT,
  stdio: 'inherit',
  timeout: 240_000,
});

createRequire(import.meta.url)(path.join(OUT_DIR, 'scripts', 'fuzz-gate.js'));
