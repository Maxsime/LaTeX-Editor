# Décisions techniques

Ce journal consigne les décisions qui complètent ou modifient la pile imposée (`SPEC.md` §4), ainsi que les choix internes susceptibles d'être remis en question. Chaque entrée indique la date, le contexte, la décision et les alternatives écartées.

## 2026-10-26 — SeaweedFS remplace MinIO pour le stockage objet

Contexte. `SPEC.md` §4 impose MinIO. Fin 2025, MinIO a cessé de publier les images Docker de son édition communautaire, puis archivé le dépôt source. Conserver MinIO imposerait de figer une image sans correctifs de sécurité ou de la reconstruire soi-même.

Décision. Le stockage objet est assuré par SeaweedFS (`chrislusf/seaweedfs`, licence Apache-2.0) en mode `server -s3`. Le code ne dépend que de l'API S3, via `@aws-sdk/client-s3`, et ne contient aucune référence propre au fournisseur. Les variables d'environnement sont nommées `S3_*` et non `MINIO_*`.

Alternatives écartées. Garage : solide, mais exige d'appliquer une topologie de cluster par commande après le premier démarrage, ce qui contredit « aucune intervention manuelle ». RustFS : trop jeune. MinIO figé : risque de sécurité non maîtrisé.

## 2026-10-26 — Schémas partagés écrits avec `zod/mini`

Contexte. `packages/shared` est importé par le navigateur. Zod dans sa forme classique ajoute environ 90 kB gzip au bundle dès qu'un seul schéma est importé.

Décision. Les schémas de `packages/shared` utilisent `zod/mini` (API fonctionnelle, arborescente). Le coût dans le bundle tombe à environ 9 kB gzip pour le paquet entier. Les services serveur peuvent utiliser la forme classique pour leurs schémas internes.

Alternatives écartées. Zod classique partout : poids du bundle. Validation manuelle côté client : contraire à la règle de validation aux frontières.

## 2026-10-26 — Bibliothèques complétant la pile

- Internationalisation : `i18next`, `react-i18next`, `i18next-browser-languagedetector`. Bibliothèques les plus maintenues de l'écosystème React ; catalogues typés à partir du français, langue de référence.
- Métriques Prometheus : `prom-client`, un registre par service.
- Client Valkey : `ioredis` 5, déjà requis par l'extension Redis de Hocuspocus et compatible avec BullMQ.
- Client PostgreSQL : `postgres` (postgres.js), pilote recommandé par Drizzle, sans dépendance native.

## 2026-10-26 — Versions d'outillage

- TypeScript 6.0 et non 7.0 : `typescript-eslint` 8 ne prend pas encore en charge TypeScript 7 (pair `<6.1.0`).
- Playwright 1.63 : version dont les navigateurs sont préinstallés dans l'environnement de développement ; la CI installe Chromium elle-même.

## 2026-10-26 — Démarrage et exploitation des services

- Les migrations sont appliquées par `api` au démarrage, sous verrou consultatif PostgreSQL : plusieurs instances peuvent démarrer simultanément sans migrer deux fois.
- Le bucket S3 est créé par `api` au démarrage s'il n'existe pas, plutôt que par un conteneur d'initialisation.
- Chaque service expose `live` (processus vivant) et `ready` (dépendances joignables) ; le contrôle de santé Docker utilise `ready`.
- `collab` refuse toute authentification WebSocket tant que le contrôle d'accès (J5) n'existe pas : le service échoue fermé.
- Les conteneurs Node utilisent l'init de Docker (`init: true`, tini) pour relayer `SIGTERM`, plutôt qu'un paquet installé dans l'image.
- Les images de production sont produites par une installation `--prod` hors ligne à partir du lockfile, en conservant l'arborescence du monorepo. `pnpm deploy` a été écarté : sans injection des paquets du workspace, il résout les dépendances hors lockfile.

## 2026-10-26 — Routage de l'interface

TanStack Router est utilisé en routes déclarées dans le code, sans génération de fichier. Le passage au routage par fichiers sera réévalué quand l'arborescence des routes grandira (J1, J2).

