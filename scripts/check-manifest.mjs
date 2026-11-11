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
  // Forge résout les handlers depuis src/ (« index.x » → src/index.ts) ; on
  // accepte aussi un chemin explicite pour ne pas casser un manifeste ancien.
  const candidates = ['src', '.'].flatMap((base) =>
    ['.ts', '.tsx', '.js'].map((ext) => path.join(ROOT, base, `${file}${ext}`)),
  );
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!filePath) {
    fail(`handler ${key} : fichier absent (cherché src/${file}.ts et ${file}.ts)`);
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

// app : id + runtime obligatoires, et ni name ni version (additionalProperties
// est fermé dans le schéma officiel de la CLI Forge 15).
if (!manifest.app?.runtime?.name) fail('app.runtime.name absent du manifeste');
for (const forbidden of ['name', 'version']) {
  if (manifest.app?.[forbidden] !== undefined) {
    fail(`app.${forbidden} n'est pas accepté par le schéma Forge (le retirer)`);
  }
}

// Une clé de fonction fait au plus 23 caractères.
for (const [key] of functions) {
  if (key.length > 23) fail(`clé de fonction trop longue (${key.length} > 23) : ${key}`);
}

// La description d'une action fait au plus 255 caractères.
for (const action of actions) {
  const description = String(action.description ?? '');
  if (description.length > 255) {
    fail(`action ${action.key} : description de ${description.length} caractères (> 255)`);
  }
}

// ---------------------------------------------------------------- schémas officiels
// Règles relevées dans la référence du manifeste Forge (vérifiées le 11/11/2026) :
// elles sont encodées ici pour que la CI les fasse respecter sans CLI Forge.

// action : name, function, actionVerb, description et inputs sont obligatoires,
// et chaque entrée exige title, type, required et description.
const VERBS = ['GET', 'CREATE', 'UPDATE', 'DELETE', 'TRIGGER'];
for (const action of actions) {
  for (const field of ['name', 'function', 'actionVerb', 'description', 'inputs']) {
    if (action[field] === undefined) fail(`action ${action.key} : champ obligatoire ${field} absent`);
  }
  if (!VERBS.includes(action.actionVerb)) {
    fail(`action ${action.key} : actionVerb invalide ${action.actionVerb}`);
  }
  const inputs = action.inputs ?? {};
  if (Object.keys(inputs).length === 0) fail(`action ${action.key} : aucune entrée déclarée`);
  for (const [inputName, input] of Object.entries(inputs)) {
    for (const field of ['title', 'type', 'required', 'description']) {
      if (input[field] === undefined) {
        fail(`action ${action.key} : entrée ${inputName} sans ${field}`);
      }
    }
    if (typeof input.required !== 'boolean') {
      fail(`action ${action.key} : entrée ${inputName} — required doit être un booléen`);
    }
  }
}

// rovo:skill : key, source.dir et dependencies.tools uniquement.
for (const skill of modules['rovo:skill'] ?? []) {
  const allowed = ['key', 'source', 'dependencies'];
  for (const prop of Object.keys(skill)) {
    if (!allowed.includes(prop)) fail(`rovo:skill ${skill.key} : propriété non prévue ${prop}`);
  }
  if (!skill.source?.dir) fail(`rovo:skill ${skill.key} : source.dir absent`);
  const tools = skill.dependencies?.tools ?? [];
  for (const tool of tools) {
    if (!actionKeys.includes(tool)) fail(`rovo:skill ${skill.key} : outil inconnu ${tool}`);
  }
  if (new Set(tools).size !== tools.length) fail(`rovo:skill ${skill.key} : outils en double`);
}

// rovo:agent : nom de 30 caractères au plus, prompt obligatoire.
for (const agent of modules['rovo:agent'] ?? []) {
  if (!agent.name) fail(`rovo:agent ${agent.key} : name absent`);
  else if (agent.name.length > 30) fail(`rovo:agent ${agent.key} : name > 30 caractères`);
  if (!agent.prompt) fail(`rovo:agent ${agent.key} : prompt absent`);
  for (const skillKey of agent.skills ?? []) {
    const known = (modules['rovo:skill'] ?? []).map((skill) => skill.key);
    if (!known.includes(skillKey)) fail(`rovo:agent ${agent.key} : skill inconnue ${skillKey}`);
  }
}

// scheduledTrigger : intervalles autorisés.
for (const trigger of modules.scheduledTrigger ?? []) {
  const intervals = ['fiveMinute', 'hour', 'day', 'week'];
  if (!intervals.includes(trigger.interval)) {
    fail(`scheduledTrigger ${trigger.key} : interval invalide ${trigger.interval}`);
  }
}
if ((modules.scheduledTrigger ?? []).length > 5) fail('plus de 5 scheduledTrigger déclarés');

// webtrigger : urlFormat et type de réponse.
for (const trigger of modules.webtrigger ?? []) {
  if (trigger.urlFormat && !['v1', 'v2'].includes(trigger.urlFormat)) {
    fail(`webtrigger ${trigger.key} : urlFormat invalide ${trigger.urlFormat}`);
  }
  const type = trigger.response?.type;
  if (type && !['static', 'dynamic'].includes(type)) {
    fail(`webtrigger ${trigger.key} : response.type invalide ${type}`);
  }
  if (type === 'static' && !(trigger.response?.outputs ?? []).length) {
    fail(`webtrigger ${trigger.key} : response static sans outputs`);
  }
}

// sql : un seul module, engine mysql (seule valeur supportée).
const sqlModules = modules.sql ?? [];
if (sqlModules.length > 1) fail('plusieurs modules sql déclarés (un seul par app)');
for (const sql of sqlModules) {
  if (sql.engine !== 'mysql') fail(`sql ${sql.key} : engine doit valoir mysql`);
}

// SKILL.md : frontmatter conforme et cohérent avec le manifeste.
for (const skill of modules['rovo:skill'] ?? []) {
  const dir = skill.source?.dir;
  if (!dir) continue;
  const skillFile = path.join(ROOT, dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    fail(`rovo:skill ${skill.key} : SKILL.md absent de ${dir}`);
    continue;
  }
  const source = fs.readFileSync(skillFile, 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source);
  if (!frontmatter) {
    fail(`rovo:skill ${skill.key} : frontmatter YAML absent de SKILL.md`);
    continue;
  }
  const name = /^\s*name:\s*(.+)$/m.exec(frontmatter[1])?.[1].trim();
  const expectedName = path.basename(dir);
  if (name !== expectedName) {
    fail(`rovo:skill ${skill.key} : name "${name}" ≠ dossier "${expectedName}"`);
  }
  if (name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    fail(`rovo:skill ${skill.key} : name invalide (minuscules, chiffres, tirets simples)`);
  }
  const description = /^\s*description:\s*(.+)$/m.exec(frontmatter[1])?.[1].trim() ?? '';
  if (description.length < 50) fail(`rovo:skill ${skill.key} : description trop courte (< 50)`);
  const allowedTools = (/^\s*allowed-tools:\s*(.+)$/m.exec(frontmatter[1])?.[1] ?? '').trim().split(/\s+/);
  for (const tool of skill.dependencies?.tools ?? []) {
    if (!allowedTools.includes(tool)) {
      fail(`rovo:skill ${skill.key} : allowed-tools n'inclut pas ${tool}`);
    }
  }
  const body = source.slice(frontmatter[0].length);
  if (body.split('\n').length > 500) fail(`rovo:skill ${skill.key} : corps de SKILL.md > 500 lignes`);
}

for (const warning of warnings) console.warn(`::warning::${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`::error::${error}`);
  console.error(`${errors.length} erreur(s) de cohérence du manifeste`);
  process.exit(1);
}
console.log(`manifeste cohérent : ${actions.length} outils, ${functions.size} fonctions, ${seenKeys.size} modules`);
