# Galley

Éditeur LaTeX collaboratif, auto-hébergé, avec assistant IA intégré. Le cahier des charges est dans [`SPEC.md`](SPEC.md), les consignes de développement dans [`CLAUDE.md`](CLAUDE.md).

État : jalon J0 (fondations). L'instance démarre et sert une page d'accueil en HTTPS ; les projets, l'éditeur et la compilation arrivent aux jalons suivants (`SPEC.md` §9).

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

### Vérifier l'état des services

```sh
scripts/compose-healthy.sh
```

Le script démarre la pile et échoue si un service n'atteint pas l'état sain. La page d'accueil affiche aussi l'état de la base de données, de la file et du stockage.

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
e2e/            tests Playwright
infra/          Dockerfiles et configuration de Caddy
scripts/        scripts d'exploitation
docs/           plans de jalons, décisions, architecture
```

Documentation : [`docs/architecture.md`](docs/architecture.md), [`docs/decisions.md`](docs/decisions.md), plans de jalons dans [`docs/plans/`](docs/plans/).

## Licence

[AGPL-3.0](LICENSE). Toute instance modifiée et mise à disposition d'utilisateurs doit leur donner accès à son code source ; l'interface affiche pour cela un lien vers le dépôt, configurable par `VITE_SOURCE_URL` à la construction.
