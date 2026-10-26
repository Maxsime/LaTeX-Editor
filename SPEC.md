# Galley — cahier des charges

Version 1.0 — octobre 2026

## 1. Objet et périmètre

Galley est une application web auto-hébergée de rédaction LaTeX collaborative, dotée d'un assistant IA intégré au projet.

Objectifs de parité :

- avec Overleaf : édition, compilation, aperçu PDF, SyncTeX, collaboration temps réel, commentaires, suivi des modifications, historique, pont Git ;
- avec Prism : assistant IA qui exploite la structure du projet (fichiers, équations, labels, références), édition directe sous validation, conversion image vers LaTeX, recherche bibliographique.

Déploiement : un seul hôte (PC ou VPS) via Docker Compose. Cible : 1 à 20 comptes, jusqu'à 10 éditeurs simultanés sur un même projet.

## 2. Usages de référence

Ces usages servent de fil conducteur aux tests de bout en bout.

- U1. Rapport technique multi-fichiers : classe maison dérivée de `report`, un `\include` par chapitre, BibLaTeX + Biber, figures TikZ et pgfplots, listings de code.
- U2. Présentation Beamer avec thème personnalisé et overlays.
- U3. Article court rédigé à plusieurs, relu par un encadrant via commentaires et suivi des modifications.
- U4. Reprise d'un projet exporté d'Overleaf ou de Prism (archive zip ou dépôt Git).
- U5. Rédaction assistée : correction d'une erreur de compilation, génération d'une figure TikZ, ajout d'une référence trouvée par recherche bibliographique.

## 3. Exigences fonctionnelles

Priorités : P0 indispensable à la première version utilisable, P1 attendu pour la parité, P2 confort.

### 3.1 Projets et fichiers

- P0 Tableau de bord : liste des projets, recherche, tri, étiquettes, archivage, corbeille restaurable pendant 30 jours.
- P0 Création d'un projet : vide, depuis un modèle, depuis une archive zip, depuis un dépôt Git distant (clone HTTPS).
- P0 Arborescence : dossiers, création, renommage, déplacement par glisser-déposer, suppression, upload multiple de fichiers et de dossiers, aperçu des images et des PDF.
- P0 Document principal configurable, détecté par défaut comme le fichier contenant `\documentclass` à la racine.
- P0 Export : archive zip des sources, PDF compilé.
- P1 Duplication de projet, copie de fichiers entre projets.
- P1 Modèles : galerie d'instance (article, rapport, Beamer, lettre) et modèles personnels créés à partir d'un projet existant.
- P1 Répertoire texmf personnel : chaque utilisateur dépose ses classes, styles et fichiers .bib communs dans un espace dédié, monté en `TEXMFHOME` pour toutes les compilations de ses projets (celui du propriétaire du projet fait foi en collaboration).
- P2 Fichiers liés : fichier importé depuis une URL ou un autre projet, actualisable à la demande.

### 3.2 Éditeur

- P0 CodeMirror 6 : coloration LaTeX et BibTeX, numéros de ligne, repli (environnements, sections), appariement des accolades et des paires `\begin`/`\end`, indentation automatique, retour à la ligne visuel, multicurseur.
- P0 Onglets de fichiers ouverts. Raccourcis compatibles Overleaf pour les actions courantes (Ctrl+Entrée et Ctrl+S compilent, Ctrl+/ commente).
- P0 Autocomplétion :
  - commandes et environnements, à partir d'une base intégrée et des définitions du projet (`\newcommand`, `\NewDocumentCommand`, `\DeclareMathOperator`, `\newenvironment`) ;
  - `\ref`, `\eqref`, `\cref`, `\autoref`, `\pageref` à partir des `\label` du projet ;
  - `\cite` et variantes BibLaTeX à partir des .bib, avec titre, auteurs et année affichés ;
  - `\input`, `\include`, `\includegraphics`, `\addbibresource` à partir de l'arborescence ;
  - options des packages courants.
