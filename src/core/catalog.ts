/**
 * Action class catalog (spec §6) — the fifteen built-in classes with their
 * default autonomy levels, plus helpers for project-defined custom classes.
 *
 * A-15 (touching the policy itself) is locked: an agent can never widen its
 * own rights. Unknown custom classes default to N2 (approval required):
 * a project that defines a class should also define a rule for it.
 */
import { ActionClassDef, AutonomyLevel } from './types';

export const ACTION_CLASSES: ActionClassDef[] = [
  { code: 'A-01', nameEn: 'Read', nameFr: 'Lire', defaultLevel: 5 },
  { code: 'A-02', nameEn: 'Edit application code', nameFr: 'Modifier le code applicatif', defaultLevel: 5 },
  { code: 'A-03', nameEn: 'Edit tests', nameFr: 'Modifier des tests', defaultLevel: 4 },
  { code: 'A-04', nameEn: 'Disable or delete a test', nameFr: 'Désactiver ou supprimer un test', defaultLevel: 2 },
  { code: 'A-05', nameEn: 'Add a dependency', nameFr: 'Ajouter une dépendance', defaultLevel: 3 },
  { code: 'A-06', nameEn: 'Major dependency update', nameFr: 'Mise à jour majeure d’une dépendance', defaultLevel: 2 },
  { code: 'A-07', nameEn: 'Edit CI or deployment', nameFr: 'Modifier la CI ou le déploiement', defaultLevel: 2 },
  { code: 'A-08', nameEn: 'Schema migration', nameFr: 'Migration de schéma', defaultLevel: 2 },
  { code: 'A-09', nameEn: 'Delete or alter data', nameFr: 'Supprimer ou modifier des données', defaultLevel: 1 },
  { code: 'A-10', nameEn: 'Touch secrets or access', nameFr: 'Toucher aux secrets et aux accès', defaultLevel: 0 },
  { code: 'A-11', nameEn: 'Edit infrastructure', nameFr: 'Modifier l’infrastructure', defaultLevel: 2 },
  { code: 'A-12', nameEn: 'Destructive git operation', nameFr: 'Opération Git destructrice', defaultLevel: 0 },
  { code: 'A-13', nameEn: 'Act on production', nameFr: 'Agir en production', defaultLevel: 1 },
  { code: 'A-14', nameEn: 'Send outbound', nameFr: 'Envoyer vers l’extérieur', defaultLevel: 3 },
  { code: 'A-15', nameEn: 'Edit the policy itself', nameFr: 'Modifier la politique elle-même', defaultLevel: 0, locked: true },
];

/** Conservative level for project-defined classes without a catalog entry. */
export const UNKNOWN_CLASS_DEFAULT_LEVEL: AutonomyLevel = 2;

const BY_CODE = new Map(ACTION_CLASSES.map((c) => [c.code, c]));

export function getActionClass(code: string | undefined): ActionClassDef | undefined {
  if (!code) return undefined;
  return BY_CODE.get(code.toUpperCase());
}

export function isKnownClass(code: string | undefined): boolean {
  return getActionClass(code) !== undefined;
}

/** Default level of a class; unknown classes fall back to N2. */
export function defaultLevelFor(code: string): AutonomyLevel {
  return getActionClass(code)?.defaultLevel ?? UNKNOWN_CLASS_DEFAULT_LEVEL;
}

/** Reading is the only class the kill switch never touches (spec §12). */
export function isReadClass(code: string | undefined): boolean {
  return code === 'A-01';
}

/** True when an agent may never be granted this class (locked catalog). */
export function isLockedClass(code: string): boolean {
  return getActionClass(code)?.locked === true;
}

export function className(code: string, lang: 'en' | 'fr'): string {
  const def = getActionClass(code);
  if (!def) return code;
  return lang === 'fr' ? def.nameFr : def.nameEn;
}

export function levelName(level: AutonomyLevel, lang: 'en' | 'fr'): string {
  const names: Record<number, { en: string; fr: string }> = {
    0: { en: 'Forbidden', fr: 'Interdit' },
    1: { en: 'Dual approval', fr: 'Double approbation' },
    2: { en: 'Third-party approval', fr: 'Approbation d’un tiers' },
    3: { en: 'Pilot confirmation', fr: 'Confirmation du pilote' },
    4: { en: 'Autonomous, declared', fr: 'Autonome, déclaré' },
    5: { en: 'Autonomous', fr: 'Autonome' },
  };
  const entry = names[level] ?? { en: `N${level}`, fr: `N${level}` };
  return `N${level} — ${lang === 'fr' ? entry.fr : entry.en}`;
}

/** Most restrictive of two levels = the lower number. */
export function mostRestrictive(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return (a <= b ? a : b) as AutonomyLevel;
}
