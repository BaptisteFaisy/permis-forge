# Permis d'agir pour agents — cahier des charges

> Codegeist 2026 · catégorie **Apps for Software Teams**
> Bonus visés : MCP (principal), Agents Rovo, Marketplace (Teamwork Graph en option)
> Version 1 du 11 novembre 2026 · soumission avant le mardi 22 décembre 2026, 21 h (Paris)

## 1. L'idée en une phrase

Jira devient le registre de ce qu'un agent de code a le droit de faire : chaque action sensible est autorisée, soumise à approbation ou refusée selon une politique par projet, l'approbation se donne sur le ticket, un permis signé et limité dans le temps en sort, et tout est consigné dans un journal qu'on ne peut pas réécrire.

## 2. Le problème

Les agents de code ne se contentent plus d'écrire des fonctions. Ils lancent des migrations, modifient la configuration de la CI, mettent à jour des dépendances, suppriment des fichiers, et parfois désactivent le test qui les gêne.

Aujourd'hui, ce qu'un agent a le droit de faire se décide à trois endroits qui ne se parlent pas :

- dans la tête du développeur qui le pilote ;
- dans un fichier de consignes que l'agent suit, ou pas ;
- dans les réglages locaux de l'outil, différents sur chaque poste.

Aucun de ces endroits n'est partagé, vérifiable ni traçable. Quand un incident survient, personne ne peut répondre à trois questions simples : qui a autorisé cette action, sur quelle base, et l'agent avait-il le droit de la faire seul ?

L'organisation a pourtant déjà un endroit où l'on décide, où l'on approuve et où l'on garde la trace : Jira. Il manque le lien entre ce registre et l'agent.

## 3. Utilisateurs

| Qui | Ce qu'il fait | Ce qu'il attend |
|---|---|---|
| Agent de code | Demande avant d'agir, déclare après | Une réponse nette et rapide, avec la marche à suivre |
| Développeur qui pilote l'agent | Lance le travail, confirme les actions de son niveau | Ne pas être interrompu pour rien, être couvert quand il approuve |
| Approbateur (tech lead, responsable de données, sécurité) | Accorde ou refuse | Voir quoi, où, pourquoi, avec quel risque, en dix secondes |
| Responsable d'équipe | Règle la politique | Élargir l'autonomie là où c'est sûr, la retenir ailleurs |
| Sécurité, audit, direction | Contrôle a posteriori | Un journal complet, lisible et infalsifiable |

## 4. Vocabulaire du produit