## 2026-10-26 — Validation des requêtes sans `fastify-type-provider-zod` (J1)

Contexte. Le plan du J1 prévoyait `fastify-type-provider-zod`. Ce fournisseur suppose les schémas Zod classiques, alors que `packages/shared` est écrit en `zod/mini` pour le poids du bundle.

Décision. Chaque route valide ses entrées par une aide `parse(schema, valeur)` (`apps/api/src/http/validate.ts`) qui lève une erreur `VALIDATION_FAILED` portant une clé i18n par champ. Aucune route ne lit un corps, une requête ou un paramètre non validé.

Alternatives écartées. Dupliquer les schémas en Zod classique côté serveur : deux sources de vérité. Schémas JSON de Fastify : pas de types partagés avec le client.

## 2026-10-26 — Fichiers texte et binaires, empreintes (J1)

- Un fichier est texte si son extension est connue, s'il est en UTF-8 valide sans octet nul et s'il pèse au plus 4 Mio. Sinon il est binaire. Un fichier texte dans un autre encodage (Latin-1) reste binaire avec un avertissement : le convertir changerait son empreinte.
- Le contenu texte est décodé avec `ignoreBOM`, ce qui conserve la marque d'ordre, les CRLF et l'absence de saut de ligne final : l'aller-retour Yjs restitue les octets exacts.
- Les binaires sont adressés par SHA-256 sous `blobs/<empreinte>`. Une ligne `blobs` n'est écrite qu'après l'objet : une ligne garantit l'objet, un objet sans ligne n'est qu'un déchet ramassé au J6.
- `materializeProject` stocke aussi le contenu texte en blobs, pour produire le manifeste `{chemin: empreinte}` de `SPEC.md` §6.2. L'export, puis la compilation et l'historique, lisent tous ce manifeste.

## 2026-10-26 — Sessions, CSRF et limitation de débit (J1)

- Session côté serveur, jeton de 256 bits dans le cookie `__Host-galley_session`, seule son empreinte est en base. Expiration glissante, prolongée au plus une fois par heure pour éviter une écriture par requête.
- CSRF : jeton par session exigé dans `X-CSRF-Token` sur toute requête modifiante, plus une vérification de l'en-tête `Origin` quand il est présent.
- La connexion est limitée à 10 tentatives par minute et par couple (adresse, identifiant) ; l'inscription et l'installation à 10 par minute et par adresse. Compter par adresse seule bloquait une salle entière derrière un même NAT. Compteurs dans Valkey.
- Premier administrateur : code d'installation à usage unique, partagé entre instances par Valkey, affiché dans les journaux tant qu'aucun compte n'existe.

## 2026-10-26 — Fichiers des utilisateurs servis sur l'origine de l'application (J1)

Contexte. Les fichiers d'un projet sont servis par `/api/projects/:id/files/:fileId/content`, donc sur la même origine que l'application. Un fichier HTML ou SVG déposé pourrait s'y exécuter comme une page.

Décision. Seuls les images matricielles, les PDF et les types `text/*` sont servis en ligne, avec une CSP `sandbox; default-src 'none'` (sans `sandbox` pour les PDF, que les visionneuses n'affichent pas sous ce régime mais qui n'exécutent pas de script de page). Tout le reste est téléchargé. Caddy pose sa CSP avec l'opérateur `?`, qui laisse en place celle, plus stricte, de l'API.

Alternative écartée. Un domaine distinct pour les contenus : plus sûr encore, mais impose une seconde configuration DNS et TLS. À réévaluer au J10 pour l'hébergement public.

## 2026-10-26 — Interface du J1

- Zustand pour l'état d'interface (filtres et sélection du tableau de bord, état de l'arborescence, avertissements d'import) ; TanStack Query pour les données serveur.
- Routage toujours déclaré dans le code : sept routes, la génération de fichiers n'apporte rien encore.
- Modèles intégrés (vide, article) définis dans `apps/api/src/projects/templates.ts` plutôt que dans un dossier `templates/` : deux fichiers ne justifient pas une copie de plus dans l'image.

