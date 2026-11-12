#!/usr/bin/env bash
# Live regression harness — replays the acceptance checks against a DEPLOYED
# installation, through the real web triggers and Forge SQL. No Jira UI needed.
#
# This is the online counterpart of `node scripts/demo.mjs` (which runs the same
# eleven acceptance scenarios offline against the in-memory adapter).
#
# Credentials are read from local files and never printed nor committed:
#   ~/.atlassian/permis-gate-url.txt     gate web trigger URL
#   ~/.atlassian/permis-admin-url.txt    operator web trigger URL
#   ~/.atlassian/permis-signing-secret   installation secret (X-Permis-Admin)
#
# Usage:
#   bash scripts/regression-live.sh                 # project PAY (seeded policy)
#   PROJECT=ENGS ISSUE=ENGS-32 bash scripts/regression-live.sh
#
# Exit code 0 when every check passes, 1 otherwise.
set -uo pipefail

GATE_FILE="${PERMIS_GATE_FILE:-$HOME/.atlassian/permis-gate-url.txt}"
ADMIN_FILE="${PERMIS_ADMIN_FILE:-$HOME/.atlassian/permis-admin-url.txt}"
SECRET_FILE="${PERMIS_SECRET_FILE:-$HOME/.atlassian/permis-signing-secret}"

# Project whose policy is seeded (see examples/policy/seed-payments.json). The
# observe-mode and project-rule checks only make sense against a seeded project.
PROJECT="${PROJECT:-PAY}"
ISSUE="${ISSUE:-${PROJECT}-42}"
UNSEEDED_ISSUE="${UNSEEDED_ISSUE:-ENGS-32}"

for f in "$GATE_FILE" "$ADMIN_FILE" "$SECRET_FILE"; do
  [ -f "$f" ] || { echo "manquant : $f (voir docs/DEPLOYMENT.md)"; exit 2; }
done
GATE=$(cat "$GATE_FILE"); ADMIN=$(cat "$ADMIN_FILE"); SEC=$(tr -d '\r\n' < "$SECRET_FILE")

ok=0; ko=0
check() {
  if [ "$2" = "1" ]; then printf '  [OK]    %s\n' "$1"; ok=$((ok+1));
  else printf '  [ÉCHEC] %s\n' "$1"; ko=$((ko+1)); fi
}
field() { python3 -c "import json,sys;d=json.load(sys.stdin);
import functools
cur=d
for k in '$1'.split('.'):
    cur = cur.get(k, {}) if isinstance(cur, dict) else {}
print(cur)"; }

admin() { curl -sS -m 90 -X POST "$ADMIN" -H 'Content-Type: application/json' -H "X-Permis-Admin: $SEC" -d "$1"; }
gate()  { curl -sS -m 90 -X POST "$GATE" -H 'Content-Type: application/json' \
            -H "Authorization: Bearer $2" -H "X-Permis-Issue: ${3:-$ISSUE}" -d "$1"; }
decision() { python3 -c 'import json,sys;print(json.load(sys.stdin)["hookSpecificOutput"]["permissionDecision"])'; }
reason()   { python3 -c 'import json,sys;print(json.load(sys.stdin)["hookSpecificOutput"]["permissionDecisionReason"])'; }

echo "Régression live — projet $PROJECT, ticket $ISSUE"

echo "1. Stockage et intégrité"
H=$(admin "{\"action\":\"health\",\"projectId\":\"$PROJECT\"}")
[ "$(printf '%s' "$H" | python3 -c 'import json,sys;d=json.load(sys.stdin)["tables"];print(all(v=="ok" for v in d.values()))')" = "True" ] \
  && check "les 9 sondes de dépôt répondent (10 tables)" 1 || check "les 9 sondes de dépôt répondent (10 tables)" 0
S=$(admin "{\"action\":\"status\",\"projectId\":\"$PROJECT\"}")
[ "$(printf '%s' "$S" | field chainValid)" = "True" ] && check "chaîne du journal intacte" 1 || check "chaîne du journal intacte" 0
CODE=$(curl -sS -m 60 -o /dev/null -w '%{http_code}' -X POST "$ADMIN" -H 'Content-Type: application/json' \
  -H 'X-Permis-Admin: mauvais-secret' -d '{"action":"status"}')
[ "$CODE" = "401" ] && check "secret opérateur invalide refusé (401)" 1 || check "secret opérateur invalide refusé ($CODE)" 0

echo "2. Jeton personnel et décisions du gate"
TOK=$(admin '{"action":"mint-token","accountId":"557058:regression","label":"regression-live"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("token",""))')
[ -n "$TOK" ] && check "jeton personnel émis (hash seul stocké)" 1 || check "jeton personnel émis" 0

R=$(gate '{"toolName":"Edit","args":{"file_path":"db/migrations/900_reg.sql"}}' "$TOK" | decision)
[ "$R" = "deny" ] && check "migration refusée sans permis (A-08)" 1 || check "migration refusée sans permis ($R)" 0

R=$(gate '{"toolName":"Read","args":{"file_path":"README.md"}}' "$TOK" | decision)
[ "$R" = "allow" ] && check "lecture autorisée (A-01/N5)" 1 || check "lecture autorisée ($R)" 0

R=$(gate '{"toolName":"Edit","args":{"file_path":".env.production"}}' "$TOK" | reason)
case "$R" in *"N0"*) check "secrets interdits (A-10/N0)" 1;; *) check "secrets interdits ($R)" 0;; esac