- **Action** : ce que l'agent s'apprête à faire, décrit par une classe et une cible.
- **Classe d'action** : la nature de l'action (migration de schéma, suppression de données, modification de tests…).
- **Zone** : l'endroit visé, défini par des motifs de chemins, un composant, un environnement.
- **Niveau d'autonomie** : ce que la politique exige pour une classe dans une zone, de N0 (interdit) à N5 (autonome).
- **Demande** : la requête d'approbation créée par l'agent, visible sur le ticket.
- **Permis** : l'autorisation issue d'une approbation. Il a une portée, une durée, un nombre d'usages et une signature.
- **Journal** : la suite ordonnée de toutes les décisions, demandes, approbations et actions déclarées.
- **Profil d'agent** : une configuration d'agent dans un projet (« Claude Code de l'équipe Paiements »).
- **Capital de confiance** : le score d'un profil, qui monte avec les actions confirmées et baisse avec les incidents. C'est le permis à points.
- **Arrêt d'urgence** : l'interrupteur qui suspend d'un coup toute autonomie dans un projet.

## 5. Les six niveaux d'autonomie

| Niveau | Nom | Ce qui se passe |
|---|---|---|
| N5 | Autonome | L'agent agit. Rien n'est demandé. |
| N4 | Autonome, déclaré | L'agent agit, l'action est journalisée et notifiée au responsable de la zone. |
| N3 | Confirmation du pilote | Le développeur qui pilote l'agent confirme sur son poste. |
| N2 | Approbation d'un tiers | Une personne habilitée, autre que le pilote, approuve sur le ticket. |
| N1 | Double approbation | Deux personnes habilitées, de rôles différents, approuvent. |
| N0 | Interdit | Refus, avec la raison. Aucune dérogation par l'agent. |

## 6. Catalogue des classes d'action

| Code | Classe | Exemples | Niveau par défaut |
|---|---|---|---|
| A-01 | Lire | Lire le dépôt, le ticket, la doc | N5 |
| A-02 | Modifier le code applicatif | Fichiers sources hors zones sensibles | N5 |
| A-03 | Modifier des tests | Changer une assertion | N4 |
| A-04 | Désactiver ou supprimer un test | `skip`, suppression de fichier de test | N2 |
| A-05 | Ajouter une dépendance | Nouveau paquet | N3 |
| A-06 | Mise à jour majeure d'une dépendance | Changement de version majeure | N2 |
| A-07 | Modifier la CI ou le déploiement | Fichiers de pipeline, images, scripts de livraison | N2 |
| A-08 | Migration de schéma | Ajout ou modification de table | N2 |
| A-09 | Supprimer ou modifier des données | `DELETE`, `UPDATE` de masse, purge | N1 |
| A-10 | Toucher aux secrets et aux accès | Variables secrètes, rôles, clés | N0 |
| A-11 | Modifier l'infrastructure | Fichiers d'infrastructure déclarative | N2 |
| A-12 | Opération Git destructrice | Réécriture d'historique sur branche partagée, suppression de branche | N0 |
| A-13 | Agir en production | Commande lancée contre un environnement de production | N1 |
| A-14 | Envoyer vers l'extérieur | Appel à un service tiers, envoi de message | N3 |
| A-15 | Modifier la politique elle-même | Fichiers de consignes d'agents, réglages de hooks | N0 |

Le catalogue est extensible par projet. A-15 est verrouillée : un agent ne peut jamais élargir ses propres droits.

## 7. La politique

### 7.1 Forme d'une règle

`classe d'action × zone × conditions → niveau`

Conditions possibles :

- environnement (développement, recette, production) ;
- type du ticket (un correctif d'incident peut ouvrir une voie plus rapide) ;
- plage horaire et gels en cours ;
- capital de confiance du profil d'agent ;
- préparation du ticket (critères d'acceptation présents ou non).

### 7.2 Résolution

1. Les règles de l'organisation forment un plancher : un projet peut durcir, jamais assouplir.
2. Parmi les règles applicables, **la plus restrictive l'emporte**.
3. Sans règle applicable, le niveau par défaut de la classe s'applique.
4. Si l'arrêt d'urgence est actif, tout ce qui dépasse la lecture passe en N0.

### 7.3 Classer une action

L'agent fournit une classe et une cible. L'app ne le croit pas sur parole :

- des motifs déterministes reclassent d'après la cible (un fichier sous `migrations/` est une A-08, quelle que soit la classe annoncée) ;
- des motifs sur la commande reclassent d'après son texte (`DROP`, `DELETE FROM`, &#45;&#45;force) ;
- si l'agent ne donne qu'une description libre, un modèle de langage propose une classe ; en cas de doute entre deux classes, la plus restrictive est retenue.

La réponse indique toujours la règle appliquée et la raison du reclassement éventuel.

### 7.4 Mode observation

Toute règle peut tourner à blanc : elle décide et journalise, sans rien bloquer. Le rapport « ce que cette politique aurait bloqué en 30 jours » précède chaque durcissement.

## 8. Du refus au permis

### 8.1 La demande

Quand le niveau est N2 ou N1, l'agent appelle `request-approval` avec la classe, la cible, la justification et son plan. La demande apparaît sur le ticket, dans le panneau de l'app, et mentionne les personnes habilitées.

L'approbateur voit sur une seule carte :

- **Quoi** : la classe et la cible exacte (fichier, table, commande).
- **Pourquoi** : la justification de l'agent, le ticket, le critère d'acceptation servi.
- **Comment** : le plan, et le plan de retour arrière s'il y en a un.
- **Risque** : le niveau, la zone, ce qui dépend de la cible.
- **Précédents** : les demandes semblables, leur issue, ce qui s'est passé ensuite.
- **Qui** : le pilote humain et le profil d'agent, avec son capital de confiance.

Trois boutons : **Accorder**, **Refuser** (motif obligatoire), **Demander une précision**.

### 8.2 Qui peut approuver

- Un rôle de projet par classe d'action (les migrations vont au responsable des données, la CI à l'équipe plateforme).
- Jamais le pilote de l'agent pour sa propre demande.
- En N1, deux personnes de rôles différents.

### 8.3 Le permis

Une approbation produit un permis :

| Champ | Contenu |
|---|---|
| Identifiant | `PA-2026-000417` |
| Portée | Classe, cible exacte, ticket |
| Durée | 2 heures par défaut, réglable par l'approbateur |
| Usages | 1 par défaut |
| Titulaire | Profil d'agent et pilote |
| Signature | Empreinte calculée avec un secret de l'installation |

Le permis est révocable à tout moment. L'agent le cite dans le message de commit ou la description de la PR (`Permis-Agent: PA-2026-000417`), ce qui le rend vérifiable plus tard par un contrôle de fusion ou une étape de CI.

### 8.4 Le plan d'abord

Pour un ticket complexe, l'agent soumet son plan entier par `submit-plan`. L'app le découpe en actions, donne la décision pour chacune et regroupe ce qui demande une approbation en une seule demande. Un plan approuvé vaut lot de permis. Toute action hors plan est signalée comme écart.

## 9. Le permis à points

Chaque profil d'agent a un capital de confiance, de 0 à 100, initialisé à 50.

| Événement | Effet |
|---|---|
| Action déclarée, compte rendu confirmé par un humain | +1 |
| Demande accordée, exécutée conformément au permis | +2 |
| Compte rendu corrigé par le relecteur | −2 |
| Action sensible découverte sans déclaration | −10 |
| Action hors du plan approuvé | −10 |
| Incident rattaché à une action de l'agent | −25 |
| Tentative sur une classe interdite | −5 |

Effets sur la politique, si le projet l'active :

- au-dessus de 80, les classes réglées en N3 passent en N4 ;
- en dessous de 30, les classes réglées en N4 et N5 (hors lecture) passent en N3 ;
- à 0, le profil est suspendu jusqu'à revue humaine.

Garde-fous : le capital n'ouvre jamais une classe en N0, N1 ou N2, et il s'érode lentement vers 50 en l'absence d'activité. Chaque variation est expliquée dans le journal.

## 10. Où la règle s'applique réellement

Un outil qu'on interroge ne retient personne : un agent qui ne demande pas agit quand même. Le produit le dit et propose quatre points d'application, du plus simple au plus ferme.

| Point | Mécanisme | Force |
|---|---|---|
| 1. Outil MCP | L'agent appelle `check-permission` parce que ses consignes le lui demandent | Coopération |
| 2. Hook du client | Un hook exécuté avant chaque appel d'outil interroge l'app et bloque l'appel sans permis | Blocage sur le poste |
| 3. Contrôle de fusion ou étape de CI | Une PR qui touche une zone sensible sans permis valide est refusée | Blocage avant la branche principale |
| 4. Détection après coup | Les changements réels sont comparés aux actions déclarées ; l'écart est signalé | Dissuasion et trace |

### Le hook, point d'application principal

Claude Code exécute des hooks avant chaque appel d'outil (`PreToolUse`). Un hook peut refuser l'appel, le laisser passer ou demander confirmation à l'utilisateur. Il peut être une commande, une requête HTTP ou un appel d'outil MCP, et il se limite par motif aux outils et arguments concernés.

L'app génère, à partir de la politique du projet, le fichier de hooks à déposer dans le dépôt :

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write",
        "hooks": [
          {
            "type": "http",
            "url": "https://<installation>.webtrigger.atlassian.app/<chemin>/gate",
            "timeout": 10,
            "onFailure": "block",
            "headers": { "Authorization": "Bearer $PERMIS_AGENT_TOKEN" },
            "allowedEnvVars": ["PERMIS_AGENT_TOKEN"]
          }
        ]
      }
    ]
  }
}
```

Correspondance entre niveaux et décisions du hook :

| Niveau | Décision renvoyée |
|---|---|
| N5, N4 | Laisser passer (N4 : journalisé) |
| N3 | Demander confirmation au pilote |
| N2, N1 avec permis valide | Laisser passer, le permis est décompté |
| N2, N1 sans permis | Refuser, avec le numéro de la demande créée |
| N0 | Refuser, avec la raison |

`onFailure: "block"` rend la porte fermée par défaut : si l'app ne répond pas, l'action sensible n'a pas lieu.

Le fichier de hooks est lui-même protégé par la classe A-15 : l'agent ne peut pas le modifier.

## 11. Le journal

- Une entrée par décision, demande, approbation, refus, permis, usage de permis, action déclarée, variation de capital, arrêt d'urgence.
- **Chaînage** : chaque entrée contient l'empreinte de la précédente. Toute suppression ou modification casse la chaîne, et l'écran de vérification le montre.
- Chaque entrée porte : date, projet, ticket, profil d'agent, pilote, classe, cible, règle appliquée, décision, permis.
- Filtres par ticket, agent, classe, zone, période ; export en CSV et en page Confluence.
- Aucune entrée n'est modifiable ; une correction est une nouvelle entrée qui renvoie à l'ancienne.

## 12. Arrêt d'urgence

Un bouton par projet, un autre pour l'organisation. Effets immédiats :

- toute classe au-delà de la lecture répond N0 ;
- les permis en cours sont suspendus, pas détruits ;
- les demandes en attente sont gelées ;
- une bannière apparaît sur les tickets concernés.

L'activation et la levée exigent un motif et sont journalisées. La levée demande une personne différente de celle qui a déclenché l'arrêt, si le projet le règle ainsi.

## 13. Exigences fonctionnelles

Priorités : **M** = indispensable pour la soumission, **S** = souhaitable, **C** = après le hackathon.

| N° | Exigence | Priorité |
|---|---|---|
| PA-01 | Décider d'une action selon classe, zone, conditions et politique, en moins de 2 s | M |
| PA-02 | Reclasser une action d'après sa cible ou sa commande, et le dire | M |
| PA-03 | Régler la politique par projet dans une grille classes × zones | M |
| PA-04 | Créer une demande d'approbation visible sur le ticket, avec la carte du § 8.1 | M |
| PA-05 | Empêcher le pilote d'approuver sa propre demande | M |
| PA-06 | Émettre, décompter, faire expirer et révoquer des permis signés | M |
| PA-07 | Journal chaîné, consultable et exportable | M |
| PA-08 | Outils MCP du § 14 | M |
| PA-09 | Point d'entrée pour hook, avec jeton personnel, et fichier de hooks généré | M |
| PA-10 | Arrêt d'urgence par projet | M |
| PA-11 | Console de simulation : saisir une action, voir la décision et la règle | M |
| PA-12 | Agent Rovo pour interroger politique et journal | M |
| PA-13 | Mode observation et rapport sur 30 jours | S |
| PA-14 | Capital de confiance et ses effets | S |
| PA-15 | Double approbation (N1) avec rôles distincts | S |
| PA-16 | Plan d'abord : découpage, lot de permis, écarts | S |
| PA-17 | Précédents affichés sur la carte de demande | S |
| PA-18 | Plancher de politique au niveau de l'organisation | S |
| PA-19 | Vérification d'un permis depuis une étape de CI | S |
| PA-20 | Détection des actions sensibles non déclarées | C |
| PA-21 | Politique proposée d'après l'historique | C |
| PA-22 | Délégation : un sous-agent reçoit un permis plus étroit que celui de son parent | C |

## 14. Outils MCP et agent Rovo

### Outils, exposés par `rovo:mcp`

| Clé | Verbe | Entrées | Retour |
|---|---|---|---|
| `check-permission` | GET | `issueKey`, `actionClass`, `target`, `description` | Décision, niveau, règle appliquée, marche à suivre |
| `get-policy` | GET | `projectKey` | Politique résumée, pour planifier |
| `request-approval` | CREATE | `issueKey`, `actionClass`, `target`, `justification`, `plan` | Numéro de demande, approbateurs sollicités |
| `get-request-status` | GET | `requestId` | En attente, accordée avec permis, refusée avec motif |
| `list-permits` | GET | `issueKey` | Permis valides et usages restants |
| `declare-action` | CREATE | `issueKey`, `actionClass`, `target`, `outcome`, `permitId` | Entrée de journal |
| `submit-plan` | CREATE | `issueKey`, `plan` | Décision par action, demande groupée |
| `get-agent-standing` | GET | `agentProfile` | Capital de confiance et effets en cours |

Un agent en attente d'approbation ne boucle pas sur `get-request-status`. Ses consignes lui disent de s'arrêter, d'annoncer le numéro de la demande, et de reprendre quand le pilote le relance.

### Agent « Permis d'agir »

Pour les humains, dans Rovo Chat :

- « Qu'ont fait les agents sur le projet Paiements cette semaine ? »
- « Pourquoi la demande PA-2026-000417 a-t-elle été refusée ? »
- « Un agent a-t-il le droit de modifier la CI ici ? »
- « Quelles règles sont le plus souvent dérogées ? »

## 15. Écrans

1. **Panneau sur le ticket** (`jira:issuePanel`). Demandes en attente avec leurs cartes, permis en cours, actions déclarées, écarts.
2. **Réglages du projet** (`jira:projectSettingsPage`). Grille classes × zones, approbateurs par classe, durées par défaut, mode de chaque règle, téléchargement du fichier de hooks.
3. **Page projet « Agents »** (`jira:projectPage`). Journal, demandes par état, profils d'agents et capital, arrêt d'urgence, rapport d'observation.
4. **Console de simulation.** Saisir classe, cible, ticket : décision, règle, reclassement.
5. **Page globale** (`jira:globalPage`). Vue de l'organisation, plancher de politique, arrêt d'urgence général.
6. **Vérification du journal.** État de la chaîne, première rupture éventuelle.

## 16. Architecture Forge

Une app installée sur Jira.

```yaml
# Esquisse, à valider avec forge lint
modules:
  rovo:mcp:
    - key: permis-mcp
      name: Permis d'agir
      tools: [check-permission, get-policy, request-approval, get-request-status,
              list-permits, declare-action, submit-plan, get-agent-standing]
  action:                    # une entrée par outil
  rovo:agent:
  webtrigger:
    - key: gate              # point d'entrée du hook et de la vérification en CI
      function: handleGate
      urlFormat: v2
      response: { type: dynamic }
  jira:issuePanel:
  jira:projectSettingsPage:
  jira:projectPage:
  jira:globalPage:
  jira:personalSettingsPage: # génération du jeton personnel du hook
  trigger:                   # avi:jira:updated:issue (statut du ticket, incidents liés)
  scheduledTrigger:          # expiration des permis, érosion du capital, vérification de la chaîne
  sql:
  llm:                       # classement des descriptions libres