## 2026-10-26 — Archive de référence des tests d'import (J1)

L'export Prism réel fourni par Maxime reste privé et n'est pas versionné, le dépôt étant public. La CI utilise `fixtures/archives/reference-report.zip`, produite de façon déterministe par `build_reference.py` au même format (entrées de dossiers explicites, modes Unix, classe locale, figures PNG et PDF, `.bib`, fichiers CRLF, BOM, sans saut de ligne final et Latin-1). Le test d'intégration rejoue l'aller-retour sur une archive privée désignée par `GALLEY_PRIVATE_ARCHIVE` quand elle est fournie.

## 2026-10-26 — Accès de collab à PostgreSQL, paquet `packages/db` (J2)

Contexte. `collab` doit authentifier chaque connexion par le cookie de session et persister les états Yjs (SPEC §6.2).

Décision. Le schéma Drizzle, le client, la consultation des sessions et les migrations quittent `apps/api` pour `packages/db`, partagé par `api` et `collab`. Seule l'API applique les migrations au démarrage ; `collab` attend que l'API soit saine dans `compose.yaml`.

Alternative écartée. Un `collab` sans base, passant par des routes internes de l'API : deux allers-retours par connexion et une dépendance circulaire, l'API devant aussi demander à `collab` l'état vivant des documents.

## 2026-10-26 — Écritures de l'API dans les documents ouverts (J2)

L'API ne réécrit plus jamais l'état d'un document existant. Le remplacement d'un fichier texte, la recherche-remplacement et la suppression passent par trois routes internes de `collab` (`flush`, `replace`, `close`), protégées par `COLLAB_INTERNAL_TOKEN` et jamais relayées par Caddy, qui ne transmet à `collab` que les mises à niveau WebSocket. Le remplacement applique un différentiel préfixe-suffixe pour préserver les curseurs hors de la zone modifiée. Quand `collab` est injoignable, personne ne peut éditer : l'API lit et écrit alors directement l'état stocké.

## 2026-10-26 — Grammaire LaTeX de l'éditeur (J2)

Contexte. Le plan prévoyait d'évaluer `codemirror-lang-latex` 0.6.1 (grammaire Lezer, repli, complétion, linter).

Décision. Paquet écarté : son README indique qu'il est dérivé de la grammaire Lezer d'Overleaf. Même sous licence compatible (AGPL-3.0-or-later), l'intégrer reviendrait à reprendre du code d'Overleaf, ce que `CLAUDE.md` interdit. L'éditeur utilise le mode `stex` de `@codemirror/legacy-modes` (MIT) pour la coloration, un service de repli maison (`apps/web/src/editor/folding.ts`) pour les environnements et les sections, et un mode BibTeX maison.

Conséquence. Pas d'arbre syntaxique LaTeX côté client : le plan, les labels et les définitions viennent de `packages/latex-index`, côté serveur. Une grammaire Lezer propre au projet pourra remplacer `stex` plus tard sans toucher au reste.

## 2026-10-26 — Recherche par expressions régulières côté serveur (J2)

Les expressions régulières saisies par l'utilisateur s'exécutent dans l'API. Le moteur `RegExp` de JavaScript peut y prendre un temps exponentiel (`(a+)+$`) et bloquer le processus. La recherche utilise `re2js` 2.8.6, portage JavaScript pur de RE2 en temps linéaire, sans module natif. Les références arrière ne sont pas prises en charge ; une expression invalide renvoie `INVALID_PATTERN`.

## 2026-10-26 — Poids du module d'édition (J2)

Le module chargé à l'ouverture d'un projet (CodeMirror 6, Yjs, `y-codemirror.next`, client Hocuspocus) pèse environ 165 kB gzip, au-delà du seuil de 100 kB de `CLAUDE.md`. Il est indispensable à l'édition et chargé à la demande (`React.lazy`) : le tableau de bord n'en paie pas le coût, son paquet principal ne grossit que de 6 kB.

## 2026-10-27 — Bac à sable de compilation (J3)

