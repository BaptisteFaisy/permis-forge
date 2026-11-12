/**
 * Minimal ADF (Atlassian Document Format) builders.
 *
 * Every service that posts a comment on a Jira issue needs the same few node
 * shapes, and the same trap: Jira answers `INVALID_INPUT` when a `bulletList`
 * contains anything other than `listItem` nodes. Writing the shape once keeps
 * that mistake from being repeated per service.
 *
 * Pure module: no Atlassian SDK import, no network, no side effect.
 */

/** Minimal Atlassian Document Format node. */
export interface AdfNode {
  type: string;
  text?: string;
  version?: number;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** A text node, optionally bold. */
export function text(value: string, bold = false): AdfNode {
  const node: AdfNode = { type: 'text', text: value };
  if (bold) node.marks = [{ type: 'strong' }];
  return node;
}

/** A monospaced run, for hashes, identifiers and commands. */
export function code(value: string): AdfNode {
  return { type: 'text', text: value, marks: [{ type: 'code' }] };
}

export function paragraph(...content: AdfNode[]): AdfNode {
  return { type: 'paragraph', content };
}

/** One list item; the only child a `bulletList` accepts. */
export function bullet(...content: AdfNode[]): AdfNode {
  return { type: 'listItem', content: [paragraph(...content)] };
}

export function bulletList(items: AdfNode[]): AdfNode {
  return { type: 'bulletList', content: items };
}

/** A whole ADF document. */
export function doc(...content: AdfNode[]): AdfNode {
  return { type: 'doc', version: 1, content };
}
