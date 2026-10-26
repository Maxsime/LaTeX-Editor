# Galley

Éditeur LaTeX collaboratif, auto-hébergé, avec assistant IA intégré. Le cahier des charges est dans [`SPEC.md`](SPEC.md), les consignes de développement dans [`CLAUDE.md`](CLAUDE.md).

État : jalon J1 (comptes, projets, fichiers). On crée un compte, on gère ses projets, on importe un projet Overleaf ou Prism en zip, on organise ses fichiers et on réexporte le projet à l'identique. L'éditeur et la compilation arrivent aux jalons suivants (`SPEC.md` §9).

## Démarrer une instance

Prérequis : Docker avec Compose v2.

```sh
docker compose up --build
```

L'instance est servie sur <https://localhost>. Aucune configuration n'est nécessaire : `compose.yaml` fournit des valeurs par défaut pour un usage local. Pour les modifier, copier `.env.example` vers `.env`. Avant toute exposition sur un réseau, changer chaque mot de passe et secret.

### Faire confiance au certificat local

Caddy signe le certificat de `localhost` avec sa propre autorité de certification. Tant qu'elle n'est pas installée, le navigateur affiche un avertissement. Pour l'installer :

```sh
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt galley-root.crt
```

Importer ensuite `galley-root.crt` comme autorité de confiance : trousseau Système sous macOS, `certutil` ou les paramètres du navigateur sous Linux, magasin « Autorités de certification racines de confiance » sous Windows. Le certificat est conservé dans le volume `caddy-data` et reste valable entre deux redémarrages.

### Créer le compte administrateur

Au premier démarrage, aucun compte n'existe. L'API écrit alors dans ses journaux un code d'installation à usage unique :

```sh
docker compose logs api | grep setupCode
```

Ouvrir <https://localhost>, qui redirige vers la page « Créer le compte administrateur », et saisir ce code. Il empêche un inconnu de s'approprier une instance fraîchement exposée. Le code reste valable jusqu'à la création du compte, et il est réaffiché à chaque redémarrage tant qu'aucun compte n'existe.

### Comptes et invitations

Le mode d'inscription se règle par `REGISTRATION_MODE` :

| Valeur            | Effet                                         |
| ----------------- | --------------------------------------------- |
| `invite` (défaut) | inscription uniquement par lien d'invitation  |
| `open`            | inscription libre                             |
| `closed`          | comptes créés uniquement par l'administrateur |

Les opérations d'administration passent par une commande exécutée dans le conteneur de l'API :

```sh
# Lien d'invitation valable 7 jours (1 à 90)
docker compose exec api node dist/cli/admin.js create-invite --days 7
# Compte créé directement, mot de passe temporaire affiché
docker compose exec api node dist/cli/admin.js create-user --email ada@example.org --username ada --name "Ada Lovelace" [--admin]
# Mot de passe oublié : nouveau mot de passe temporaire, toutes les sessions sont fermées
docker compose exec api node dist/cli/admin.js reset-password ada
```

Le lien d'invitation affiché est relatif : le préfixer par l'adresse de l'instance (`https://localhost/register?invite=…`). Les administrateurs peuvent aussi créer des invitations par l'API (`POST /api/admin/invites`). En développement, la même commande s'utilise avec `pnpm --filter @galley/api admin <commande>`.

### Importer un projet existant

Le bouton « Importer un zip » du tableau de bord accepte l'export d'un projet Overleaf ou Prism, ou n'importe quel dossier compressé. Aucune organisation n'est imposée : le document principal est le fichier `.tex` racine qui déclare `\documentclass`, et il se change depuis la page du projet. Les fichiers texte en UTF-8 sont stockés comme documents texte, éditables dès que l'éditeur arrivera (J2) ; les autres (images, PDF, fichiers texte dans un autre encodage) sont conservés octet pour octet. L'export redonne exactement les mêmes fichiers.

Limites d'une archive : 5 000 entrées, 500 Mio décompressés, 100 Mio par fichier, 32 niveaux de dossiers. Les archives contenant des chemins sortant du projet, des liens symboliques ou un taux de compression anormal sont refusées en entier.

### Vérifier l'état des services

```sh
scripts/compose-healthy.sh
```

Le script démarre la pile et échoue si un service n'atteint pas l'état sain. La page « État des services » (lien en pied de page, `/status`) affiche aussi l'état de la base de données, de la file et du stockage.

## Développer

Prérequis : Node.js 22 (voir `.nvmrc`), pnpm 10 (`corepack enable` ou `npm i -g pnpm@10`), Docker.

```sh
pnpm install
cp .env.example .env
docker compose -f compose.dev.yml up -d   # PostgreSQL, Valkey, SeaweedFS sur localhost
pnpm dev                                  # services et interface en mode watch
```

L'interface de développement est servie par Vite sur <http://localhost:5173>, qui relaie `/api` vers l'API locale.

| Commande         | Rôle                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------ |
| `pnpm lint`      | ESLint sur chaque paquet, puis vérification Prettier                                 |
| `pnpm typecheck` | Vérification des types                                                               |
| `pnpm format`    | Formatage Prettier                                                                   |
| `pnpm test`      | Tests Vitest ; les tests d'intégration démarrent leurs conteneurs via Testcontainers |
| `pnpm test:e2e`  | Tests Playwright contre la pile Compose démarrée                                     |
| `pnpm build`     | Construction de tous les paquets                                                     |

Les tests d'intégration sont ignorés en local si Docker est absent, et obligatoires en CI.

### Construire derrière un proxy d'inspection TLS

Sur un réseau d'entreprise ou d'école qui intercepte le TLS, la construction des images échoue faute de connaître l'autorité du proxy. Les Dockerfiles acceptent un secret de construction facultatif `extra_ca_cert` :

```sh
docker buildx build --secret id=extra_ca_cert,src=/chemin/vers/ca.pem \
  -f infra/docker/node-service.Dockerfile --build-arg SERVICE=api -t galley/api:dev .
```

## Organisation du dépôt

```
apps/web        SPA React servie par Caddy
apps/api        API HTTP Fastify
apps/collab     serveur Hocuspocus (Yjs)
apps/compiler   worker de compilation (BullMQ)
packages/shared schémas, configuration, journalisation partagés
fixtures/       archives de référence pour les tests
e2e/            tests Playwright
infra/          Dockerfiles et configuration de Caddy
scripts/        scripts d'exploitation
docs/           plans de jalons, décisions, architecture
```

Documentation : [`docs/architecture.md`](docs/architecture.md), [`docs/decisions.md`](docs/decisions.md), plans de jalons dans [`docs/plans/`](docs/plans/).

## Licence

[AGPL-3.0](LICENSE). Toute instance modifiée et mise à disposition d'utilisateurs doit leur donner accès à son code source ; l'interface affiche pour cela un lien vers le dépôt, configurable par `VITE_SOURCE_URL` à la construction.