```

### Déroulement d'une décision

1. L'appel arrive par MCP ou par le hook. L'identité vient du contexte de l'appel (compte Atlassian) ou du jeton personnel du hook, jamais des entrées.
2. L'action est classée, puis reclassée si la cible ou la commande l'exige.
3. Les règles applicables sont résolues ; la plus restrictive gagne.
4. Un permis valide couvrant exactement cette action est cherché et, s'il existe, décompté.
5. La décision est écrite au journal, puis renvoyée avec sa raison.

### Jetons personnels du hook

Chaque développeur génère son jeton dans les réglages personnels de l'app. Il n'est affiché qu'une fois et l'app n'en garde qu'une empreinte. Il identifie le pilote ; il ne donne aucun droit par lui-même.

### Ce que reçoit le point d'entrée du hook

L'événement du client : nom de l'outil, arguments (commande, chemin du fichier), dossier de travail. L'app n'a pas besoin du contenu des fichiers et ne le demande pas.

## 17. Modèle de données (Forge SQL)

| Table | Colonnes principales |
|---|---|
| `policy_rule` | id, scope (organisation, projet), project_id, action_class, zone_id, conditions_json, level, mode |
| `zone` | id, project_id, name, path_patterns, component, environment |
| `agent_profile` | id, project_id, name, client, trust_score, status |
| `request` | id, issue_id, profile_id, pilot_account_id, action_class, target, justification, plan, status, created_at |
| `approval` | id, request_id, approver_account_id, role, decision, reason, at |
| `permit` | id, request_id, scope_json, expires_at, uses_left, signature, revoked_at |
| `ledger` | seq, at, kind, project_id, issue_id, profile_id, pilot_account_id, action_class, target, rule_id, decision, permit_id, prev_hash, hash |
| `trust_event` | id, profile_id, delta, reason, ledger_seq, at |
| `kill_switch` | scope, project_id, active, by, reason, at |
| `hook_token` | account_id, token_hash, created_at, last_used_at |

## 18. Contraintes vérifiées et points à valider

### Vérifié dans la documentation (10 et 11 novembre 2026)

- `rovo:mcp` : en Preview, un module par app, 50 outils au plus. L'accès par un client externe se fait à `https://mcp.atlassian.com/forge/<appId>`, en OAuth 2.1, après activation par un administrateur pour l'installation.
- Depuis un client externe, un outil s'exécute avec les droits de l'utilisateur qui a autorisé le client.
- Action Forge : entrées limitées aux chaînes, entiers, nombres et booléens ; 55 s ; les entrées peuvent être inventées par le modèle, l'identité se lit dans le contexte.
- Les agents déclenchés par une règle d'automatisation n'appellent que les actions `GET`.
- Web trigger : adresse propre à l'installation, aucune authentification par défaut, 55 s.
- Hooks de Claude Code : événement `PreToolUse`, filtrage par nom d'outil (outils MCP compris) et par arguments, types `command`, `http` et `mcp_tool`, refus par code de sortie ou par décision `deny`, `ask`, `allow`, option `onFailure: "block"`.
- Forge SQL : 1 Gio par installation en production, 5 s par SELECT, pas de clés étrangères.
- Une app Forge installée sur Jira ne peut pas appeler l'API Bitbucket ; le contrôle de fusion du point 3 demande donc une app compagne côté Bitbucket.

