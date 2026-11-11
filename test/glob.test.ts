import { globToRegExp, isGlobPattern, pathMatches, targetCovers } from '../src/core/glob';

describe('glob', () => {
  it('matches ** across segments', () => {
    expect(pathMatches('**/migrations/**', 'db/migrations/001_init.sql')).toBe(true);
    expect(pathMatches('**/migrations/**', 'migrations/001_init.sql')).toBe(true);
    expect(pathMatches('**/migrations/**', 'db/seeds/001.sql')).toBe(false);
  });

  it('matches * within a single segment', () => {
    expect(pathMatches('src/*.ts', 'src/index.ts')).toBe(true);
    expect(pathMatches('src/*.ts', 'src/core/index.ts')).toBe(false);
  });

  it('matches ? as a single character', () => {
    expect(pathMatches('file?.txt', 'file1.txt')).toBe(true);
    expect(pathMatches('file?.txt', 'file12.txt')).toBe(false);
  });

  it('falls back to basename for slash-free patterns', () => {
    expect(pathMatches('Jenkinsfile', 'ci/Jenkinsfile')).toBe(true);
    expect(pathMatches('.gitlab-ci.yml', 'ops/.gitlab-ci.yml')).toBe(true);
  });

  it('ignores a leading ./', () => {
    expect(pathMatches('./src/*.ts', 'src/index.ts')).toBe(true);
    expect(pathMatches('src/*.ts', './src/index.ts')).toBe(true);
  });

  it('detects glob patterns and covers targets', () => {
    expect(isGlobPattern('src/**')).toBe(true);
    expect(isGlobPattern('src/index.ts')).toBe(false);
    expect(targetCovers('db/users.sql', 'db/users.sql')).toBe(true);
    expect(targetCovers('db/**', 'db/tables/users.sql')).toBe(true);
    expect(targetCovers('db/users.sql', 'db/orders.sql')).toBe(false);
  });

  it('anchors the pattern (no partial matches)', () => {
    expect(globToRegExp('src/*.ts').test('app/src/index.ts')).toBe(false);
    // Slash-free patterns fall back to the basename: "*.env" reaches any dir.
    expect(pathMatches('*.env', 'prod/secrets/.env')).toBe(true);
    expect(pathMatches('src/*.ts', 'src/nested/index.ts')).toBe(false);
  });
});
