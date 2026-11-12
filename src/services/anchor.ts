/**
 * Daily ledger anchoring (spec §11 — third-party verifiability).
 *
 * The hash chain is only checked *inside* the app, so a third party that does
 * not trust it cannot verify anything. This service closes the gap: every
 * night it computes the Merkle root of the day's entry hashes, writes an
 * `anchor` entry into the chain itself, and publishes the root outside the
 * app database (a Confluence page, using the existing storage-format export
 * of src/ui/audit.ts — no duplicated formatting).
 *
 * Contract, identical to src/services/notify.ts ("a notification failure
 * never changes the decision"): the anchor entry is written first, and a
 * publication failure is only logged — never propagated, never fatal.
 */
import { makeEntry } from '../core/ledger';
import { merkleRoot } from '../core/merkle';
import { exportLedgerToConfluenceStorage } from '../ui/audit';
import { AdfNode, bullet, bulletList, code, doc, paragraph, text } from './adf';
import { CommentPoster, defaultPoster } from './notify';
import { AnchorDetail, LedgerEntry, LedgerKind, Repositories } from '../core/types';

/** Kinds excluded from the anchored leaves: the anchors themselves. */
const ANCHOR_KIND: LedgerKind = 'anchor';

export interface AnchorPublication {
  title: string;
  /** Confluence storage format (XHTML). */
  storage: string;
  /** Jira comment body (ADF); absent for Confluence-only publications. */
  adf?: AdfNode;
}

/** Publishes one anchor outside the app database; injected in tests. */
export type AnchorPublisher = (publication: AnchorPublication) => Promise<void>;

export interface AnchorOptions {
  projectId: string;
  /** UTC day to anchor, `YYYY-MM-DD`; defaults to the day of `at`. */
  day?: string;
  /** Timestamp of the anchor entry; defaults to now. */
  at?: string;
  /** Transport; defaults to the Confluence REST publisher, best effort. */
  publisher?: AnchorPublisher;
}

export interface AnchorResult {
  anchored: boolean;
  day: string;
  root?: string;
  count?: number;
  published: boolean;
  /** Why nothing was anchored or published (also logged). */
  error?: string;
}

/** UTC day (`YYYY-MM-DD`) of an ISO-8601 timestamp. */
export function dayOf(at: string): string {
  return at.slice(0, 10);
}

/**
 * Leaves of the daily tree: hashes of the day's entries, ordered by seq,
 * excluding previous `anchor` entries (an anchor never anchors itself).
 */
