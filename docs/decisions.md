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
