/**
 * PreToolUse hook events and hook file configuration.
 *
 * Defines the contract between Claude Code PreToolUse hooks (and other client hooks)
 * and the Forge web trigger enforcement point.
 */

/** What a Claude Code PreToolUse hook sends to the web trigger. */
export interface HookEvent {
  toolName: string;
  args: Record<string, unknown>;
  cwd?: string;
  /** Personal hook token identifying the pilot (spec §16). */
  token?: string;
}

export interface HookFileEntry {
  type: 'http';
  url: string;
  timeout: number;
  onFailure: 'block';
  headers: Record<string, string>;
  allowedEnvVars: string[];
}

export interface HookFile {
  hooks: {
    PreToolUse: { matcher: string; hooks: HookFileEntry[] }[];
  };
}