Contexte. SPEC §6.3 impose une compilation sans réseau, sans privilèges, avec limites de temps, de mémoire, de disque et de processus et un environnement vidé. La spec préfère bubblewrap à un conteneur par compilation.

Décision. Chaque compilation tourne sous `bwrap` (paquet Debian `bubblewrap`) dans le conteneur `compiler`, par un utilisateur non privilégié : nouveaux espaces de noms (réseau compris), environnement vidé, vue minimale du système de fichiers, limites `RLIMIT_AS`, `RLIMIT_NPROC`, `RLIMIT_FSIZE`, durée murale et taille de `/out` surveillée. Pour que `bwrap` crée ses espaces de noms sous Docker, le conteneur reçoit `infra/compiler/seccomp.json` (profil par défaut de Moby, Apache-2.0, augmenté d'une règle sans condition de capacité pour `unshare`, `clone` (drapeaux d'espaces de noms compris), `mount`, `umount2`, `pivot_root` et `setns`) et `systempaths=unconfined`. Il garde `cap_drop: [ALL]`, `no-new-privileges` et une racine en lecture seule. Au démarrage, le worker vérifie le bac à sable (`checkSandbox`) et refuse de démarrer s'il ne fonctionne pas, plutôt que d'échouer à chaque compilation.

Alternatives écartées. Conteneur éphémère par compilation via un proxy de socket Docker : 300 à 800 ms de plus par compilation, contraire à l'objectif de recompilation à chaud, et accès du worker au démon Docker. gVisor ou Firecracker : dépendance de l'hôte, hors de portée d'une instance installée par `docker compose up`.

## 2026-10-27 — Image du worker de compilation (J3)

L'image part de `texlive/texlive:latest-full`, épinglée par empreinte (TeX Live 2026, publiée le 2026-10-25) : le millésime ne change que par une modification volontaire du `Dockerfile` (procédure dans `docs/operations.md`). Node.js 22 y est copié depuis l'image officielle `node:22` sur base Debian, de même glibc, plutôt qu'installé par un dépôt tiers. Le cache de polices de LuaLaTeX est construit à la construction de l'image. L'image dépasse 7 Gio : la CI ne la met pas en cache (limite de 10 Gio par dépôt).

## 2026-10-27 — Analyse des journaux LaTeX (J3)

`packages/latex-log` est écrit pour le projet. Les analyseurs existants sont soit liés à Overleaf (`latex-log-parser`, code d'Overleaf, interdit par `CLAUDE.md`), soit abandonnés et sans prise en charge de `-file-line-error`, de Biber ni de latexmk. Le module est pur et testé sur des journaux réels capturés dans l'image du worker (`src/__fixtures__/`).

## 2026-10-27 — Visionneuse PDF et marqueurs d'erreurs (J3)

- `pdfjs-dist` 6.4 (Apache-2.0), composant `PDFViewer` de pdf.js : rendu, couche de texte, liens, zoom. Le module de la visionneuse pèse environ 179 kB gzip et le worker pdf.js 376 kB gzip, au-delà du seuil de 100 kB. Aucune alternative maintenue n'affiche un PDF sans pdf.js ; les deux sont chargés à la demande avec le premier PDF, le reste de l'interface n'en paie pas le coût.
- `@codemirror/lint` 6.9 (MIT, quelques kB) pour les marqueurs de gouttière, alimentés par la dernière compilation et non par un linter du client.

## 2026-10-27 — Rétention des compilations (J3)

Le plan prévoyait de garder les trois dernières compilations réussies. Sont gardées en fait les trois dernières compilations terminées, quel que soit leur résultat, plus la dernière qui a produit un PDF si elle est plus ancienne : un projet en erreur garde ainsi son journal récent et l'interface continue d'afficher le dernier PDF. Le reste est supprimé du stockage et de la base à chaque fin de compilation.

## 2026-10-27 — Modèle « vide » (J3)

Un document sans contenu ne produit aucun PDF (« No pages of output »). Le modèle vide contient donc une ligne de texte, pour qu'un projet neuf compile dès son ouverture.
