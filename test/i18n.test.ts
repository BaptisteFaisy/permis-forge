/**
 * Unit tests for the bilingual UI layer (spec §19 "Langues").
 */
import { SUPPORTED_LANGS, UI_STRINGS, detectLang, missingKeys, statusLabel, t } from '../src/ui/i18n';
import { createMemoryRepositories } from '../src/storage/memory';
import { createResolvers, callResolver } from '../src/ui/resolvers';
import { createDecisionEngine } from '../src/core/pipeline';
import { classifyAction } from '../src/core/classify';
import { resolvePolicy } from '../src/core/policy';
import { consumePermitUse, isPermitActive, permitCovers } from '../src/core/permits';
import { makeEntry, verifyChain } from '../src/core/ledger';
import { maskSecrets } from '../src/core/mask';
import { trustAdjustLevel } from '../src/core/trust';

describe('i18n dictionary', () => {
  it('has the same keys translated in every supported language', () => {
    for (const lang of SUPPORTED_LANGS) {
      expect(missingKeys(lang)).toEqual([]);
    }
  });

  it('covers both languages for every key, with no copy of the English text', () => {
    const identical = Object.keys(UI_STRINGS).filter(
      (key) => UI_STRINGS[key].en === UI_STRINGS[key].fr,
    );
    expect(identical).toEqual([]);
  });

  it('interpolates variables', () => {
    expect(t('en', 'banner.chainValid', { checked: 12 })).toContain('12');
    expect(t('fr', 'banner.chainValid', { checked: 12 })).toContain('12');
  });

  it('falls back to the key for an unknown entry and to English for an unknown language', () => {
    expect(t('en', 'does.not.exist')).toBe('does.not.exist');
    expect(t('de' as any, 'action.grant')).toBe(UI_STRINGS['action.grant'].en);
  });

  it('labels a known status and passes an unknown one through', () => {
    expect(statusLabel('fr', 'pending')).toBe('En attente');
    expect(statusLabel('en', 'pending')).toBe('Pending');
    expect(statusLabel('fr', 'weird')).toBe('weird');
  });
});

describe('detectLang', () => {
  it('prefers an explicit payload language', () => {
    expect(detectLang({ lang: 'fr' }, { locale: 'en-US' })).toBe('fr');
  });

  it('reads the Atlassian locale when the payload says nothing', () => {
    expect(detectLang({}, { locale: 'fr-FR' })).toBe('fr');
    expect(detectLang({}, { extension: { locale: 'fr_CA' } })).toBe('fr');
  });

  it('defaults to English', () => {
    expect(detectLang({}, {})).toBe('en');
    expect(detectLang({ lang: 'de' }, {})).toBe('en');
  });
});

describe('screens are bilingual at identical shape', () => {
  function buildResolver() {
    const repos = createMemoryRepositories();
    const engine = createDecisionEngine({
      repos,
      secret: 'i18n-secret',
      classify: classifyAction,
      resolve: resolvePolicy,
      isPermitActive,
      permitCovers,
      consumePermitUse,
      maskSecrets,
      makeEntry,
      adjustLevel: trustAdjustLevel,
    });
    return { repos, resolver: createResolvers({ repos, engine, verifyChain }) };
  }

  it('returns the same keys in French and English, with different wording', async () => {
    const first = buildResolver();
    const second = buildResolver();
    const en = await callResolver(first.resolver, 'projectSettings', {
      payload: { projectId: 'PAY', lang: 'en' },
    });
    const fr = await callResolver(second.resolver, 'projectSettings', {
      payload: { projectId: 'PAY', lang: 'fr' },
    });

    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
    expect(en.lang).toBe('en');
    expect(fr.lang).toBe('fr');
    expect(fr.title).not.toBe(en.title);
    expect(fr.catalog[0].name).not.toBe(en.catalog[0].name);
    expect(fr.killSwitchLabels.activate).toBe('Arrêt d’urgence');
  });

  it('localizes the simulation notice and the personal token notice', async () => {
    const first = buildResolver();
    const second = buildResolver();
    const en = await callResolver(first.resolver, 'simulationConsole', {
      payload: { target: 'src/app.ts', actionClass: 'A-02', projectId: 'PAY', lang: 'en' },
    });
    const fr = await callResolver(second.resolver, 'simulationConsole', {
      payload: { target: 'src/app.ts', actionClass: 'A-02', projectId: 'PAY', lang: 'fr' },
    });

    expect(en.guidance).toContain('Simulated only');
    expect(fr.guidance).toContain('Simulation uniquement');
    // Same level, different wording: "N2 — Third-party approval" / "N2 — Approbation…".
    expect(en.levelName.split(' — ')[0]).toBe(fr.levelName.split(' — ')[0]);
    expect(en.levelName).not.toBe(fr.levelName);

    const third = buildResolver();
    const fourth = buildResolver();
    const tokenEn = await callResolver(third.resolver, 'personalSettings', {
      payload: { lang: 'en' },
      context: { accountId: 'pilot-1' },
    });
    const tokenFr = await callResolver(fourth.resolver, 'personalSettings', {
      payload: { lang: 'fr' },
      context: { accountId: 'pilot-1' },
    });
    expect(tokenEn.notice).toContain('shown once');
    expect(tokenFr.notice).toContain('affiché qu’une fois');
  });

  it('shows the emergency stop banner in the requested language', async () => {
    const { repos, resolver } = buildResolver();
    await repos.killSwitches.save({
      scope: 'project',
      projectId: 'PAY',
      active: true,
      by: 'admin',
      reason: 'Drill',
      at: '2026-11-11T10:00:00.000Z',
    });
    await repos.requests.create({
      id: 'RQ-2026-000001',
      issueId: 'PAY-1',
      projectId: 'PAY',
      profileId: 'claude-pay',
      pilotAccountId: 'pilot-1',
      actionClass: 'A-08',
      target: 'db/migrations/001.sql',
      level: 2,
      status: 'pending',
      createdAt: '2026-11-11T10:00:00.000Z',
      approvals: [],
    });

    const fr = await callResolver(resolver, 'issuePanel', {
      payload: { lang: 'fr' },
      context: { extension: { issue: { key: 'PAY-1' }, project: { key: 'PAY' } } },
    });

    expect(fr.killSwitchBanner).toBe('Arrêt d’urgence actif : toute action au-delà de la lecture est refusée.');
    expect(fr.pendingRequests[0].statusLabel).toBe('En attente');
    expect(fr.actions.grant).toBe('Accorder');
  });
});
