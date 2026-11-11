---
name: permis-skill
description: Avant d'agir sur un dépôt, demande la permission de chaque action sensible à l'app « Permis d'agir », respecte le permis obtenu (portée, durée, usages) et déclare l'action après coup. À utiliser dès qu'une clé de ticket est citée ou qu'une action sort de la lecture.
allowed-tools: check-permission get-policy request-approval get-request-status list-permits declare-action submit-plan get-agent-standing
---

# Permis d'agir (permis-skill)

L'app Forge **Permis d'agir** tient le registre de ce que tu as le droit de
faire dans un projet Jira. Tu ne décides pas : tu demandes, tu reçois un
niveau, une règle et une marche à suivre.

## Règle d'or

> Tu **n'agis pas** avant d'avoir la réponse de l'app.

Une action est « sensible » dès qu'elle sort de la lecture. Le doute suffit :
appelle `check-permission`, ça prend moins de deux secondes.

## Avant d'agir

1. Appelle `check-permission` avec la clé du ticket, la classe annoncée et la
   cible exacte (chemin de fichier, nom de table, texte de la commande).
2. Lis la réponse :
   - `allow` → agis, et cite le permis dans le message de commit ou la
     description de la PR (`Permis-Agent: PA-2026-000417`) ;
   - `ask` → demande la confirmation au pilote, attends sa réponse ;
   - `deny` avec un `requestId` → **arrête-toi**, annonce le numéro de demande
     et reprends quand le pilote te relance ;
   - `deny` sans demande (niveau N0) → ne réessaie pas, la classe est
     interdite ; dis-le dans le compte rendu.
3. Si l'action est complexe, appelle `submit-plan` avec le plan entier : l'app
   le découpe, décide pour chaque action et regroupe les approbations en une
   seule demande.

## La classification ne te fait pas confiance

L'app recalcule la classe à partir de la cible et de la commande. Si elle
annonce une reclassification (« A-08, pas A-02 : le fichier est sous
migrations/ »), **c'est elle qui a raison** : tu ne peux pas élargir ta propre
classe. Le même vaut pour A-15 (la politique et les hooks) : elle est fermée.

## Après avoir agi

1. Appelle `declare-action` avec la classe, la cible, le résultat et le
   permis utilisé. Ce que tu ne déclares pas est découvert plus tard et coûte
   ton capital de confiance.
2. Un permis a une **portée**, une **durée** et un **nombre d'usages** :
   un permis pour `migrations/001.sql` ne couvre pas `migrations/002.sql`, et
   un permis expiré ne laisse rien passer.
3. Ne boucle jamais sur `get-request-status` : une demande en attente
   attend un humain, pas une polling loop.

## En cas de doute

`get-policy` donne la politique du projet, `get-agent-standing` donne ton
capital de confiance et ses effets. Le capital n'ouvre jamais une classe
interdite, double approbation ou approbation d'un tiers : inutile d'espérer.
