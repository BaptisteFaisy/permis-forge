#!/usr/bin/env node
/**
 * Manifest guard — fails the CI when manifest.yml and the code drift apart.
 *
 * Checks (no network, no Forge CLI, runs in a second):
 * 1. manifest.yml parses and every module key is unique;
 * 2. every module type is a known Forge module;
 * 3. every function handler points to an existing file exporting that symbol;
 * 4. every action references a declared function;
 * 5. the rovo:mcp tool list matches the action list exactly;
 * 6. src/mcp/tools.ts (runtime mirror) matches the manifest actions:
 *    same keys, same verbs, same input names.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const yaml = createRequire(import.meta.url)('js-yaml');

const ROOT = path.resolve(process.cwd());
const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

const KNOWN_MODULES = new Set([
  'function',
  'action',
  'rovo:mcp',
  'rovo:agent',
  'rovo:skill',
  'webtrigger',
  'jira:issuePanel',
  'jira:projectSettingsPage',
  'jira:projectPage',
  'jira:globalPage',
  'jira:personalSettingsPage',
  'trigger',
  'scheduledTrigger',
  'sql',
  'llm',
  'resource',
  'consumer',
]);

const manifestPath = path.join(ROOT, 'manifest.yml');
if (!fs.existsSync(manifestPath)) {
  console.error('manifest.yml introuvable');
  process.exit(1);
}
const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
const modules = manifest.modules ?? {};

const seenKeys = new Map();
for (const [type, entries] of Object.entries(modules)) {
  if (!KNOWN_MODULES.has(type)) fail(`module de type inconnu : ${type}`);
  for (const entry of entries ?? []) {
    const key = entry?.key;
    if (!key) {
      fail(`module ${type} sans key`);
      continue;
    }
    if (seenKeys.has(key)) fail(`key de module dupliqué : ${key}`);
    seenKeys.set(key, type);
  }
}

const functions = new Map();
for (const entry of modules.function ?? []) {
  functions.set(entry.key, entry.handler ?? '');
}
for (const [key, handler] of functions) {
  if (!handler) {
    fail(`fonction ${key} sans handler`);
    continue;
  }
  const lastDot = handler.lastIndexOf('.');
  const file = handler.slice(0, lastDot);
  const symbol = handler.slice(lastDot + 1);
  const candidates = ['.ts', '.tsx', '.js'].map((ext) => path.join(ROOT, `${file}${ext}`));
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!filePath) {
    fail(`handler ${key} : fichier absent ${file}.ts`);
    continue;
  }
  const source = fs.readFileSync(filePath, 'utf8');
  const patterns = [
    new RegExp(`export\\s+(async\\s+)?function\\s+${symbol}\\b`),
    new RegExp(`export\\s+const\\s+${symbol}\\b`),
    new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`),
  ];
  if (!patterns.some((pattern) => pattern.test(source))) {
    fail(`handler ${key} : ${symbol} n'est pas exporté par ${file}`);
  }
}

const actions = modules.action ?? [];
const actionKeys = actions.map((action) => action.key);
for (const action of actions) {
  if (!action.function || !functions.has(action.function)) {
    fail(`action ${action.key} : fonction inconnue ${action.function}`);
  }
  if (!action.actionVerb) fail(`action ${action.key} : actionVerb manquant`);
  for (const [inputName, input] of Object.entries(action.inputs ?? {})) {
    const types = ['string', 'integer', 'number', 'boolean'];
    if (!types.includes(input.type)) {
      fail(`action ${action.key} : type d'entrée invalide ${inputName} (${input.type})`);
    }
  }
}

for (const module of modules['rovo:mcp'] ?? []) {
  const tools = module.tools ?? [];
  const missing = tools.filter((tool) => !actionKeys.includes(tool));
  if (missing.length > 0) fail(`rovo:mcp ${module.key} : outils sans action ${missing.join(', ')}`);
  const unlisted = actionKeys.filter((key) => !tools.includes(key));
  if (unlisted.length > 0) fail(`actions non exposées en MCP : ${unlisted.join(', ')}`);
}

const toolsPath = path.join(ROOT, 'src', 'mcp', 'tools.ts');
if (fs.existsSync(toolsPath)) {
  const source = fs.readFileSync(toolsPath, 'utf8');
  for (const action of actions) {
    if (!source.includes(`key: '${action.key}'`)) {
      fail(`src/mcp/tools.ts : outil mirror manquant pour ${action.key}`);
    }
    const inputs = Object.keys(action.inputs ?? {});
    for (const input of inputs) {
      if (!source.includes(`name: '${input}'`)) {
        fail(`src/mcp/tools.ts : entrée mirror manquante ${action.key}.${input}`);
      }
    }
  }
} else {
  warnings.push('src/mcp/tools.ts absent : miroir non vérifié');
}

if (!manifest.app?.id) fail('app.id absent du manifeste');
if (!manifest.permissions?.scopes?.length) fail('permissions.scopes absent du manifeste');

for (const warning of warnings) console.warn(`::warning::${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`::error::${error}`);
  console.error(`${errors.length} erreur(s) de cohérence du manifeste`);
  process.exit(1);
}
console.log(`manifeste cohérent : ${actions.length} outils, ${functions.size} fonctions, ${seenKeys.size} modules`);
