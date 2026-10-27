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

## 2026-10-27 — AppArmor et bac à sable de compilation (J3)

Contexte. Sur un hôte qui applique AppArmor (Ubuntu, dont le runner de la CI), le profil `docker-default` interdit tout montage dans le conteneur. `bwrap` ne peut alors pas préparer son système de fichiers (« Failed to make / slave: Permission denied ») et le worker refuse de démarrer. Docker Desktop n'est pas concerné.

Décision (Maxime, 2026-10-27). Le seul conteneur `compiler` tourne avec `apparmor=unconfined`. Le confinement des compilations reste assuré par `bwrap` (espaces de noms, réseau coupé, vue minimale du système de fichiers, limites), le conteneur gardant `cap_drop: [ALL]`, `no-new-privileges`, le profil seccomp restreint et une racine en lecture seule. Les autres services gardent le profil par défaut.

Alternatives écartées. Profil AppArmor dédié : plus strict, mais à charger sur l'hôte par l'administrateur (`apparmor_parser`), ce qui casse l'installation par `docker compose up` seul. Conteneur éphémère par compilation : 300 à 800 ms de plus par compilation et accès du worker au démon Docker (voir l'entrée sur le bac à sable).

## 2026-10-27 — SyncTeX (J4)

Contexte. SPEC §3.3 et §6.5 : aller du PDF au source et inversement, en moins de 200 ms par requête.