R=$(gate '{"toolName":"Edit","args":{"file_path":".claude/settings.json"}}' "$TOK" | reason)
case "$R" in *"N0"*) check "politique/hooks verrouillés (A-15/N0)" 1;; *) check "politique/hooks verrouillés ($R)" 0;; esac

R=$(gate '{"toolName":"Edit","args":{"file_path":".github/workflows/deploy.yml"}}' "$TOK" | reason)
case "$R" in *"A-07"*) check "fichier CI reclassé A-07" 1;; *) check "fichier CI reclassé A-07 ($R)" 0;; esac

R=$(gate '{"toolName":"Bash","args":{"command":"npm install axios"}}' "$TOK" | reason)
case "$R" in *"OBSERVE MODE"*) check "règle en mode observation : allow + journalisé" 1;; *) check "mode observation ($R)" 0;; esac

R=$(gate '{"toolName":"Bash","args":{"command":"npm install axios"}}' "$TOK" "$UNSEEDED_ISSUE" | reason)
case "$R" in *"No rule matched A-05"*) check "politique par projet : projet non amorcé → défaut du catalogue" 1;; *) check "politique par projet ($R)" 0;; esac

CODE=$(curl -sS -m 60 -o /dev/null -w '%{http_code}' -X POST "$GATE" -H 'Content-Type: application/json' \
  -d '{"toolName":"Bash","args":{"command":"ls"}}')
[ "$CODE" = "401" ] && check "sans jeton : refus 401 (fermé par défaut)" 1 || check "sans jeton ($CODE)" 0

# The fail-open found by the fuzzer (docs/THREAT-MODEL.md §3): a payload whose tool
# name was not a string used to be interpreted, and a `rm -rf` was answered `allow`.
R=$(gate '{"toolName":true,"args":{"command":"rm -rf /var/lib/prod"}}' "$TOK" | decision)
[ "$R" = "deny" ] && check "payload malformé (toolName non chaîne) : refus" 1 || check "payload malformé ($R)" 0
R=$(gate '{"toolName":"Bash","args":{"command":"rm -rf /var/lib/prod"}}' "$TOK" | decision)
[ "$R" = "deny" ] && check "commande destructive : refus" 1 || check "commande destructive ($R)" 0
R=$(gate '{"toolName":"BrandNewClientTool","args":{"file_path":"README.md"}}' "$TOK" | decision)
[ "$R" = "allow" ] && check "outil inconnu mais bien formé : autorisé" 1 || check "outil inconnu ($R)" 0

