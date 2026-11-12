#!/usr/bin/env node
/**
 * Vérificateur d'affirmations — confronte chaque chiffre écrit dans docs/ à la
 * réalité du dépôt (et, en mode --live, à l'état réellement déployé).
 *
 * Pourquoi ce fichier existe : les docs de ce projet ont déjà menti. « 9 tables »
 * alors qu'il y en a 10 depuis l'ajout de `token_revocation` ; « 364 tests dans
 * 30 suites » alors que la suite en compte 502 dans 40 ; « 18 checks, 18 OK »
 * alors que le harnais en fait 26. Un chiffre écrit à la main se périme en
 * silence — un chiffre vérifié automatiquement ne ment jamais sans que la CI le
 * dise en rouge.
 *
 * Usage :
 *   node scripts/verify-claims.mjs                 # hors ligne (dépôt seul)
 *   node scripts/verify-claims.mjs --live          # + état déployé (réseau)
 *   node scripts/verify-claims.mjs --json          # sortie machine
 *   node scripts/verify-claims.mjs --jest-json f   # réutilise un rapport jest
 *
 * Code de sortie : 0 si toutes les affirmations trouvées sont conformes,
 * 1 sinon.
 *
 * Deux échappatoires, à utiliser avec discernement :
 *   - une section marquée `<!-- claims: historique -->` n'est pas auditée
 *     (elle décrit un état daté, pas l'état courant) ;
 *   - une affirmation peut déclarer `exclude:` (limites de la plateforme,
 *     par exemple « 50 outils au plus »).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const ts = require('typescript');
const ROOT = path.resolve(process.cwd());
const DOCS_DIR = path.join(ROOT, 'docs');
const DEPLOY_STATE = path.join(os.homedir(), '.atlassian', 'permis-deploy-state.json');
const HISTORIQUE = /<!--\s*claims:\s*historique\s*-->/;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { live: false, json: false, jestJson: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--json') args.json = true;
    else if (a === '--jest-json') args.jestJson = argv[(i += 1)];
  }
  return args;
}

// --------------------------------------------------------------- réalités

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Compte des tests et des suites : rapport jest s'il existe, sinon on le produit. */
function jestFacts(args) {
  const file = args.jestJson || path.join(os.tmpdir(), `jest-claims-${process.pid}.json`);
  if (!args.jestJson) {
    execFileSync('npx', ['jest', '--json', `--outputFile=${file}`, '--silent'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
  }
  const report = readJson(file);
  if (!args.jestJson) fs.rmSync(file, { force: true });
  return { tests: report.numTotalTests, suites: report.numTotalTestSuites };
}

/** Ce que le manifeste déclare : outils MCP, fonctions, actions. */
function manifestFacts() {
  const manifest = yaml.load(fs.readFileSync(path.join(ROOT, 'manifest.yml'), 'utf8'));
  const modules = manifest.modules ?? {};
  const mcp = modules['rovo:mcp'] ?? [];
  const tools = mcp.reduce((n, entry) => n + (entry.tools ?? []).length, 0);
  return {
    tools,
    functions: (modules.function ?? []).length,
    actions: (modules.action ?? []).length,
  };
}

/** Ce que le schéma crée réellement : tables et instructions DDL (analyse TS). */
function schemaFacts() {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'storage', 'schema.ts'), 'utf8');
  const file = ts.createSourceFile('schema.ts', source, ts.ScriptTarget.Latest, true);
  let array = null;
  file.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const decl of node.declarationList.declarations) {
      if (decl.name.getText(file) === 'SCHEMA_DDL' && ts.isArrayLiteralExpression(decl.initializer)) {
        array = decl.initializer;
      }
    }
  });
  if (!array) return { tables: 0, statements: 0 };
  const texts = array.elements.map((el) => el.getText(file));
  return {
    tables: texts.filter((t) => t.includes('CREATE TABLE IF NOT EXISTS')).length,
    statements: texts.length,
  };
}

/** Nombre de scénarios d'acceptation rejouables hors ligne. */
function scenarioFacts() {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'scenarios.ts'), 'utf8');
  return { scenarios: (source.match(/^\s*\{ id: \d+, title:/gm) ?? []).length };
}

/** Version réellement déployée, capturée par scripts/deploy.sh au déploiement. */
function deployFacts() {
  if (!fs.existsSync(DEPLOY_STATE)) return null;
  try {
    return readJson(DEPLOY_STATE);
  } catch {
    return null;
  }
}

/** Harnais live : compte les contrôles passés et les échecs. */
function harnessFacts() {
  const output = execFileSync('bash', ['scripts/regression-live.sh'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 900_000,
  });
  return {
    checks: (output.match(/\[OK\]/g) ?? []).length,
    failures: (output.match(/\[ÉCHEC\]/g) ?? []).length,
  };
}

