/**
 * Approver notification (spec §8.1, and §18 validation 6 whose fallback is
 * "mention in a ticket comment").
 *
 * A request that nobody sees is a request that never gets answered, and the
 * approval delay is what developers blame when they route around a policy. So
 * when the gate refuses an action and creates a request, the app posts a
 * comment on the ticket with the approval card: what, why, how, risk, who —
 * and the request number to approve.
 *
 * The transport is injected: the pure notice builder and the delivery are
 * tested offline, and only the default poster touches the Jira REST API. A
 * delivery failure never changes the decision — the refusal stands either way,
 * it is only logged (spec §19: explainability is about the answer, not the
 * notification).
 */
import { ApprovalRequest, LedgerEntry } from '../core/types';
import { AdfNode, bullet, bulletList, doc, paragraph, text } from './adf';

export type { AdfNode };

export interface NoticeInput {
  request: ApprovalRequest;
  /** Level name already localised, e.g. "N2 — Third-party approval". */
  levelName?: string;
  /** Reclassification reason, when the app overrode the announced class. */
  reclassified?: string;
  /** Precedents summary, one line (spec §8.1 "Précédents"). */
  precedents?: string;
}

export interface ApprovalNotice {
  title: string;
  body: AdfNode;
}

/** Build the approval card as an ADF document (no network, no side effect). */
export function buildApprovalNotice(input: NoticeInput): ApprovalNotice {
  const request = input.request;
  const roles = (request.approverRoles ?? []).join(', ') || 'project administrator';
  const title = `Approval required — ${request.id}`;
  const items: AdfNode[] = [
    bullet(text('What: ', true), text(`${request.actionClass} on ${request.target}`)),
    bullet(text('Why: ', true), text(request.justification || 'not provided by the agent')),
    bullet(text('How: ', true), text(request.plan || 'no plan supplied')),
    bullet(text('Risk: ', true), text(`${input.levelName ?? `N${request.level}`} — level ${request.level}`)),
    bullet(text('Who: ', true), text(`pilot ${request.pilotAccountId}, profile ${request.profileId}`)),
    bullet(text('Approvers: ', true), text(roles)),
  ];
  if (input.reclassified) {
    items.push(bullet(text('Reclassified: ', true), text(input.reclassified)));
  }
  if (input.precedents) {
    items.push(bullet(text('Precedents: ', true), text(input.precedents)));
  }
  // A bulletList may only contain listItem nodes: the closing note is a sibling
  // paragraph of the list, not one of its items (Jira answers INVALID_INPUT
  // otherwise).
  return {
    title,
    body: doc(
      paragraph(text(title, true)),
      bulletList(items),
      paragraph(
        text('The pilot of this request cannot approve it. A denial requires a written reason.'),
      ),
    ),
  };
}

/** Post one comment on a Jira issue; injected in tests. */
export type CommentPoster = (issueKey: string, body: AdfNode) => Promise<void>;

export interface NotifyOptions {
  poster?: CommentPoster;
  levelName?: string;
  reclassified?: string;
  precedents?: string;
}

export interface NotifyResult {
  notified: boolean;
  error?: string;
}

/**
 * Notify the approvers on the ticket. Best effort: a failure is reported to the
 * caller (and logged) but never alters the decision already taken.
 */
export async function notifyApprovers(
  request: ApprovalRequest,
  options: NotifyOptions = {},
): Promise<NotifyResult> {
  if (!request.issueId) return { notified: false, error: 'NO_ISSUE_ON_REQUEST' };
  const notice = buildApprovalNotice({
    request,
    levelName: options.levelName,
    reclassified: options.reclassified,
    precedents: options.precedents,
  });
  const poster = options.poster ?? defaultPoster();
  if (!poster) return { notified: false, error: 'NO_JIRA_TRANSPORT' };
  try {
    await poster(request.issueId, notice.body);
    return { notified: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[permis-notify] comment failed:', detail);
    return { notified: false, error: detail };
  }
}

/** Default transport: the Forge Jira REST API, loaded lazily. */
export function defaultPoster(): CommentPoster | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const api = require('@forge/api');
    if (typeof api?.asApp !== 'function' || typeof api?.route !== 'function') return undefined;
    return async (issueKey: string, body: AdfNode) => {
      const response = await api.asApp().requestJira(api.route`/rest/api/3/issue/${issueKey}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!response.ok) {
        // Keep Jira's own message: "HTTP 400" alone is undiagnosable.
        const detail = (await response.text()).slice(0, 400);
        throw new Error(`Jira comment failed: HTTP ${response.status} ${detail}`);
      }
    };
  } catch {
    return undefined;
  }
}

/** One-line precedent summary for the card, from the ledger entries. */
export function precedentSummary(entries: LedgerEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const granted = entries.filter((entry) => entry.kind === 'approval').length;
  const denied = entries.filter((entry) => entry.kind === 'denial').length;
  const incidents = entries.filter((entry) => entry.detail?.trustKind === 'incident').length;
  return `${entries.length} similar request(s): ${granted} granted, ${denied} denied, ${incidents} incident(s) afterwards`;
}