echo "3. Écrans Jira (résolveur → Forge SQL)"
for E in projectSettings projectPage issuePanel globalPage personalSettings; do
  C=$(admin "{\"action\":\"screen\",\"screen\":\"$E\",\"projectId\":\"$PROJECT\",\"issueKey\":\"$ISSUE\"}" \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print("ok" if "result" in d and not d["result"].get("error") else "ko")' 2>/dev/null)
  [ "$C" = "ok" ] && check "écran $E" 1 || check "écran $E" 0
done
DT=$(admin "{\"action\":\"screen\",\"screen\":\"issuePanel\",\"projectId\":\"$PROJECT\",\"issueKey\":\"$ISSUE\"}" \
  | python3 -c 'import json,sys;r=json.load(sys.stdin)["result"];print("ok" if "delegationTree" in r and "delegationDepth" in r else "ko")' 2>/dev/null)
[ "$DT" = "ok" ] && check "écran issuePanel : chaîne de délégation" 1 || check "chaîne de délégation ($DT)" 0
SC=$(admin "{\"action\":\"screen\",\"screen\":\"simulationConsole\",\"projectId\":\"$PROJECT\",\"payload\":{\"target\":\"db/migrations/901_console.sql\",\"actionClass\":\"A-02\"}}" \
  | python3 -c 'import json,sys;r=json.load(sys.stdin)["result"];print(r["classification"]["actionClass"], r["level"])')
[ "$SC" = "A-08 2" ] && check "console de simulation : A-02 reclassé A-08/N2" 1 || check "console de simulation ($SC)" 0

echo "4. Dérive et politique (opérateur)"
# A fresh target per run: apply-drift is idempotent by design, so a fixed path
# would be penalised once and then skipped for ever — the check would go red on
# the second run of the day instead of measuring what it claims to.
RUN_ID=$(date +%s)
DRIFT_BODY='{"action":"apply-drift","projectId":"'"$PROJECT"'","issueKey":"'"$ISSUE"'","profileId":"regression","changes":[{"path":"db/migrations/950_drift_'"$RUN_ID"'.sql","source":"regression"}],"by":"regression"}'
D=$(admin "$DRIFT_BODY")
[ "$(printf '%s' "$D" | field penalized)" = "1" ] \
  && check "dérive : un écart non déclaré est pénalisé et journalisé" 1 \
  || check "dérive non enregistrée ($(printf '%s' "$D" | head -c 100))" 0
D2=$(admin "$DRIFT_BODY")
[ "$(printf '%s' "$D2" | field penalized)" = "0" ] \
  && check "dérive idempotente : le même écart ne pénalise pas deux fois" 1 \
  || check "dérive non idempotente (penalized=$(printf '%s' "$D2" | field penalized))" 0
CODE=$(curl -sS -m 60 -o /dev/null -w '%{http_code}' -X POST "$ADMIN" -H 'Content-Type: application/json' \
  -H "X-Permis-Admin: $SEC" -d '{"action":"apply-suggestion","projectId":"'"$PROJECT"'","suggestionId":"whatever"}')
[ "$CODE" = "400" ] && check "suggestion appliquée sans auteur nommé : refus 400" 1 || check "suggestion sans auteur ($CODE)" 0
E=$(admin '{"action":"apply-suggestion","projectId":"'"$PROJECT"'","suggestionId":"PAY-A-05-relax","by":"regression"}')
[ "$(printf '%s' "$E" | field error)" = "SUGGESTION_NOT_FOUND" ] \
  && check "suggestion inconnue : 404 plutôt qu'une règle inventée" 1 \
  || check "suggestion inconnue ($(printf '%s' "$E" | head -c 100))" 0

echo
echo "Régression live : $ok OK, $ko échec(s)"
[ "$ko" = "0" ] || exit 1
echo "TOUT EST VERT"
