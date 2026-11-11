#!/usr/bin/env bash
# deploy.sh — register, lint, deploy and install the Forge app on a Jira site.
#
# Credentials are never passed as arguments and never printed:
#   email : FORGE_EMAIL env var, or line 1 of ~/.atlassian-login, or --email
#   site  : FORGE_SITE  env var, or line 2 of ~/.atlassian-login, or --site
#   token : FORGE_API_TOKEN env var, or the content of ~/.atlassian-api-token
#
# Usage:
#   bash scripts/deploy.sh --email you@example.com --site your-site.atlassian.net
#   bash scripts/deploy.sh            # reads ~/.atlassian-login + ~/.atlassian-api-token
#   bash scripts/deploy.sh --lint     # only validate the manifest
#   bash scripts/deploy.sh --dry-run  # print the plan, change nothing
set -euo pipefail

die() { printf 'ERREUR: %s\n' "$*" >&2; exit 1; }
step() { printf '==> %s\n' "$*"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN_FILE="${ATLASSIAN_TOKEN_FILE:-$HOME/.atlassian-api-token}"
LOGIN_FILE="${ATLASSIAN_LOGIN_FILE:-$HOME/.atlassian-login}"
NODE_BIN="${FORGE_NODE_BIN:-$HOME/tools/node-v26.12.1-linux-x64/bin}"
FORGE="${FORGE_CLI:-$HOME/.local/opt/bin/forge}"
MODE="full"
DRY_RUN=0
EMAIL="${FORGE_EMAIL:-}"
SITE="${FORGE_SITE:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --email) EMAIL="$2"; shift 2 ;;
    --site) SITE="$2"; shift 2 ;;
    --lint) MODE="lint"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "option inconnue : $1" ;;
  esac
done

[ -d "$REPO_ROOT" ] || die "dépôt introuvable : $REPO_ROOT"
cd "$REPO_ROOT"
[ -f manifest.yml ] || die "manifest.yml absent du dépôt"

# Node compatible avec la CLI Forge (elle exige >=26.12.1 sur ce poste).
if [ -x "$NODE_BIN/node" ]; then export PATH="$NODE_BIN:$PATH"; fi
command -v node >/dev/null || die "node introuvable"
[ -x "$FORGE" ] || FORGE="$(command -v forge || true)"
[ -n "$FORGE" ] || die "CLI Forge introuvable (FORGE_CLI ou forge dans le PATH)"

# Identifiants : arguments, variables, puis fichiers locaux (jamais affichés).
if [ -z "$EMAIL" ] || [ -z "$SITE" ]; then
  if [ -f "$LOGIN_FILE" ]; then
    EMAIL="${EMAIL:-$(sed -n '1p' "$LOGIN_FILE" | tr -d '\r' | sed 's/^email=//')}"
    SITE="${SITE:-$(sed -n '2p' "$LOGIN_FILE" | tr -d '\r' | sed 's/^site=//')}"
  fi
fi
[ -n "$EMAIL" ] || die "email Atlassian manquant (--email, FORGE_EMAIL ou ligne 1 de $LOGIN_FILE)"
[ -n "$SITE" ] || die "site Jira manquant (--site, FORGE_SITE ou ligne 2 de $LOGIN_FILE)"
SITE="${SITE#https://}"; SITE="${SITE%%/*}"

if [ -z "${FORGE_API_TOKEN:-}" ]; then
  [ -f "$TOKEN_FILE" ] || die "jeton manquant : $TOKEN_FILE (chmod 600) ou FORGE_API_TOKEN"
  FORGE_API_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
  export FORGE_API_TOKEN
fi
[ -n "$FORGE_API_TOKEN" ] || die "jeton vide"

step "Compte $EMAIL — site $SITE — CLI $("$FORGE" --version 2>/dev/null | tail -1)"

run() {
  if [ "$DRY_RUN" = 1 ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi
}

step "Connexion (jeton lu depuis l'environnement, jamais affiché)"
run "$FORGE" login --email "$EMAIL" --token "$FORGE_API_TOKEN" --non-interactive

step "Lint du manifeste"
run "$FORGE" lint
[ "$MODE" = "lint" ] && { step "Mode --lint : arrêt après validation"; exit 0; }

step "Enregistrement de l'app si elle n'existe pas encore"
if grep -q '^  id: ari:cloud:ecosystem::app/' manifest.yml; then
  printf '    app.id déjà présent dans le manifeste — register ignoré\n'
else
  run "$FORGE" register --accept-terms --non-interactive || step "register en échec : à faire à la main (forge create)"
fi

step "Déploiement"
run "$FORGE" deploy --non-interactive

step "Installation sur $SITE (produit jira)"
run "$FORGE" install --site "$SITE" --product jira --non-interactive || \
  step "install déjà faite ou à confirmer : forge install list"

step "Terminé. Vérifications : forge install list / forge webtrigger create"