// ---------------------------------------------------------- affirmations

/**
 * Chaque entrée décrit un motif présent dans la documentation et la façon de
 * lire le chiffre correspondant. `pick` transforme la capture en objet
 * {clé: nombre annoncé par le document} ; `facts` donne la réalité.
 */
const CLAIMS = [
  {
    id: 'tests',
    label: 'tests unitaires',
    re: /(\d+)\s+offline unit tests in (\d+)\s+Jest suites/,
    pick: (m) => ({ tests: Number(m[1]), suites: Number(m[2]) }),
    facts: (args) => jestFacts(args),
  },
  {
    id: 'tables',
    label: 'tables de stockage',
    re: /\b(\d+)\s+tables\b/g,
    pick: (m) => ({ tables: Number(m[1]) }),
    facts: () => schemaFacts(),
  },
  {
    id: 'ddl',
    label: 'instructions DDL',
    re: /\b(\d+)\s+DDL statements\b/g,
    pick: (m) => ({ statements: Number(m[1]) }),
    facts: () => schemaFacts(),
  },
  {
    id: 'tools',
    label: 'outils MCP',
    re: /\b(\d+)\s+(?:MCP\s+)?tools\b|\b(\d+)\s+outils\b/g,
    // « 50 tools at most » est une limite de la plateforme, pas notre compte.
    exclude: /at most|au plus/i,
    pick: (m) => ({ tools: Number(m[1] ?? m[2]) }),
    facts: () => manifestFacts(),
  },
  {
    id: 'functions',
    label: 'fonctions',
    re: /\b(\d+)\s+functions\b|\b(\d+)\s+fonctions\b/g,
    pick: (m) => ({ functions: Number(m[1] ?? m[2]) }),
    facts: () => manifestFacts(),
  },
  {
    id: 'scenarios',
    label: "scénarios d'acceptation",
    re: /(\d+)\/(\d+)\s+acceptance scenarios/g,
    pick: (m) => ({ scenarios: Number(m[1]) }),
    facts: () => scenarioFacts(),
  },
  {
    id: 'app-version',
    label: 'version déployée',
    re: /app version \*\*(\d+\.\d+\.\d+)\*\*/g,
    // L'environnement se déduit de la ligne citée (« development », « production »).
    pick: (m, lineText) => ({
      version: m[1],
      env: /production/i.test(lineText) ? 'production' : 'development',
    }),
    facts: () => deployFacts(),
    live: true,
  },
  {
    id: 'harness',
    label: 'contrôles du harnais live',
    re: /harnais live \*\*(\d+)\/(\d+)\*\*/g,
    pick: (m) => ({ checks: Number(m[1]) }),
    facts: () => harnessFacts(),
    live: true,
  },
  {
    id: 'live-replay',
    label: 'rejeu live',
    re: /\*\*(\d+) checks, (\d+) OK\*\*/g,
    pick: (m) => ({ checks: Number(m[1]) }),
    facts: () => harnessFacts(),
    live: true,
  },
];

// ------------------------------------------------------------- extraction

/** Découpe un document en sections de titre de niveau 2 (avec leurs sous-sections). */
function sectionsOf(text) {
  const lines = text.split('\n');
  const sections = [];
  let start = 0;
  let heading = '(début)';
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^##\s/.test(lines[i])) continue;
    if (i > start) sections.push({ heading, start: start + 1, end: i });
    heading = lines[i];
    start = i;
  }
  sections.push({ heading, start: start + 1, end: lines.length });
  return sections;
}

/** Découpe un document en blocs (paragraphes séparés par une ligne vide). */
function blocksOf(lines) {
  const blocks = [];
  let start = 0;
  for (let i = 0; i <= lines.length; i += 1) {
    const blank = i === lines.length || lines[i].trim() === '';
    if (!blank) continue;
    if (i > start) blocks.push({ start: start + 1, end: i });
    start = i + 1;
  }
  return blocks;
}

/**
 * Le marqueur `historique` excuses une affirmation : il saute soit le
 * paragraphe qui le porte, soit la section entière qui le contient.
 */
function isHistorique(section, block, lines) {
  const inSection = section
    ? lines.slice(section.start - 1, section.end).some((l) => HISTORIQUE.test(l))
    : false;
  const inBlock = block ? lines.slice(block.start - 1, block.end).some((l) => HISTORIQUE.test(l)) : false;
  return inSection || inBlock;
}