Décision. Le binaire `synctex` de TeX Live répond aux requêtes, dans le worker, sous le même `bwrap` que la compilation (le fichier `.synctex.gz` vient d'un document non fiable), avec le seul cache de la compilation monté en lecture seule. Il interroge le `.synctex.gz` publié par la compilation dont le PDF est affiché, téléchargé au premier appel et gardé dans un cache local (32 compilations). L'API transmet les requêtes par une file BullMQ `synctex` (sans nouvelle tentative, résultat attendu 5 s), traitée par un `Worker` distinct à concurrence 4 pour qu'une compilation longue ne bloque pas la navigation. Médiane mesurée sur le corpus : 7 ms.

Alternatives écartées. Analyseur SyncTeX en TypeScript (`synctex-js` et équivalents) : format et algorithme de recherche à réimplémenter, moins fiable que la référence utilisée par tous les éditeurs. Route HTTP interne vers le worker : un secret partagé de plus, et un routage à prévoir avec plusieurs workers alors que la file le fait déjà.

## 2026-10-27 — Analyse des fichiers BibTeX (J4)

`@retorquere/bibtex-parser` 12.1.3 (ISC, moteur de Better BibTeX pour Zotero), épinglé, côté API seulement : tolérant aux fichiers réels (chaînes, commentaires, entrées malformées), il convertit les commandes LaTeX des champs en texte. L'API en tire clé, type, titre, auteurs et année pour `GET /api/projects/:id/index` ; le client ne charge rien de plus. Le J8 (bibliographie) réutilisera le même analyseur. Alternative écartée : un analyseur propre, à maintenir pour un format plein de cas particuliers.

## 2026-10-27 — Diagnostics sans compilation (J4)

`lintDocument` (`packages/latex-index`) signale les environnements mal appariés, les labels définis plusieurs fois, les références et citations inconnues. Il tourne dans le navigateur 400 ms après la dernière frappe, sur le fichier ouvert, avec les labels et clés des autres fichiers venus de l'index. CodeMirror n'accepte qu'une source de diagnostics : un seul linter fusionne ceux-ci avec les marqueurs de la dernière compilation, gardés dans un champ d'état qui suit les modifications du texte. Les fichiers `.sty` et `.cls` ne sont pas vérifiés en direct (environnements définis en morceaux). Le module de l'éditeur passe de 165 à 175 kB gzip.

## 2026-10-27 — Nonce de style dans la CSP

Contexte. La CSP servie par Caddy (`style-src 'self'`) refusait l'élément `<style>` que CodeMirror insère pour son thème, ainsi que celui du verrouillage du défilement des boîtes de dialogue (Radix). Dans l'instance Docker, l'éditeur s'affichait sans style depuis le J2 ; le serveur de développement n'envoie pas de CSP, d'où l'absence de symptôme en local.

Décision. Caddy ajoute à `style-src` un nonce propre à chaque réponse (`{http.request.uuid}`) et l'écrit dans une balise `<meta name="csp-nonce">` de `index.html` (directive `templates`). Le client le transmet à CodeMirror (`EditorView.cspNonce`) et à `get-nonce` 1.0.1 (MIT, quelques lignes), lu par la bibliothèque de Radix. `index.html` n'est plus mis en cache (`no-store`) ; les ressources à empreinte le restent. Un test e2e échoue sur toute violation de CSP signalée par le navigateur.

Alternative écartée. `style-src 'unsafe-inline'` : plus simple, mais rouvre l'injection de styles que la politique ferme.

## 2026-10-27 — Partage et révocation (J5)

Invitations nominatives réservées aux comptes existants : sans SMTP, une invitation par adresse inconnue donnerait le projet à quiconque créerait un compte avec cette adresse, les adresses n'étant pas vérifiées. Le tableau de bord sert de boîte de réception ; le lien de partage couvre le cas d'une personne sans compte. Les jetons de lien sont stockés sous forme d'empreinte, comme les invitations d'inscription.

Révocation immédiate par fermeture de la WebSocket entière de l'utilisateur concerné, et non du seul document (`Connection.close` de Hocuspocus) : un document fermé seul n'est jamais réautorisé par le client, qui resterait sans événements ni droits à jour. Alternative écartée : vérifier le rôle à chaque message, coûteux et redondant avec l'autorisation à la connexion.

Identité de présence imposée par le serveur (`beforeHandleAwareness`) plutôt que validée : le client n'a aucune raison légitime d'annoncer une autre identité que la sienne.

## 2026-10-27 — Historique (J6)

Instantanés stockés comme manifestes (chemin vers empreinte de blob) dans PostgreSQL : les contenus sont déjà dans le stockage par adressage de contenu, un instantané ne coûte que sa liste. Les auteurs viennent d'une table `project_activity` remplie par `collab` (connexions ayant modifié un document) et par l'API (arborescence, remplacement, push), vidée à chaque instantané. Un balayage chaque minute (file de maintenance BullMQ) prend un instantané des projets actifs dont le dernier date de plus de 5 min ; une compilation réussie en prend un aussi. Les instantanés d'un projet sont sérialisés par un verrou Valkey.

Restaurer un fichier ou tout le projet enregistre d'abord l'état remplacé, puis applique la cible en une transaction sur l'arborescence ; les textes ouverts sont remplacés par `collab`, donc visibles aussitôt dans les éditeurs. Rien n'est jamais supprimé de l'historique par une restauration.

Comparaison dans le navigateur avec `diff` (jsdiff) 9.0.0 (BSD-3-Clause, environ 10 kB gzip, chargé avec le panneau). Alternative écartée : différentiel calculé par l'API, plus de charge serveur pour un affichage seulement.

## 2026-10-27 — Pont Git (J6)

Contexte. SPEC §4 prévoit Git natif servi en smart HTTP par `git http-backend`. Dans Alpine, `http-backend` est dans le paquet `git-daemon`, avec le démon et ses scripts de service.

Décision. L'API lance directement `git upload-pack` et `git receive-pack` en mode `--stateless-rpc` (avec `--http-backend-info-refs` pour l'annonce des références), exactement ce que fait `http-backend`, sans couche CGI. Seul le paquet `git` est installé. Le corps des requêtes est transmis en flux, décompressé si besoin, et borné avant et après décompression.

- Authentification HTTP Basic, mot de passe = jeton d'accès personnel (`glp_` + 32 octets aléatoires, seule l'empreinte SHA-256 est stockée). Lecture pour tout membre, écriture pour éditeur et propriétaire. 30 échecs d'authentification par adresse et par quart d'heure, au-delà de quoi les requêtes sont refusées.
- Un dépôt nu par projet dans le volume `git-data`, branche `main`. À chaque annonce de références, si les fichiers du projet diffèrent du dernier commit servi, l'API crée un commit (plomberie : `hash-object`, `mktree`, `commit-tree`), avec les auteurs des instantanés de la période. Les identifiants d'objets Git sont gardés par empreinte de blob pour ne pas réhacher les fichiers inchangés.
- Push : crochet `pre-receive` (`apps/api/hooks/pre-receive.mjs`) qui transmet les mises à jour à une route interne de l'API, authentifiée par un secret propre à chaque push. L'API lit l'arbre poussé dans le répertoire de quarantaine de Git (vérifié comme étant dans le dépôt), refuse autre chose que `main`, les liens symboliques, les sous-modules, les chemins invalides, les fichiers et pushs trop gros, puis applique l'arbre comme une restauration et prend un instantané `git`. Un push qui ne part pas du dernier commit servi, ou alors que le projet a changé, est refusé en entier : l'utilisateur fait `git pull`, Git fusionne chez lui.
- Git ne connaît pas les dossiers vides : ceux du projet sont conservés par un push.
- Messages de refus en français, ou en anglais si le client Git annonce l'anglais (`Accept-Language`, déduit de `LANG`).

