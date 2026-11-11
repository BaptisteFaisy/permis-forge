/**
 * Bilingual UI strings (spec §19: "Interface en anglais et en français").
 *
 * One dictionary, one lookup function. Class names and level names already live
 * in src/core/catalog.ts with a `lang` parameter — they are reused, never
 * duplicated here. Every screen detects the language once (payload, then
 * Atlassian context, then 'en') and passes it down.
 */

export type Lang = 'en' | 'fr';

export const SUPPORTED_LANGS: Lang[] = ['en', 'fr'];

/** Key → translation per language. Keys are grouped by surface. */
export const UI_STRINGS: Record<string, Record<Lang, string>> = {
  'screen.issuePanel.title': { en: 'Agent permits', fr: 'Permis d’agir' },
  'screen.projectSettings.title': { en: 'Agent policy', fr: 'Politique des agents' },
  'screen.projectPage.title': { en: 'Agent activity', fr: 'Activité des agents' },
  'screen.simulation.title': { en: 'Simulation console', fr: 'Console de simulation' },
  'screen.globalPage.title': { en: 'Organisation policy', fr: 'Politique d’organisation' },
  'screen.personalSettings.title': { en: 'My hook token', fr: 'Mon jeton de hook' },

  'action.grant': { en: 'Grant', fr: 'Accorder' },
  'action.deny': { en: 'Deny', fr: 'Refuser' },
  'action.clarify': { en: 'Ask for details', fr: 'Demander une précision' },
  'action.revoke': { en: 'Revoke permit', fr: 'Révoquer le permis' },
  'action.generateToken': { en: 'Generate token', fr: 'Générer un jeton' },
  'action.verifyLedger': { en: 'Verify journal', fr: 'Vérifier le journal' },
  'action.exportCsv': { en: 'Export CSV', fr: 'Exporter en CSV' },
  'action.exportConfluence': { en: 'Export to Confluence', fr: 'Exporter vers Confluence' },
  'action.activateKillSwitch': { en: 'Emergency stop', fr: 'Arrêt d’urgence' },
  'action.liftKillSwitch': { en: 'Lift emergency stop', fr: 'Lever l’arrêt d’urgence' },

  'status.pending': { en: 'Pending', fr: 'En attente' },
  'status.granted': { en: 'Granted', fr: 'Accordée' },
  'status.denied': { en: 'Denied', fr: 'Refusée' },
  'status.frozen': { en: 'Frozen', fr: 'Gelée' },
  'status.expired': { en: 'Expired', fr: 'Expirée' },
  'status.clarification': { en: 'Clarification requested', fr: 'Précision demandée' },

  'column.seq': { en: 'Seq', fr: 'N°' },
  'column.at': { en: 'When', fr: 'Quand' },
  'column.kind': { en: 'Kind', fr: 'Type' },
  'column.issue': { en: 'Issue', fr: 'Ticket' },
  'column.agent': { en: 'Agent profile', fr: 'Profil d’agent' },
  'column.class': { en: 'Class', fr: 'Classe' },
  'column.target': { en: 'Target', fr: 'Cible' },
  'column.rule': { en: 'Rule', fr: 'Règle' },
  'column.decision': { en: 'Decision', fr: 'Décision' },
  'column.permit': { en: 'Permit', fr: 'Permis' },
  'column.level': { en: 'Level', fr: 'Niveau' },
  'column.status': { en: 'Status', fr: 'État' },
  'column.capital': { en: 'Trust capital', fr: 'Capital de confiance' },

  'notice.tokenShownOnce': {
    en: 'This token is shown once. Store it in PERMIS_AGENT_TOKEN.',
    fr: 'Ce jeton n’est affiché qu’une fois. Rangez-le dans PERMIS_AGENT_TOKEN.',
  },
  'notice.onlyHashStored': {
    en: 'Only the hash of a token is stored (spec §16).',
    fr: 'Seule l’empreinte du jeton est conservée (spec §16).',
  },
  'notice.simulation': {
    en: 'Simulated only: nothing was written, no permit was consumed.',
    fr: 'Simulation uniquement : rien n’a été écrit, aucun permis consommé.',
  },
  'banner.killSwitch': {
    en: 'Emergency stop active: every action beyond reading is refused.',
    fr: 'Arrêt d’urgence actif : toute action au-delà de la lecture est refusée.',
  },
  'banner.chainBroken': {
    en: 'The journal chain is broken: see the first broken entry below.',
    fr: 'La chaîne du journal est rompue : voir la première entrée cassée ci-dessous.',
  },
  'banner.chainValid': {
    en: 'Journal chain verified: {checked} entries, no break.',
    fr: 'Chaîne du journal vérifiée : {checked} entrées, aucune rupture.',
  },

  'error.pilotCannotApprove': {
    en: 'The pilot of the agent cannot approve their own request.',
    fr: 'Le pilote de l’agent ne peut pas approuver sa propre demande.',
  },
  'error.notAuthorized': {
    en: 'Your role is not authorized for this action class.',
    fr: 'Votre rôle n’est pas habilité pour cette classe d’action.',
  },
  'error.reasonRequired': {
    en: 'A written reason is required.',
    fr: 'Un motif écrit est obligatoire.',
  },
  'error.differentPersonRequired': {
    en: 'Someone other than who activated the stop must lift it.',
    fr: 'Une autre personne que celle qui a déclenché l’arrêt doit le lever.',
  },
  'error.engineUnavailable': {
    en: 'The decision engine is unavailable.',
    fr: 'Le moteur de décision est indisponible.',
  },
};

/** Interpolate `{name}` placeholders; unknown keys return the key itself. */
export function t(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const entry = UI_STRINGS[key];
  if (!entry) return key;
  let text = entry[lang] ?? entry.en ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** Payload wins, then the Atlassian context locale, then English. */
export function detectLang(payload: any, context: any): Lang {
  const candidates = [payload?.lang, payload?.locale, context?.locale, context?.extension?.locale];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const normalized = candidate.toLowerCase();
    if (normalized.startsWith('fr')) return 'fr';
    if (normalized.startsWith('en')) return 'en';
    const exact = SUPPORTED_LANGS.find((lang) => normalized === lang);
    if (exact) return exact;
  }
  return 'en';
}

/** Keys missing a translation for a language — used by the parity test. */
export function missingKeys(lang: Lang): string[] {
  return Object.keys(UI_STRINGS).filter((key) => {
    const value = UI_STRINGS[key][lang];
    return typeof value !== 'string' || value.trim().length === 0;
  });
}

/** Localized label of a request/permit status, falling back to the raw value. */
export function statusLabel(lang: Lang, status: string): string {
  const translated = t(lang, `status.${status}`);
  return translated === `status.${status}` ? status : translated;
}
