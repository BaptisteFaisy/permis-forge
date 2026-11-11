import { ActionRequest, PolicyRule, Zone } from '../src/core/types';
import {
  componentOf,
  findMatchingZones,
  ruleMatchesZone,
  zoneMatchesAction,
} from '../src/core/zones';

const baseAction: ActionRequest = {
  projectId: 'PAY',
  target: 'api/src/migrations/002_add_users.sql',
  environment: 'staging',
};

const migrationsZone: Zone = {
  id: 'zone-mig',
  projectId: 'PAY',
  name: 'Migrations',
  pathPatterns: ['**/migrations/**'],
};

const apiProdZone: Zone = {
  id: 'zone-api-prod',
  projectId: 'PAY',
  name: 'API production',
  pathPatterns: ['api/**'],
  component: 'api',
  environment: 'production',
};

describe('zones', () => {
  it('matches by pathPatterns using glob rules', () => {
    expect(zoneMatchesAction(migrationsZone, baseAction)).toBe(true);
    expect(
      zoneMatchesAction(migrationsZone, { ...baseAction, target: 'api/src/users.ts' }),
    ).toBe(false);
  });

  it('matches any path when pathPatterns is empty', () => {
    const anyPath: Zone = {
      id: 'zone-any',
      projectId: 'PAY',
      name: 'Any path in staging',
      pathPatterns: [],
      environment: 'staging',
    };
    expect(zoneMatchesAction(anyPath, baseAction)).toBe(true);
    expect(zoneMatchesAction(anyPath, { ...baseAction, environment: 'production' })).toBe(false);
  });

  it('requires every constrained field (pathPatterns + component + environment)', () => {
    const prodAction: ActionRequest = { ...baseAction, environment: 'production' };
    expect(zoneMatchesAction(apiProdZone, prodAction, 'api')).toBe(true);
    expect(zoneMatchesAction(apiProdZone, prodAction, 'web')).toBe(false);
    expect(zoneMatchesAction(apiProdZone, baseAction, 'api')).toBe(false);
    expect(zoneMatchesAction(apiProdZone, prodAction, undefined)).toBe(false);
  });

  it('finds all matching zones in order', () => {
    const zones = [migrationsZone, apiProdZone];
    expect(findMatchingZones(zones, baseAction, 'api').map((z) => z.id)).toEqual(['zone-mig']);
    expect(
      findMatchingZones(zones, { ...baseAction, environment: 'production' }, 'api').map(
        (z) => z.id,
      ),
    ).toEqual(['zone-mig', 'zone-api-prod']);
  });

  it('resolves ruleMatchesZone with project isolation and fail-closed on missing zone', () => {
    const unzonedRule: PolicyRule = {
      id: 'r-global',
      scope: 'project',
      projectId: 'PAY',
      actionClass: 'A-08',
      level: 2,
      mode: 'enforce',
    };
    expect(ruleMatchesZone(unzonedRule, [migrationsZone], baseAction)).toBe(true);

    const matchingRule: PolicyRule = { ...unzonedRule, id: 'r-mig', zoneId: 'zone-mig' };
    expect(ruleMatchesZone(matchingRule, [migrationsZone], baseAction)).toBe(true);

    const otherProjectZone: Zone = { ...migrationsZone, projectId: 'BILL' };
    expect(ruleMatchesZone(matchingRule, [otherProjectZone], baseAction)).toBe(false);

    const unknownZoneRule: PolicyRule = { ...unzonedRule, id: 'r-missing', zoneId: 'does-not-exist' };
    expect(ruleMatchesZone(unknownZoneRule, [migrationsZone], baseAction)).toBe(false);
  });

  it('derives component from an explicit field or the leading path segment', () => {
    expect(componentOf({ target: 'api/src/index.ts' })).toBe('api');
    expect(componentOf({ target: 'README.md' })).toBeUndefined();
    const withComponent = Object.assign({ target: 'README.md' }, { component: 'core' });
    expect(componentOf(withComponent)).toBe('core');
  });
});