/** Compare les chiffres annoncés et les chiffres réels, clé par clé. */
function compare(expected, reality) {
  const diffs = [];
  for (const [key, want] of Object.entries(expected)) {
    if (key === 'env') continue;
    const got = realityValue(expected, reality, key);
    if (got === undefined || got === null) diffs.push({ key, want, got: null });
    else if (String(got) !== String(want)) diffs.push({ key, want, got });
  }
  return diffs;
}

/** Choisit la réalité : par environnement quand la citation en nomme un. */
function realityValue(expected, reality, key) {
  if (expected.env && reality && typeof reality === 'object' && expected.env in reality) {
    const entry = reality[expected.env];
    return entry && typeof entry === 'object' ? entry[key] : entry;
  }
  return reality?.[key];
}

/** Parcourt les documents et ramène une ligne par affirmation trouvée. */
function collect(args) {
  const rows = [];
  const files = fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md')).sort();
  for (const claim of CLAIMS) {
    if (claim.live && !args.live) continue;
    const { reality, error } = realityOf(claim, args);
    for (const file of files) {
      rows.push(...scanFile(claim, file, reality, error));
    }
  }
  return rows;
}

/** Réalité d'une affirmation : la valeur, ou le message d'échec. */
function realityOf(claim, args) {
  try {
    return { reality: claim.facts(args), error: null };
  } catch (err) {
    return { reality: null, error: err.message ?? String(err) };
  }
}

/** Affirmations d'un document donné. */
function scanFile(claim, file, reality, realityError) {
  const text = fs.readFileSync(path.join(DOCS_DIR, file), 'utf8');
  const lines = text.split('\n');
  const sections = sectionsOf(text);
  const blocks = blocksOf(lines);
  const flags = claim.re.flags.includes('g') ? claim.re.flags : `${claim.re.flags}g`;
  const re = new RegExp(claim.re.source, flags);
  const rows = [];
  let match = re.exec(text);
  while (match) {
    const line = text.slice(0, match.index).split('\n').length;
    const section = sections.find((s) => line >= s.start && line <= s.end);
    const block = blocks.find((b) => line >= b.start && line <= b.end);
    const lineText = lines[line - 1] ?? '';
    const skipped = isHistorique(section, block, lines) ||
      (claim.exclude && claim.exclude.test(lineText));
    if (!skipped) rows.push(buildRow(claim, file, line, lineText, match, reality, realityError));
    match = re.exec(text);
  }
  return rows;
}

/** Une ligne du rapport : ce que le doc dit, ce que la réalité dit, le verdict. */
function buildRow(claim, file, line, lineText, match, reality, realityError) {
  const expected = claim.pick(match, lineText);
  const diffs = realityError ? [] : compare(expected, reality);
  return {
    id: claim.id,
    label: claim.label,
    doc: `docs/${file}`,
    line,
    expected,
    reality,
    diffs,
    status: realityError ? 'ERREUR' : diffs.length === 0 ? 'OK' : 'PÉRIMÉ',
    error: realityError,
  };
}

// ------------------------------------------------------------------ sortie

function render(rows) {
  return rows
    .map((row) => {
      const mark = row.status === 'OK' ? '✔' : row.status === 'ERREUR' ? '!' : '✘';
      const said = Object.entries(row.expected).map(([k, v]) => `${k}=${v}`).join(' ');
      const got = row.reality
        ? Object.keys(row.expected).map((k) => `${k}=${row.reality[k] ?? '?'}`).join(' ')
        : (row.error ?? '—').slice(0, 60);
      return `${mark} ${row.id.padEnd(12)} ${row.doc}:${row.line}  doc: ${said}  réel: ${got}`;
    })
    .join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = collect(args);
  const ko = rows.filter((r) => r.status === 'PÉRIMÉ');
  const erreurs = rows.filter((r) => r.status === 'ERREUR');

  if (args.json) {
    console.log(JSON.stringify({
      ok: ko.length === 0 && erreurs.length === 0,
      total: rows.length,
      perimes: ko.length,
      erreurs: erreurs.length,
      rows: rows.map((r) => ({
        id: r.id,
        doc: r.doc,
        line: r.line,
        status: r.status,
        expected: r.expected,
        reality: r.reality,
        error: r.error,
      })),
    }, null, 2));
  } else {
    console.log("Vérificateur d'affirmations — docs confrontées à la réalité");
    console.log(render(rows));
    console.log('');
    console.log(`${rows.length} affirmation(s) vérifiée(s), ${ko.length} périmée(s), ${erreurs.length} erreur(s).`);
    if (ko.length) console.log('→ les documents ci-dessus mentent : les corriger.');
  }
  process.exit(ko.length || erreurs.length ? 1 : 0);
}

main();
