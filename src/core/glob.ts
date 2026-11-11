/**
 * Minimal path glob matcher shared by zones, permits and plan matching.
 *
 * Supported syntax:
 * - `**` crosses path segments ("**\/migrations/**" matches "db/migrations/x.sql")
 * - `*` matches within a single segment
 * - `?` matches a single non-separator character
 * - a pattern without `/` also matches the basename ("Jenkinsfile" matches
 *   "ci/Jenkinsfile")
 * Leading "./" is ignored on both sides. Case-sensitive.
 */

function normalize(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function escapeRegExpChar(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** Translate one glob pattern into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const source = normalize(pattern);
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '*') {
      if (source[i + 1] === '*') {
        // "**/" consumes any number of leading segments; bare "**" eats all.
        if (source[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '/') {
      out += '/';
    } else {
      out += escapeRegExpChar(char);
    }
  }
  return new RegExp(`^${out}$`);
}

/** True when `path` matches the glob `pattern` (see module header). */
export function pathMatches(pattern: string, path: string): boolean {
  const target = normalize(path);
  if (globToRegExp(pattern).test(target)) return true;
  // Basename fallback for patterns that carry no directory separator.
  if (!pattern.includes('/') && !pattern.includes('**')) {
    const base = target.slice(target.lastIndexOf('/') + 1);
    return globToRegExp(pattern).test(base);
  }
  return false;
}

/** True when the pattern contains glob wildcards (exact target otherwise). */
export function isGlobPattern(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** Exact match, or glob match when the pattern carries wildcards. */
export function targetCovers(pattern: string, target: string): boolean {
  if (pattern === target) return true;
  return isGlobPattern(pattern) && pathMatches(pattern, target);
}