### À valider par un prototype la première semaine

| Point | Pourquoi | Solution de repli |
|---|---|---|
| Identité transmise à une action lors d'un appel MCP externe | Fonde l'interdiction d'auto-approbation | Jeton personnel exigé aussi par MCP |
| Hook de type `mcp_tool` : forme de la décision renvoyée | Éviterait le web trigger et le jeton | Hook `http` vers le web trigger |
| Temps de réponse du web trigger sous charge | Le hook s'exécute à chaque appel d'outil filtré | Filtrer par motifs côté client, cache de politique |
| Équivalent des hooks dans les autres clients | Portée au-delà de Claude Code | Points 1, 3 et 4 du § 10 |
| Chaînage d'empreintes sous écritures concurrentes | Intégrité du journal | Numéro de séquence attribué par une file à un seul consommateur |
| Notification des approbateurs | Délai d'approbation | Mention dans un commentaire du ticket |

## 19. Exigences non fonctionnelles

- **Rapidité.** Décision en moins de 2 s par MCP, moins de 1 s par le hook dans 95 % des cas.
- **Fermé par défaut.** Sans réponse de l'app, tout appel d'outil filtré par le hook est bloqué. Le fichier de hooks ne filtre que les outils et motifs sensibles, pour ne pas arrêter le travail courant.
- **Séparation des pouvoirs.** Celui qui pilote n'approuve pas ; celui qui règle la politique est tracé ; l'agent ne touche ni à la politique ni aux hooks.
- **Intégrité.** Journal chaîné, vérifié chaque nuit, aucune suppression.
- **Sobriété.** L'app reçoit des noms d'outils, des chemins et des commandes, jamais le contenu des fichiers. Les commandes sont masquées par motif avant stockage (jetons, mots de passe).
- **Explicabilité.** Aucun refus sans règle citée et sans marche à suivre.
- **Langues.** Interface en anglais et en français ; soumission en anglais.