Alternatives écartées. `http-backend` avec `git-daemon` : un paquet et une couche CGI de plus pour le même résultat. Bibliothèque Git en JavaScript (isomorphic-git) : protocole serveur incomplet, moins éprouvée que Git. Fusion côté serveur des pushs en retard : conflits impossibles à présenter à l'utilisateur pendant un push.

## 2026-10-27 — Suggestions et commentaires (J7)

Contexte. SPEC §6.6 place suggestions et ancres de commentaires dans le document Yjs du fichier. Le plan J7 prévoyait de les repérer par positions relatives (`Y.RelativePosition`) et de garder le texte supprimé avec une ancre. Les tests de propriétés ont montré deux défauts de ce modèle : deux personnes qui suppriment le même caractère en même temps le rendent deux fois au texte accepté, et un texte tapé par un éditeur au milieu d'une suppression suggérée se retrouve déplacé.

Décision.

- Une suggestion nomme les éléments Yjs qu'elle concerne, par plages `[client, horloge, longueur]` (insertion) ou `[client, horloge, texte]` (suppression), dans un `Y.Map` `ranges` à côté du `Y.Text` `content`. Un élément supprimé garde sa place dans la séquence Yjs : le texte accepté est obtenu en parcourant la séquence, éléments supprimés compris, sans les caractères insérés par suggestion et avec les caractères supprimés par suggestion. Un caractère réclamé par deux suppressions n'apparaît qu'une fois ; un texte tapé au milieu reste au milieu.
- Le contenu des éléments supprimés est ramassé par Yjs, d'où le texte gardé dans l'entrée de suppression. Rejeter une suppression réinsère le texte ; comme Yjs insère après tous les éléments supprimés d'une même position, les autres suppressions suggérées à cette position sont réécrites dans l'ordre puis supprimées de nouveau, et leurs entrées repointées.
- Les ancres de commentaires gardent des positions relatives : un commentaire porte sur une étendue, pas sur des caractères précis.
- Noyau pur dans `packages/review` (dépendance : `yjs`, en dépendance directe à la même version exacte que les services, pour que l'installation de production la résolve ; pnpm n'en garde qu'un exemplaire). Tests de propriétés avec `fast-check` 4.10.2 (MIT, outil de test seulement) : suggestions seules, rejets un à un dans un ordre quelconque, édition concurrente d'un éditeur et d'un relecteur, deux relecteurs concurrents.

Contrôle serveur. `collab` ouvre en écriture les connexions des relecteurs et applique chacune de leurs mises à jour (`beforeSync`, étape 2 et mises à jour) à une copie du document avant Hocuspocus. Elle est refusée, et la connexion du document fermée avec la raison `invalid-update`, si le texte accepté change, si une entrée d'un autre est créée, modifiée ou supprimée, si un autre type racine que `content` et `ranges` apparaît, si des attributs sont posés sur le texte, ou si la mise à jour laisse des changements en attente d'historique manquant (sans quoi la mise à jour suivante d'un éditeur les appliquerait sans contrôle). Le client recharge alors le document depuis le serveur et prévient. Les éditeurs ne sont pas filtrés : ils peuvent de toute façon modifier directement.

Alternatives écartées. Positions relatives pour les suggestions (défauts ci-dessus). Validation de la forme des opérations Yjs plutôt que d'un invariant : règles nombreuses et contournables, là où l'invariant « texte accepté inchangé, entrées d'autrui intactes » couvre toute mise à jour forgée. Suggestions en base de données : elles ne suivraient pas les éditions concurrentes.

Mentions : `@identifiant` d'un membre du projet, enregistrées à la création et à la modification d'un commentaire, visibles sur le tableau de bord jusqu'à l'ouverture du fil. Notifications par e-mail reportées (SMTP facultatif, J10 au plus tôt). Discussion : 4 000 caractères par message, 30 messages par minute et par personne (limite comptée par compte, après authentification).

## 2026-10-27 — Bibliographie et qualité rédactionnelle (J8)

LanguageTool. Serveur auto-hébergé, image `erikvl87/languagetool:6.8` (LGPL-2.1, sans modification) épinglée par empreinte, sur le réseau interne `data` seulement : aucun texte ne quitte l'instance. Le client convertit le LaTeX au format « annotation » de LanguageTool (`toAnnotation`, `packages/latex-index`) : segments de texte et de balisage dont la concaténation redonne le source, si bien que les positions rendues sont celles du source. Le texte est envoyé par paragraphes, mis en cache côté client (seuls les paragraphes modifiés repartent), par lots de 20 000 caractères au plus. Règles purement typographiques désactivées (espaces, apostrophes, guillemets) : LaTeX les gère. Alternatives écartées : Hunspell dans le navigateur (orthographe seule, pas de grammaire, dictionnaires lourds à charger) ; vérification côté serveur du document entier à chaque frappe (coût inutile, positions à recalculer).

Dans l'éditeur, le correcteur est un second linter CodeMirror. `@codemirror/lint` 6.9 accepte plusieurs sources de diagnostics ; la note du J4 sur une source unique ne vaut plus, mais la fusion compilation plus vérifications LaTeX est gardée telle quelle.

`fast-xml-parser` 5.11.2 (MIT), côté API, pour les réponses Atom d'arXiv : entités désactivées (`processEntities: false`), réponse validée par Zod. Alternative écartée : analyse par expressions régulières, fragile sur un format XML réel.

Imports réseau. Hôtes fixes et configurables par l'administrateur seulement, identifiants validés puis encodés : aucune URL fournie par l'utilisateur n'est appelée. Délai de 8 s, 2 Mo par réponse, 30 recherches par minute et par personne. Les tests rejouent des réponses enregistrées par un serveur local ; elles ont été reconstituées d'après la documentation et les réponses publiques des services, l'environnement de développement n'ayant pas d'accès sortant (`apps/api/test/fixtures/lookup/README.md`). Une vérification en direct sur une instance reliée à Internet reste à faire.

Clé maître. `GALLEY_MASTER_KEY` (32 octets, base64) chiffre les clés Zotero en AES-256-GCM : version, nonce de 12 octets, étiquette de 16 octets, données associées `zotero:<identifiant utilisateur>` pour qu'un chiffré déplacé vers un autre compte ne se déchiffre pas. Introduite au J8, réutilisée au J9 pour les clés des fournisseurs d'IA. Valeur de développement publique par défaut, signalée au démarrage. Alternative écartée : chiffrement par PostgreSQL (`pgcrypto`), qui ferait transiter la clé dans les requêtes SQL.

chktex et texcount. Lancés à chaque compilation, en parallèle de latexmk, chacun dans son propre bac à sable identique (lecture des sources seulement, 30 s, 8 processus). Pas de nouveau type de tâche, et les remarques correspondent au PDF affiché. Règles désactivées par projet (défaut 1, 8, 13, 36, 44).

Aperçu des formules. KaTeX 0.19.0 (MIT) chargé au premier survol d'une formule : 78 kB gzip de JavaScript et 8 kB de CSS, plus les polices à la demande, hors du module de l'éditeur. Rendu par `katex.render` (styles posés par le CSSOM, permis par la CSP, contrairement à du HTML avec attributs `style`), `trust: false`, expansion de macros bornée. Le repli sur MathJax prévu au plan n'est pas fait : MathJax 4 pèse plusieurs fois KaTeX, et les formules que KaTeX refuse sont surtout des environnements de paquets que MathJax ne connaît pas davantage. KaTeX affiche alors son message d'erreur. À reconsidérer si les utilisateurs le demandent.

Palette et assistants : données et générateurs purs côté client, sans dépendance. L'index du projet expose désormais les corps de macros (`definition`), les clés citées (`cited`) et les paquets chargés (`packages`), pour l'aperçu, le panneau Références et les rappels de paquets.

## 2026-10-27 — Assistant IA (J9)

Fournisseurs. AI SDK 7 (`ai` 7.0.138, Apache-2.0) et ses adaptateurs officiels `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/mistral` et `@ai-sdk/openai-compatible` (Apache-2.0), côté API seulement, dans `packages/ai`. Une même boucle (`streamText`, outils, arrêt à 8 appels) sert tous les fournisseurs ; Anthropic reçoit le prompt et le contexte stable en messages système séparés avec un point de cache, les autres un seul message système (certains modèles locaux confondent plusieurs messages système). La clé est toujours passée explicitement : aucune variable d'environnement de fournisseur n'est lue en douce. Alternatives écartées : SDK propres à chaque fournisseur (quatre boucles d'outils à maintenir), LangChain (dépendances et abstraction bien plus lourdes pour le même besoin).

Propositions plutôt qu'écritures. L'outil `propose_changes` ne modifie rien : il calcule des hunks (texte d'origine, remplacement, position, contexte avant et après) et les garde 24 h dans Valkey, liés à la personne et au projet. À l'acceptation, `collab` relocalise chaque hunk dans le texte courant (`realignHunks`, `packages/shared` : même position, sinon occurrence dont le contexte correspond, sinon occurrence unique, sinon conflit) et l'applique dans une seule transaction Yjs, comme une frappe de la personne qui accepte. Le serveur revérifie les droits et les citations à ce moment-là. Alternatives écartées : écrire directement en mode suggestion (le relecteur ne pourrait pas distinguer l'assistant d'une personne, et le projet changerait sans validation explicite) ; propositions en base (éphémères par nature).

Citations. Une clé citée par une proposition doit exister dans le projet ou provenir d'une entrée récupérée pendant la conversation (`fetch_bibtex`, Crossref, arXiv ou Open Library) ; une entrée `.bib` ajoutée doit être identique, aux espaces près, à une entrée récupérée. Le modèle ne peut donc ni inventer une clé ni rédiger une référence.

Contexte. Résumé du projet calculé par `packages/latex-index` (fichiers, plan, labels, clés, paquets, commandes), fenêtre du fichier ouvert autour du curseur, dernières erreurs, dans un budget de caractères tiré de la fenêtre du modèle (40 % de la fenêtre, 3 caractères par jeton). Le reste se lit par outils.

Historique de conversation côté navigateur. Le serveur ne garde que les propositions et les entrées bibliographiques récupérées (pour le contrôle des citations), 24 h. Pas de table de conversations : moins de données personnelles conservées, et rien à purger.

Adresses des fournisseurs. Un utilisateur ne peut viser que l'adresse officielle de son fournisseur ; une adresse libre (serveur compatible OpenAI) ferait de l'API un relais vers le réseau interne. `AI_ALLOW_USER_ENDPOINTS` lève la restriction pour une instance de confiance. Le modèle d'instance, fixé par l'administrateur, n'est pas concerné.

Prix. Aucun prix préchargé : une table fausse serait pire qu'un coût affiché comme inconnu. Les prix sont saisis par l'administrateur, par modèle et par devise ; la consommation est cumulée par devise.

Interface. Différentiel des propositions calculé par `diff` (déjà chargé pour l'historique) plutôt qu'à la main comme prévu au plan : même résultat, moins de code. Propositions dessinées dans CodeMirror par un `StateField` de décorations relocalisées à chaque modification, avec les mêmes règles que le serveur. La sélection courante est gardée hors du store Zustand : elle change à chaque frappe et ne sert qu'à l'envoi d'une question, et la stocker dans le store faisait refaire le rendu de la page à chaque frappe (test de fluidité de l'éditeur à la limite). Aucune dépendance client ajoutée.

Suite d'évaluation. `packages/ai/src/eval` : quatre scénarios fixes (coquille, tableau, formule, figure TikZ) joués contre un projet en mémoire. En CI, un modèle simulé vérifie que prompts, outils et analyse des réponses restent cohérents ; `pnpm --filter @galley/ai eval` joue les mêmes scénarios contre un modèle réel et compile chaque résultat. Le faux fournisseur (`@galley/ai/testing`) sert aussi aux tests d'intégration de l'API et au test de bout en bout, qui l'importe depuis les sources.
