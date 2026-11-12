#!/usr/bin/env bash
# bootstrap-installation.sh — prepare a fresh installation of the app.
#
# A new installation (a second environment, a second site, a rebuild from
# scratch) starts with an empty database: no tables, no policy, no project.
# This script performs the two operator actions that make it usable, then
# prints the resulting state so the result is checkable rather than assumed.
#
# Credentials are read from local files and never printed:
#   PERMIS_GATE_FILE    gate web trigger URL      (default ~/.atlassian/permis-gate-url.txt)
#   PERMIS_ADMIN_FILE   operator web trigger URL  (default ~/.atlassian/permis-admin-url.txt)
#   PERMIS_SECRET_FILE  installation secret       (default ~/.atlassian/permis-signing-secret)
#
# Usage:
#   bash scripts/bootstrap-installation.sh              # project PAY
#   PROJECT=ENGS bash scripts/bootstrap-installation.sh
#
# Exit code 0 when every step succeeded, 1 otherwise.
set -uo pipefail

ADMIN_FILE="${PERMIS_ADMIN_FILE:-$HOME/.atlassian/permis-admin-url.txt}"
SECRET_FILE="${PERMIS_SECRET_FILE:-$HOME/.atlassian/permis-signing-secret}"
PROJECT="${PROJECT:-PAY}"
SEED_FILE="${PERMIS_SEED_FILE:-examples/policy/seed-payments.json}"

[ -f "$ADMIN_FILE" ] || { echo "manquant : $ADMIN_FILE"; exit 2; }
[ -f "$SECRET_FILE" ] || { echo "manquant : $SECRET_FILE"; exit 2; }
[ -f "$SEED_FILE" ] || { echo "manquant : $SEED_FILE"; exit 2; }

ADMIN=$(cat "$ADMIN_FILE")
SEC=$(tr -d '\r\n' < "$SECRET_FILE")
ok=0; ko=0
check() {
  if [ "$2" = "1" ]; then printf '  [OK]    %s\n' "$1"; ok=$((ok+1));
  else printf '  [ÉCHEC] %s\n' "$1"; ko=$((ko+1)); fi
}
admin() {
  curl -sS -m 90 -X POST "$ADMIN" -H 'Content-Type: application/json' \
    -H "X-Permis-Admin: $SEC" -d "$1"
}

echo "Amorçage de l'installation — projet $PROJECT"

echo "1. Schéma"
B=$(admin "{\"action\":\"bootstrap-schema\",\"projectId\":\"$PROJECT\"}")
printf '%s' "$B" | grep -q '"ok":true' \
  && check "tables créées (DDL rejoué une fois)" 1 \
  || { check "tables créées (DDL rejoué une fois)" 0; echo "$B"; }

echo "2. Politique"
PAYLOAD=$(python3 - "$SEED_FILE" "$PROJECT" <<'PY'
import json, sys

seed_file, project = sys.argv[1], sys.argv[2]
with open(seed_file) as handle:
    seed = json.load(handle)
policy = {key: seed[key] for key in ("settings", "zones", "rules") if key in seed}
json.dump({"action": "seed-policy", "projectId": project, "policy": policy, "by": "operator"},
          sys.stdout)
PY
)
S=$(admin "$PAYLOAD")
printf '%s' "$S" | grep -q '"refusals":\[\]' \
  && check "zones et règles chargés, aucun refus" 1 \
  || { check "zones et règles chargés, aucun refus" 0; echo "$S"; }

echo "3. État"
ST=$(admin "{\"action\":\"status\",\"projectId\":\"$PROJECT\"}")
printf '%s' "$ST" | grep -q '"chainValid":true' \
  && check "chaîne du journal intacte" 1 \
  || { check "chaîne du journal intacte" 0; echo "$ST"; }
echo "  état : $ST"

printf 'Amorçage : %d OK, %d échec(s)\n' "$ok" "$ko"
[ "$ko" -eq 0 ] || exit 1