## 20. Cas limites

- Action sans ticket : refusée au-delà de N4, avec l'invitation à citer un ticket.
- Cible décrite de façon vague (« nettoyer la base ») : classée au plus restrictif, précision demandée.
- Permis accordé pour un fichier, action sur un autre : refus, écart journalisé.
- Permis expiré pendant l'exécution : l'action en cours n'est pas interrompue, la suivante est refusée.
- Approbateur absent : relance après un délai réglable, puis escalade au rôle suivant ; jamais d'approbation automatique.
- Deux agents sur le même ticket : chacun son profil, ses demandes, ses permis.
- Arrêt d'urgence pendant une demande en attente : la demande est gelée et reprend à la levée.
- Correctif d'incident de nuit : une règle conditionnelle peut ramener N2 à N3 pour les tickets liés à un incident ouvert, avec notification immédiate.
- Agent sans hook installé : seules les protections 1, 3 et 4 jouent ; le profil est marqué « non contraint » dans le journal.
- Commande composée (`a && b`) : chaque partie est classée, la plus restrictive décide.

## 21. Recette

1. Une action A-08 sur un fichier de `migrations/`, annoncée par l'agent comme A-02, est reclassée A-08 et la réponse le dit.
2. Une demande N2 apparaît sur le ticket ; le pilote ne peut pas l'accorder ; un approbateur habilité le peut.
3. Le permis accordé pour une cible laisse passer cette action une fois, puis refuse la seconde.
4. Un permis expiré ou révoqué ne laisse rien passer.
5. Une action A-10 est refusée quel que soit le capital de confiance.
6. Arrêt d'urgence actif : toute action au-delà de la lecture est refusée, y compris avec un permis.
7. Le hook refuse une commande de suppression de données sans permis et la laisse passer avec.
8. Si l'app ne répond pas, le hook bloque l'action.
9. Modifier une entrée du journal en base fait apparaître une rupture de chaîne à l'écran de vérification.
10. La console de simulation renvoie la même décision que l'outil MCP pour la même action.
11. En mode observation, rien n'est bloqué et tout est journalisé.

