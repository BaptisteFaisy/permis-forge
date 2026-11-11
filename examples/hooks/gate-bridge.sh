#!/bin/sh
# gate-bridge.sh — command-hook bridge to the Permis d'agir gate.
#
# Why this file exists: Claude Code supports HTTP hooks directly, but other
# clients that can load Claude Code hook configurations (Cursor, and any client
# exposing command hooks) only run shell commands. This bridge turns the hook's
# JSON payload into one POST against the gate and prints the gate's answer, so
# the same policy engine protects every client.
#
# Contract (identical for Claude Code and Cursor command hooks):
#   stdin  : the hook event JSON ({"tool_name"/"toolName", "tool_input"/"args", ...})
#   stdout : the gate JSON answer (hookSpecificOutput.permissionDecision ...)
#   exit 0 : the decision is carried by stdout
#   exit 2 : block the tool call (used when the gate is unreachable)
#
# Fail-closed: if the gate cannot be reached, this bridge exits 2 so the action
# does NOT happen — the same guarantee Claude Code gives with onFailure: block.
#
# Environment:
#   PERMIS_AGENT_GATE_URL  gate URL (forge webtrigger create)          required
#   PERMIS_AGENT_TOKEN     personal hook token from the app settings    required
#   PERMIS_GATE_TIMEOUT    curl timeout in seconds (default 10)
#   PERMIS_AGENT_ISSUE     Jira issue key sent as X-Permis-Issue (optional, but
#                          required for actions beyond N4 - spec §20)
#
# Install (Claude Code, .claude/settings.json):
#   {"hooks":{"PreToolUse":[{"matcher":"Bash|Edit|Write|MultiEdit",
#     "hooks":[{"type":"command",
#       "command":"${CLAUDE_PROJECT_DIR}/.claude/hooks/gate-bridge.sh",
#       "timeout":15,"onFailure":"block"}]}]}}
#
# Install (Cursor, .cursor/hooks.json):
#   {"version":1,"hooks":{"preToolUse":[
#     {"command":".cursor/hooks/gate-bridge.sh","matcher":"Shell|Write|Read",
#      "timeout":15,"failClosed":true}]}}
set -eu

GATE_URL="${PERMIS_AGENT_GATE_URL:-}"
TOKEN="${PERMIS_AGENT_TOKEN:-}"
TIMEOUT="${PERMIS_GATE_TIMEOUT:-10}"

deny() {
  # $1 = machine reason. Printed as a decision so the client can show it.
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 2
}

[ -n "$GATE_URL" ] || deny "PERMIS_AGENT_GATE_URL is not set"
[ -n "$TOKEN" ] || deny "PERMIS_AGENT_TOKEN is not set"
command -v curl >/dev/null 2>&1 || deny "curl is required by the gate bridge"

PAYLOAD="$(cat)"
[ -n "$PAYLOAD" ] || PAYLOAD='{}'

# The ticket is not part of the client payload: pass it explicitly so actions
# beyond N4 are not refused for lack of a ticket (spec §20). Optional.
ISSUE_HEADER=""
if [ -n "${PERMIS_AGENT_ISSUE:-}" ]; then
  ISSUE_HEADER="X-Permis-Issue: ${PERMIS_AGENT_ISSUE}"
fi

# The token is passed through a header file so it never appears in the process
# list, and it is never echoed.
HEADER_FILE="$(mktemp)"
trap 'rm -f "$HEADER_FILE"' EXIT INT TERM
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$HEADER_FILE"

RESPONSE_FILE="$(mktemp)"
trap 'rm -f "$HEADER_FILE" "$RESPONSE_FILE"' EXIT INT TERM

if [ -n "$ISSUE_HEADER" ]; then
  STATUS="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
    --max-time "$TIMEOUT" \
    -X POST "$GATE_URL" \
    -H 'Content-Type: application/json' \
    -H "$ISSUE_HEADER" \
    -H "@$HEADER_FILE" \
    --data-binary "$PAYLOAD" 2>/dev/null || echo 000)"
else
  STATUS="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
    --max-time "$TIMEOUT" \
    -X POST "$GATE_URL" \
    -H 'Content-Type: application/json' \
    -H "@$HEADER_FILE" \
    --data-binary "$PAYLOAD" 2>/dev/null || echo 000)"
fi

case "$STATUS" in
  2*)
    if [ -s "$RESPONSE_FILE" ]; then
      cat "$RESPONSE_FILE"
      printf '\n'
      exit 0
    fi
    deny "gate returned an empty body (HTTP $STATUS)"
    ;;
  401|403)
    deny "gate rejected the personal token (HTTP $STATUS)"
    ;;
  000)
    deny "gate unreachable after ${TIMEOUT}s - failing closed"
    ;;
  *)
    deny "gate error (HTTP $STATUS) - failing closed"
    ;;
esac