- P0 Plan du document (parties, chapitres, sections, frames Beamer) cliquable et synchronisé avec la position du curseur.
- P0 Recherche et remplacement dans le fichier et dans tout le projet : expressions régulières, respect de la casse, mot entier.
- P1 Aperçu des formules au survol (KaTeX, repli sur MathJax), aperçu des couleurs définies.
- P1 Palette de symboles mathématiques avec recherche par nom.
- P1 Assistants d'insertion : tableau (grille vers `tabular` avec booktabs), figure, équations alignées.
- P1 Diagnostics en ligne : `\label` dupliqués, `\ref` sans cible, clés de citation inconnues, environnements non fermés.
- P1 Modes Vim et Emacs, thèmes clair et sombre, taille de police réglable.
- P2 Éditeur visuel : rendu semi-WYSIWYG des titres, emphases, listes et formules, la source restant du LaTeX.

### 3.3 Compilation et aperçu PDF

- P0 Moteurs pdfLaTeX, XeLaTeX et LuaLaTeX. Bibliographie par Biber (défaut) ou BibTeX. Index et glossaires (makeindex, makeglossaries, bib2gls). Orchestration par latexmk.
- P0 TeX Live complet, millésime figé par instance et affiché dans l'interface.
- P0 Compilation manuelle et automatique (à l'arrêt de la frappe, délai configurable). Une seule compilation active par projet ; une nouvelle demande remplace celle en attente. Annulation d'une compilation en cours.
- P0 Visionneuse PDF.js : zoom, ajustement à la largeur ou à la page, conservation de la position de lecture entre deux compilations, liens internes et externes actifs, téléchargement.
- P0 Journal analysé : erreurs, avertissements et boîtes mal remplies, avec fichier et ligne ; clic vers la source ; marqueurs dans la gouttière de l'éditeur ; journal brut consultable.
- P0 Options « arrêt à la première erreur » et mode brouillon.
- P0 SyncTeX bidirectionnel : double-clic dans le PDF vers la position source ; raccourci depuis l'éditeur vers la zone correspondante, surlignée dans le PDF.
- P1 Fichiers intermédiaires conservés entre compilations (cache par projet) ; action « nettoyer et recompiler ».
- P1 Visionneuse : mode sombre par inversion, dispositions côte à côte, PDF seul, éditeur seul, PDF dans une fenêtre détachée.
- P1 Accès aux fichiers générés (.log, .aux, .bbl, .blg, .synctex.gz, sorties annexes).
- P1 shell-escape par projet : désactivé, restreint (défaut TeX Live) ou complet si l'administrateur l'autorise.
- P2 Précompilation du préambule pour les documents volumineux.
- P2 Compilation d'un extrait isolé (classe `standalone`) pour prévisualiser une figure ou une formule.

### 3.4 Collaboration temps réel

- P0 Édition simultanée sans conflit (CRDT). Curseurs et sélections des participants, avec nom et couleur. Liste des présents et fichier ouvert par chacun.
- P0 Partage : invitation par adresse e-mail ou nom d'utilisateur, lien d'invitation révocable. Rôles : propriétaire, éditeur, relecteur (commentaires et suggestions uniquement), lecteur.
- P0 Tolérance aux coupures : modifications locales conservées et fusionnées à la reconnexion, indicateur d'état de synchronisation.
- P1 Commentaires ancrés sur une plage de texte : fils de discussion, mentions, résolution et réouverture, panneau de revue.
- P1 Suivi des modifications (mode suggestion), activable par utilisateur ou pour tous : insertions et suppressions attribuées et datées, acceptation et rejet unitaires ou en masse.
- P1 Discussion instantanée par projet.
- P2 Notifications par e-mail (SMTP optionnel) pour les mentions et invitations.
- P2 Suivre un collaborateur (l'éditeur suit son curseur).

### 3.5 Historique et Git

- P0 Historique automatique : instantanés réguliers, liste chronologique avec auteurs, différences par fichier entre deux versions, restauration d'un fichier ou du projet. Une restauration crée une nouvelle version et ne détruit rien.
- P1 Versions nommées, téléchargement d'une version en zip.
- P1 Pont Git : chaque projet est clonable et modifiable par `git clone https://<hôte>/git/<projectId>`, authentification par jeton personnel. Un push est répercuté en direct chez les collaborateurs connectés.
- P2 Synchronisation à la demande avec un dépôt GitHub ou GitLab distant.

### 3.6 Bibliographie

- P0 Édition des .bib avec coloration, validation de syntaxe et détection des clés dupliquées.
- P1 Import d'une entrée par DOI (Crossref), identifiant arXiv, ISBN (Open Library) ou collage BibTeX. Génération de clé normalisée selon un motif paramétrable.
- P1 Panneau de références : recherche dans les .bib du projet, insertion de `\cite`, distinction des entrées citées et non citées.
- P1 Import depuis Zotero (API web avec clé utilisateur, ou export Better BibTeX).
- P2 Tri et formatage automatiques des .bib.

### 3.7 Qualité rédactionnelle

- P1 Correction orthographique et grammaticale en français et en anglais par LanguageTool auto-hébergé. Les commandes, environnements mathématiques et arguments non textuels sont ignorés. Dictionnaire personnel par utilisateur. Langue fixée par projet ou déduite de babel/polyglossia.
- P1 Lint LaTeX par chktex, affiché dans l'éditeur, règles désactivables.
- P1 Comptage de mots par section (texcount).
- P2 Explication en clair des erreurs LaTeX courantes, indépendante de l'IA.

### 3.8 Assistant IA

Détails de conception en §6.8.

- P1 Fournisseurs configurables : Anthropic, OpenAI, Mistral et tout point d'accès compatible OpenAI (Ollama, vLLM, LM Studio). Clé fournie par l'utilisateur ou configuration par défaut définie par l'administrateur.
- P1 Panneau de discussion contextualisé (structure du projet, fichier courant, sélection, dernier journal), réponses en flux.
- P1 Édition en ligne : sélection et consigne, proposition affichée en différentiel, acceptation ou rejet par bloc.
- P1 Action « expliquer et corriger » sur chaque erreur du journal de compilation.
- P1 Génération de tableaux, figures TikZ/pgfplots et formules à partir d'une description, avec aperçu compilé avant insertion.
- P1 Image vers LaTeX : photo de tableau blanc, formule manuscrite ou capture d'écran convertie en équation ou en code TikZ (modèle multimodal requis).
- P1 Recherche bibliographique (arXiv, Crossref, OpenAlex, Semantic Scholar) et ajout d'entrées vérifiées au .bib.
- P1 Désactivation de l'IA par projet (documents confidentiels) et pour toute l'instance.
- P1 Consommation affichée par requête et cumulée (jetons, coût estimé).
- P2 Mode agent : tâche en plusieurs étapes sur plusieurs fichiers, avec plan affiché, compilation de contrôle et changeset global soumis à validation.

### 3.9 Comptes et administration

- P0 Comptes locaux. Inscription ouverte, sur invitation ou fermée selon la configuration. Réinitialisation du mot de passe par e-mail si SMTP est configuré, sinon par l'administrateur.
- P1 Connexion OIDC (Keycloak, Authentik, Google, GitHub, etc.).
- P1 Console d'administration : utilisateurs, quotas (espace disque, temps de compilation), état des services, file de compilation, millésime TeX Live, configuration IA par défaut, table des prix des modèles.
- P1 Préférences utilisateur : thème, raccourcis, compilation automatique, langue d'interface, fournisseur IA.

## 4. Pile technique imposée

| Domaine | Choix |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Langage | TypeScript ; Node.js 22 LTS côté serveur |
| Interface | React 19, Vite, TanStack Router, TanStack Query, Zustand, Tailwind CSS, Radix UI |
| Éditeur | CodeMirror 6 ; grammaire Lezer LaTeX (évaluer `codemirror-lang-latex`, sinon grammaire propre) |
| Collaboration | Yjs, y-codemirror.next, Hocuspocus (serveur, provider, extensions database et redis) |
| Visionneuse | pdfjs-dist |
| API | Fastify, Zod, Drizzle ORM |
| Base de données | PostgreSQL 16 |
| File et pub/sub | Valkey (compatible Redis) + BullMQ |
| Stockage binaire | MinIO (API S3), contenu adressé par empreinte SHA-256 |
| Compilation | image dérivée de `texlive/texlive` (millésime figé), latexmk, bubblewrap |
| Correcteur | LanguageTool (serveur HTTP en conteneur) |
| IA | Vercel AI SDK : `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/mistral`, `@ai-sdk/openai-compatible` |
| Git | `git` natif, dépôts nus, protocole smart HTTP via `git http-backend` |
| Tests | Vitest, Playwright, Testcontainers |
| Frontal | Caddy (TLS automatique, fichiers statiques, proxy HTTP et WebSocket) |
| Observabilité | pino, point de collecte `/metrics` au format Prometheus |

## 5. Architecture

```
               Navigateur : React, CodeMirror, PDF.js, Yjs
                      | HTTPS                 | WSS
                 +----+-----------------------+----+
                 |              Caddy              |
                 +----+-----------------------+----+
                      |                       |
               +------+------+         +------+------+
               |     api     |         |   collab    |
               |  (Fastify)  |         | (Hocuspocus)|
               +-+---+---+---+         +--+---+---+--+
                 |   |   |                |   |   |
                 |   |   +-------+--------+   |   |
                 |   |           |            |   |
          PostgreSQL |        Valkey <--------+   |
                 |   |      (BullMQ, pub/sub)     |
                 |   |           |                |
                 |   +--------> MinIO <-----------+
                 |               ^
                 |               |
                 |        +------+------+
                 |        |  compiler   |  TeX Live + bac à sable
                 |        |  (N workers)|
                 |        +-------------+
                 +---- LanguageTool
```

Rôles :

- `web` : SPA statique servie par Caddy.
- `api` : authentification, projets, arborescence, blobs, historique, pont Git, proxy IA, orchestration des compilations (mise en file, réception des résultats).
- `collab` : un document Yjs par fichier texte ; un canal `project:<id>` pour la présence et les événements sans état (arborescence modifiée, compilation terminée, message de discussion), alimenté par pub/sub Valkey.
- `compiler` : consomme la file, synchronise le répertoire de travail, compile dans le bac à sable, publie PDF, journal et SyncTeX dans MinIO, répond aux requêtes SyncTeX.
- `languagetool` : appelé par l'API, jamais directement par le navigateur.

## 6. Points de conception

### 6.1 Modèle de données (principales tables)

- `users`, `sessions`, `oidc_identities`, `personal_access_tokens`
- `projects` : propriétaire, nom, fichier principal, moteur, outil bibliographique, mode shell-escape, IA activée, archivé le, supprimé le, type (`document` ou `texmf`, le texmf personnel étant un projet de type `texmf`)
- `project_members` (rôle), `invites` (jeton, rôle, expiration, révocation)
- `files` : projet, parent, nom, nature (`folder`, `text`, `binary`), empreinte du blob pour les binaires ; unicité (projet, parent, nom)
- `yjs_states` : état Yjs encodé par fichier texte, date de mise à jour
- `blobs` : empreinte, taille, type MIME
- `snapshots` : projet, date, étiquette, auteurs, manifeste `{chemin: empreinte}`
- `comment_threads`, `comments` (les ancres vivent dans le document Yjs, §6.6)
- `chat_messages`
- `compile_runs` : statut, moteur, durée, résumé du journal, références des sorties dans MinIO
- `ai_provider_configs` (clé chiffrée), `ai_usage`, `ai_model_prices`

### 6.2 Source de vérité et synchronisation

- Arborescence et métadonnées : PostgreSQL. Toute modification passe par l'API, qui publie un événement diffusé sur le canal du projet.
- Contenu des fichiers texte : un `Y.Doc` par fichier, nommé `file:<id>`, contenant un `Y.Text` `content`. Persistance par Hocuspocus dans `yjs_states` (anti-rebond court, plafonné à 10 s).
- Fichiers binaires : MinIO, immuables, adressés par empreinte. Remplacer un fichier crée un nouveau blob.
- Instantané cohérent du projet : une fonction unique `materializeProject(projectId)` produit un manifeste `{chemin: empreinte}` à partir de l'état serveur Hocuspocus (connexion directe) et de l'arborescence. Compilation, historique, export et Git l'utilisent tous.
- Avant de demander une compilation, le client attend que ses modifications locales soient acquittées par le serveur, pour que la compilation inclue les dernières frappes.

### 6.3 Compilation

Tâche : `{compileId, projectId, manifest, texmfManifest, mainFile, engine, bibTool, shellEscape, draft, haltOnError}`.

Déroulement :

1. Verrou par projet ; une tâche plus récente annule celle en attente.
2. Synchronisation différentielle du répertoire de travail persistant `work/<projectId>` : seuls les fichiers modifiés sont réécrits, les auxiliaires sont conservés. Éviction LRU selon un quota disque global.
3. Lancement de `latexmk` (`-pdf`, `-xelatex` ou `-lualatex`, `-interaction=nonstopmode`, `-file-line-error`, `-synctex=1`, `-outdir=out`) dans le bac à sable.
4. Publication de `out/<main>.pdf`, `.log`, `.blg` et `.synctex.gz` dans MinIO sous `compiles/<compileId>/`.
5. Analyse du journal, enregistrement dans `compile_runs`, événement « compilation terminée ».

Bac à sable, par compilation :

- aucun accès réseau ; système de fichiers en lecture seule hors du répertoire de travail et d'un tmpfs ;
- utilisateur non privilégié, environnement vidé puis reconstruit : `TEXMFHOME` (texmf personnel en lecture seule), `openout_any=p`, `max_print_line=10000` (évite les coupures de lignes du journal) ;
- limites par défaut, configurables : 180 s, 2 Gio de mémoire, 64 processus, 500 Mio de sortie ;
- annulation et dépassement : arrêt du groupe de processus complet.

Mise en œuvre préférée : bubblewrap (`--unshare-all`, `--die-with-parent`) dans le conteneur worker, ce qui exige un profil seccomp et une configuration AppArmor autorisant les espaces de noms utilisateur (à vérifier sur Debian 12 et Ubuntu 24.04). Repli documenté : un conteneur éphémère par compilation, créé via un proxy de socket Docker limité aux opérations nécessaires. Le choix est fait au J3, justifié par des tests, et consigné.

### 6.4 Analyse des journaux

- Paquet pur `packages/latex-log`. Entrée : journal brut. Sortie : liste `{niveau, fichier, ligne, message, contexte, brut}`.
- Reconstitution de la pile des fichiers ouverts à partir des parenthèses du journal, combinée aux préfixes `fichier:ligne:` de `-file-line-error`.
- Prise en charge des erreurs TeX, avertissements LaTeX et packages, boîtes mal remplies, messages Biber (.blg) et latexmk.
- Tests par instantanés sur les journaux du corpus (§8) et sur des journaux réels ajoutés au fil des anomalies.

### 6.5 SyncTeX

- Requêtes `synctex view` (source vers PDF) et `synctex edit` (PDF vers source) exécutées par le worker dans le répertoire de travail conservé, exposées par l'API. Objectif : moins de 200 ms.
- Les chemins renvoyés sont convertis en identifiants de fichiers du projet ; une position hors projet (classe du texmf, package) est signalée comme telle.

### 6.6 Commentaires et suivi des modifications

- Ancres : paires de `Y.RelativePosition` stockées dans un `Y.Map` `ranges` du document du fichier ; elles suivent les éditions concurrentes.
- Le `Y.Text` contient toujours l'état proposé : insertions suggérées incluses, suppressions suggérées retirées.
- Insertion suggérée : plage ancrée, auteur, date. Accepter retire le marquage ; rejeter supprime le texte.
- Suppression suggérée : le texte supprimé est conservé dans `ranges` avec sa position d'ancrage et affiché barré par un widget CodeMirror. Accepter oublie l'entrée ; rejeter réinsère le texte à l'ancre.
- En mode suggestion, une extension CodeMirror transforme les transactions locales avant leur application à Yjs.
- La compilation porte sur l'état proposé ; compiler la version sans suggestions est une option P2.
- Les fils de discussion sont stockés en base et référencent l'identifiant d'ancre.

### 6.7 Historique et pont Git

Historique :

- un instantané au plus toutes les 5 minutes d'activité, plus un à chaque compilation réussie si l'état a changé ;
- les fichiers texte sont enregistrés comme blobs au moment de l'instantané ; l'adressage par empreinte rend gratuit tout fichier inchangé ;
- les auteurs d'un instantané sont les utilisateurs ayant modifié le projet depuis le précédent ;
- rétention : tout pendant 30 jours, puis un par heure jusqu'à 90 jours, puis un par jour ; les versions nommées sont conservées sans limite.

Pont Git :

- un dépôt nu par projet ; à chaque `fetch`, si l'état a changé depuis le dernier commit servi, un commit est créé à partir de `materializeProject` ;
- à chaque `push` : avance rapide obligatoire depuis le dernier commit servi, sinon rejet avec un message invitant à tirer d'abord ; le différentiel est appliqué comme transaction serveur sur les documents Yjs et l'arborescence (origine `git:<userId>`), les binaires partent dans MinIO ;
- authentification HTTP Basic par jeton personnel ; taille de push plafonnée ; mêmes contrôles de chemins que l'import zip.

### 6.8 Couche IA

Abstraction :

- paquet `packages/ai` exposant une interface unique de discussion en flux avec outils, adossée au Vercel AI SDK ;
- capacités déclarées par modèle (vision, outils, taille de contexte, cache de prompt) pour masquer les fonctions non prises en charge dans l'interface ;
- tous les appels transitent par l'API ; limites de débit par utilisateur ; journal d'usage avec coût estimé à partir de `ai_model_prices`.

Contexte :

- `buildContext` assemble un index compact du projet (arborescence, plan, labels, clés de citation, packages chargés, commandes définies, issu de `packages/latex-index`), le fichier courant tronqué autour du curseur, la sélection et les erreurs du dernier journal ;
- le modèle obtient le reste par outils ; l'index est placé en préfixe stable pour bénéficier du cache de prompt lorsque le fournisseur le permet.

Outils exposés au modèle :

- `list_files`, `read_file(path, startLine?, endLine?)`, `search_project(pattern, regex?)`, `get_outline`, `get_compile_log` ;
- `compile_snippet(latex)` : compilation d'un document `standalone` pour vérifier une figure ou une formule ;
- `propose_changes(edits[])` ;
- `search_literature(query)`, `fetch_bibtex(doi | arxivId | isbn)`.

Règles :

- aucune écriture directe : `propose_changes` produit un changeset affiché en différentiel, accepté en bloc, par fichier ou par hunk ; l'application est une transaction Yjs d'origine `ai:<userId>`, visible dans l'historique ; si le texte visé a changé entre-temps, le hunk est recalé par positions relatives ou signalé en conflit ;
- citations : un `\cite{clé}` proposé n'est accepté que si la clé existe dans un .bib du projet ou provient d'un résultat de `fetch_bibtex` de la même session ; toute entrée ajoutée à un .bib est issue d'une API bibliographique, jamais rédigée par le modèle ; ce contrôle est fait côté serveur sur le changeset ;
- les prompts système sont versionnés dans `packages/ai/prompts/` et couverts par une petite suite d'évaluation (scénarios fixes, vérification que le résultat compile) ;
- mode agent (P2) : boucle d'outils bornée en nombre d'étapes et en budget de jetons, plan affiché, compilation de contrôle avant soumission.

## 7. Exigences non fonctionnelles

- Latence de collaboration : moins de 150 ms entre une frappe et son affichage chez un collaborateur sur réseau local.
- Ouverture d'un projet de 50 fichiers : moins de 2 s.
- Recompilation à chaud d'un rapport de 30 pages sous pdfLaTeX, bibliographie inchangée : moins de 4 s sur un poste récent.
- Fiabilité : en cas d'arrêt brutal du service `collab`, perte maximale de 10 s de frappe côté serveur, rattrapée par le renvoi automatique des clients connectés.
- Sauvegarde : `scripts/backup.sh` (pg_dump, miroir MinIO, dépôts Git) et `scripts/restore.sh`, exercés en CI sur une instance jetable ; exécution quotidienne planifiée.
- Sécurité : règles de `CLAUDE.md`, politique CSP stricte, `pnpm audit` en CI.
- Accessibilité : navigation complète au clavier, contrastes conformes WCAG AA.
- Internationalisation : français (défaut) et anglais.
- Navigateurs : versions récentes de Chrome, Firefox et Safari ; consultation sur tablette.
- Mises à jour : migrations Drizzle versionnées, appliquées au démarrage ; changement de millésime TeX Live documenté.

## 8. Corpus de compilation

Répertoire `fixtures/projects/`, compilé en intégration à chaque modification du worker. Chaque projet est accompagné du résultat attendu (PDF produit, ou liste d'erreurs avec fichier et ligne).

1. Article minimal sous pdfLaTeX.
2. Rapport multi-fichiers : `\include`, sous-dossiers, classe locale `.cls`, images PNG, JPEG et PDF.
3. BibLaTeX + Biber, styles numérique et auteur-année.
4. BibTeX classique avec natbib.
5. TikZ et pgfplots lisant un fichier CSV du projet.
6. Beamer avec thème et overlays.
7. XeLaTeX avec fontspec ; LuaLaTeX.
8. Glossaires et index.
9. minted : comportement attendu documenté pour chaque mode shell-escape.
10. Erreurs volontaires : commande indéfinie, accolade manquante, fichier manquant, référence indéfinie, boucle infinie (`\def\a{\a}\a`) qui doit être interrompue par la limite de temps.
11. Tentatives malveillantes : lecture de fichiers hors projet (`\input{/etc/passwd}`, `io.open` en Lua), exécution de commandes (`\write18`, `os.execute`), ouverture de socket depuis Lua. Aucune ne doit exposer de donnée hors du projet et du texmf, ni atteindre le réseau.

## 9. Jalons

### J0 — Fondations

Monorepo, outillage (lint, format, typecheck), Docker Compose (PostgreSQL, Valkey, MinIO, Caddy), squelettes des services avec point de santé, configuration validée par Zod, migrations, CI (lint, types, tests, construction des images).

Critères d'acceptation : `docker compose up` amène tous les services à l'état sain ; CI verte ; page d'accueil servie en HTTPS local.

### J1 — Comptes, projets, fichiers

Authentification locale et sessions, tableau de bord, création et gestion des projets, arborescence, upload, blobs, import et export zip sécurisés.

Critères d'acceptation : import du zip d'un vrai projet Overleaf, arborescence restituée à l'identique ; réexport donnant les mêmes chemins et les mêmes empreintes ; archive malveillante (`../`, zip bomb) rejetée.

### J2 — Éditeur

CodeMirror 6 et grammaire LaTeX, onglets, contenu porté par Yjs et Hocuspocus dès ce jalon, plan, recherche projet, autocomplétion de base (commandes, environnements, fichiers), thèmes.

Critères d'acceptation : édition fluide d'un fichier de 5 000 lignes ; rechargement de la page sans perte ; plan et recherche projet couverts par des tests e2e.

### J3 — Compilation et aperçu

Worker, bac à sable, file, cache, trois moteurs, visionneuse PDF.js, compilation automatique, annulation, analyse du journal, marqueurs d'erreurs.

Critères d'acceptation : tout le corpus §8 produit le résultat attendu ; toutes les tentatives malveillantes échouent ; objectif de recompilation à chaud (§7) atteint ; position de lecture conservée entre deux compilations.

### J4 — Navigation et diagnostics

SyncTeX bidirectionnel, saut aux erreurs, autocomplétion des labels, références et citations, diagnostics en ligne (§3.2).

Critères d'acceptation : sur le projet 2 du corpus, un double-clic dans le PDF positionne le curseur sur la bonne ligne du bon fichier, y compris dans un fichier inclus, dans au moins 95 % des cas mesurés.

### J5 — Collaboration

Contrôle d'accès sur les WebSockets, présence et curseurs, partage, invitations, rôles, liens révocables, reconnexion, événements de projet.

Critères d'acceptation : trois navigateurs éditant le même paragraphe convergent vers un état identique ; un lecteur qui forge un message de modification est rejeté côté serveur ; coupure réseau de 30 s suivie d'une reconnexion sans perte.

### J6 — Historique et Git

Instantanés, différences, restauration, versions nommées, pont Git, jetons personnels.

Critères d'acceptation : `git clone`, modification locale et `git push` visibles en direct dans un éditeur ouvert ; modification faite dans l'éditeur récupérée par `git pull` ; restauration d'une version ancienne sans perte d'historique.

### J7 — Revue

Commentaires, mentions, suivi des modifications, panneau de revue, discussion de projet.

Critères d'acceptation : un relecteur ne peut produire que des suggestions et des commentaires ; accepter ou rejeter une suggestion restitue exactement le texte attendu, y compris sous édition concurrente (tests de propriétés).

### J8 — Bibliographie et qualité rédactionnelle

Panneau de références, import DOI, arXiv, ISBN et Zotero, LanguageTool, chktex, texcount, palette de symboles, aperçu des formules, assistants d'insertion.

Critères d'acceptation : l'import d'un DOI réel produit une entrée compilée sans erreur par Biber ; aucun signalement LanguageTool sur les commandes LaTeX du corpus ; une faute volontaire en français est détectée.

### J9 — Assistant IA

Paquet `ai`, configuration des fournisseurs, discussion contextualisée, édition en ligne avec différentiel, correction d'erreurs, génération avec aperçu, image vers LaTeX, recherche bibliographique vérifiée, suivi de consommation, désactivation par projet.

Critères d'acceptation : un même scénario fonctionne avec Anthropic et avec un modèle local via Ollama ; aucun fichier n'est modifié avant acceptation ; une clé de citation inventée est rejetée par le serveur ; la clé API n'apparaît dans aucune réponse HTTP ni dans aucun log.

### J10 — Administration et exploitation

Console d'administration, quotas, OIDC, sauvegarde et restauration, métriques, documentation d'installation et de mise à jour.

Critères d'acceptation : restauration complète d'une instance sur une machine vierge à partir d'une sauvegarde ; installation documentée reproductible en moins de 15 minutes.

### J11 — Confort (P2)

Éditeur visuel, mode agent, précompilation du préambule, synchronisation GitHub/GitLab, notifications e-mail, fichiers liés, compilation de la version sans suggestions.

## 10. Hors périmètre

- Application mobile native et édition hors ligne prolongée.
- Formats autres que LaTeX (Markdown, Typst).
- Facturation et hébergement public multi-locataires.
- Compilation répartie sur plusieurs hôtes.