## 22. Scénario de la vidéo (moins de 5 minutes, en anglais)

| Temps | Contenu |
|---|---|
| 0:00 – 0:30 | Un agent supprime un test qui échoue pour faire passer son build. Personne ne l'a autorisé, personne ne le sait. |
| 0:30 – 1:10 | La grille de politique du projet : six niveaux, quinze classes |
| 1:10 – 2:10 | L'agent veut purger une table : le hook refuse, une demande apparaît sur le ticket, le tech lead lit la carte et accorde 30 minutes, l'agent reprend |
| 2:10 – 2:40 | L'agent tente de désactiver un test : refusé, raison affichée, capital en baisse |
| 2:40 – 3:10 | Arrêt d'urgence : tout s'arrête en un clic |
| 3:10 – 3:50 | Le journal : la chaîne complète d'une action, de la demande au commit qui cite le permis |
| 3:50 – 4:20 | Agent Rovo : « Qu'ont fait les agents cette semaine ? » |
| 4:20 – 4:50 | Architecture : actions Forge, `rovo:mcp`, hook, journal chaîné |

## 23. Comment les juges testeront

1. **Dans Jira seul.** Console de simulation, grille de politique, agent Rovo, demande et approbation sur un ticket d'exemple, journal, arrêt d'urgence.
2. **Avec un client MCP.** Activer l'exposition externe, connecter le client, appeler `check-permission`.
3. **Avec le hook.** Déposer le fichier généré dans un dépôt d'essai et tenter une action sensible.