export function anchorLeaves(entries: LedgerEntry[], day: string): LedgerEntry[] {
  return entries
    .filter((entry) => entry.kind !== ANCHOR_KIND && dayOf(entry.at) === day)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * The Jira comment body: short on purpose — the root, the count, and where to
 * find the verification procedure. The day's entry table stays in Confluence,
 * because a comment holding 200 rows is unreadable.
 */
export function buildAnchorComment(
  projectId: string,
  day: string,
  root: string,
  count: number,
): AdfNode {
  return doc(
    paragraph(text(`Daily ledger anchor — ${day} — ${projectId}`, true)),
    bulletList([
      bullet(text('Entries anchored: ', true), text(String(count))),
      bullet(text('Merkle root: ', true), code(root)),
    ]),
    paragraph(
      text(
        'This comment lives outside the application database, and the app cannot edit or ' +
          'delete it: it is the trust anchor for the day. Verify any entry against this ' +
          'root with the procedure in docs/ANCHORING.md of the app repository.',
      ),
    ),
  );
}

/** The published page: the root, its metadata, and the day's entries table. */
export function buildAnchorPublication(
  projectId: string,
  day: string,
  root: string,
  entries: LedgerEntry[],
): AnchorPublication {
  const table = exportLedgerToConfluenceStorage(entries);
  const storage =
    `<h2>Daily ledger anchor — ${day} — ${projectId}</h2>` +
    `<p>Entries anchored: ${entries.length}</p>` +
    `<p>Merkle root: <code>${root}</code></p>` +
    `<p>Verify any entry against this root with the procedure in ` +
    `docs/ANCHORING.md of the app repository. This page is published outside ` +
    `the application database: it is the trust anchor for the day.</p>` +
    table;
  return {
    title: `Permis d'agir — anchor ${projectId} ${day}`,
    storage,
    adf: buildAnchorComment(projectId, day, root, entries.length),
  };
}

/**
 * Anchor one project's day: compute the root, append the `anchor` entry to
 * the chain, then publish. Idempotent: a day already anchored is skipped.
 */
export async function anchorDay(
  repos: Repositories,
  options: AnchorOptions,
): Promise<AnchorResult> {
  const at = options.at ?? new Date().toISOString();
  const day = options.day ?? dayOf(at);
  const projectId = options.projectId;

  if (await alreadyAnchored(repos, projectId, day)) {
    return { anchored: false, day, published: false, error: 'ALREADY_ANCHORED' };
  }

  const dayEntries = anchorLeaves(
    await repos.ledger.list({ projectId, since: `${day}T00:00:00.000Z`, until: `${day}T23:59:59.999Z` }),
    day,
  );
  const root = merkleRoot(dayEntries.map((entry) => entry.hash));
  const detail: AnchorDetail = { root, count: dayEntries.length, day };

  const prev = await repos.ledger.lastEntry(projectId);
  const entry = makeEntry(
    { kind: ANCHOR_KIND, projectId, decision: 'anchored', detail: { ...detail }, at },
    prev,
  );
  await repos.ledger.append(entry);

  const publication = buildAnchorPublication(projectId, day, root, dayEntries);
  const published = await publish(publication, options.publisher);
  return { anchored: true, day, root, count: dayEntries.length, published, error: published ? undefined : 'PUBLICATION_FAILED' };
}

/** True when an `anchor` entry already covers this project and day. */
async function alreadyAnchored(repos: Repositories, projectId: string, day: string): Promise<boolean> {
  const existing = await repos.ledger.list({ projectId, kind: ANCHOR_KIND });
  return existing.some((entry) => entry.detail?.day === day);
}

/** Best-effort publication: failures are logged, never propagated. */
async function publish(publication: AnchorPublication, publisher?: AnchorPublisher): Promise<boolean> {
  const transport = publisher ?? defaultPublisher();
  if (!transport) {
    console.error('[permis-anchor] no Confluence transport configured; root stays in the ledger');
    return false;
  }
  try {
    await transport(publication);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[permis-anchor] publication failed:', detail);
    return false;
  }
}

/** An app variable, readable as a Forge user variable or as a plain env var. */
function envValue(name: string): string | undefined {
  const value = process.env[`FORGE_USER_VAR_${name}`] ?? process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Jira transport: one comment on the audit ticket named by `PERMIS_ANCHOR_ISSUE`.
 *
 * This is the default because it needs no permission the app does not already
 * hold — it reuses the comment poster of the approver notifications
 * (`write:jira-work`) — and because a Jira comment lives outside the app's
 * Forge SQL database, where the app cannot edit or delete it afterwards.
 */
export function jiraCommentPublisher(
  issueKey: string,
  poster?: CommentPoster,
): AnchorPublisher | undefined {
  const transport = poster ?? defaultPoster();
  if (!transport) return undefined;
  return async (publication: AnchorPublication) => {
    if (!publication.adf) return;
    await transport(issueKey, publication.adf);
  };
}

/**
 * Confluence transport: one page per anchored day in the space named by
 * `PERMIS_ANCHOR_SPACE`. Optional, because it needs the
 * `write:confluence-content` scope, which `manifest.yml` does not request by
 * default: without it the call is refused and the failure is logged — the root
 * stays in the chain either way.
 */
export function confluencePublisher(spaceKey: string): AnchorPublisher | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const api = require('@forge/api');
    if (typeof api?.asApp !== 'function' || typeof api?.route !== 'function') return undefined;
    return async (publication: AnchorPublication) => {
      const response = await api.asApp().requestConfluence(api.route`/rest/api/content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'page',
          title: publication.title,
          space: { key: spaceKey },
          body: { storage: { value: publication.storage, representation: 'storage' } },
        }),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 400);
        throw new Error(`Confluence page failed: HTTP ${response.status} ${detail}`);
      }
    };
  } catch {
    return undefined;
  }
}

/** Default transport: the Jira comment if an audit ticket is set, else Confluence. */
export function defaultPublisher(): AnchorPublisher | undefined {
  const issueKey = envValue('PERMIS_ANCHOR_ISSUE');
  if (issueKey) return jiraCommentPublisher(issueKey);
  const spaceKey = envValue('PERMIS_ANCHOR_SPACE');
  if (spaceKey) return confluencePublisher(spaceKey);
  return undefined;
}
