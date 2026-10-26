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