## 24. Plan jusqu'au 22 décembre

| Semaine | Objectif |
|---|---|
| 11 – 17 nov. | Les six validations du § 18 ; `check-permission` appelé par MCP et par le hook |
| 18 – 24 nov. | Classes, zones, règles, résolution, reclassement, console de simulation |
| 25 nov. – 1er déc. | Demandes, approbations, permis, panneau du ticket |
| 2 – 8 déc. | Journal chaîné, arrêt d'urgence, réglages, fichier de hooks généré |
| 9 – 15 déc. | Agent Rovo, mode observation, capital de confiance ; gel des fonctionnalités le 15 |
| 16 – 22 déc. | Recette, vidéo, instructions pour les juges, soumission, dépôt Marketplace |

## 25. Risques

| Risque | Parade |
|---|---|
| « Un agent peut ignorer l'outil » | Le § 10 l'assume et fournit le hook, fermé par défaut |
| Trop d'interruptions, donc contournement | Niveaux N4 et N5 larges, mode observation avant tout durcissement, plan d'abord |
| Approbation donnée sans lire | Carte courte, précédents, motif obligatoire pour refuser comme pour une durée longue |
| Dépendance à un seul client pour le hook | Outil MCP et vérification en CI valables pour tous |
| Latence du hook | Filtrage par motifs, cache, objectif d'une seconde mesuré |
| Fausse impression de sécurité | L'app affiche pour chaque profil quels points d'application sont réellement en place |

## 26. La vision poussée à l'extrême

- **La politique s'écrit toute seule.** « Les 40 dernières demandes de mise à jour mineure ont toutes été accordées et confirmées : passer cette classe en N4 ? » À l'inverse : « Trois incidents ont suivi une modification de la CI par un agent : la passer en N1 ? »
- **Chaîne de délégation.** Un agent qui lance des sous-agents leur transmet un permis plus étroit que le sien, jamais plus large. Le journal montre l'arbre entier.
- **Budgets.** Un plafond par ticket et par jour : nombre d'actions autonomes, fichiers modifiés, dépense déclarée. Au-delà, retour à l'approbation.
- **Preuve de supervision humaine.** Pour chaque changement livré, l'organisation peut produire qui a autorisé quoi, quand et sur quelle règle. C'est le dossier qu'un auditeur ou un client demandera.
- **Un permis pour tous les agents.** Agents de code, agents Rovo qui modifient des tickets, agents d'exploitation : même registre, mêmes niveaux, même journal.
- **Le permis devient un standard d'équipe à équipe.** Une équipe publie ce qu'elle laisse faire aux agents des autres sur ses services.

## 27. Liens avec les autres cahiers des charges

- **Brief de contexte (02)** répond à « que dois-je savoir ? ». Celui-ci répond à « qu'ai-je le droit de faire ? ». Même socle MCP ; le brief peut inclure la politique applicable.
- **Merge avec contexte (03)** fournit le point d'application n° 3 : une règle « zone sensible sans permis valide ».
- **Fait, preuve à l'appui (07)** utilise la classe A-04 : un agent ne supprime pas le test qui prouve un critère.

## 28. Sources

- [Codegeist 2026](https://codegeist2026.devpost.com/) et son [règlement](https://codegeist2026.devpost.com/rules)
- [Module Rovo MCP](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-mcp/)
- [Module Action](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-action/)
- [Module Rovo Agent](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/)
- [Web trigger](https://developer.atlassian.com/platform/forge/manifest-reference/modules/web-trigger/)
- [Hooks de Claude Code](https://code.claude.com/docs/en/hooks)
- [Modules Jira](https://developer.atlassian.com/platform/forge/manifest-reference/modules/index-jira/)
- [Limites d'invocation](https://developer.atlassian.com/platform/forge/limits-invocation/) et [limites SQL](https://developer.atlassian.com/platform/forge/limits-sql/)
