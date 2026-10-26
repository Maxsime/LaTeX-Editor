# Architecture d'exécution

Référence fonctionnelle : `SPEC.md` §5. Ce document décrit l'état effectivement déployé.

## Services

| Service    | Image                         | Port interne | Réseaux    | Santé                                   |
| ---------- | ----------------------------- | ------------ | ---------- | --------------------------------------- |
| `caddy`    | `galley/caddy` (SPA incluse)  | 80, 443      | edge       | `http://:2019/healthz`                  |
| `api`      | `galley/api`                  | 3000         | edge, data | `/api/health/live`, `/api/health/ready` |
| `collab`   | `galley/collab`               | 3001         | edge, data | `/health/live`, `/health/ready`         |
| `compiler` | `galley/compiler`             | 3002         | data       | `/health/live`, `/health/ready`         |
| `postgres` | `postgres:16.15-alpine`       | 5432         | data       | `pg_isready`                            |
| `valkey`   | `valkey/valkey:8.1.10-alpine` | 6379         | data       | `valkey-cli ping`                       |
| `storage`  | `chrislusf/seaweedfs:4.50`    | 8333 (S3)    | data       | `/healthz`                              |

Le réseau `data` est interne : il n'a pas d'accès sortant et Caddy n'y est pas relié. Seuls les ports 80 et 443 de Caddy sont publiés sur l'hôte.

## Routage par Caddy

- `/api/*` vers `api:3000`, avec un en-tête `X-Request-Id` généré par Caddy et repris dans les logs de l'API.
- `/collab` vers `collab:3001`, uniquement pour les requêtes de mise à niveau WebSocket. Les points de santé et les métriques de `collab` ne sont pas exposés.
- Tout le reste : fichiers statiques de la SPA, avec repli sur `index.html`.
- `/metrics` n'est exposé par aucun service à travers Caddy : les métriques se collectent sur le réseau interne.

En-têtes de sécurité posés par Caddy : CSP stricte (`default-src 'self'`, aucun script ni style en ligne), HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`.

## Ordre de démarrage

Les dépendances déclarées dans `compose.yaml` attendent l'état sain : `postgres`, `valkey` et `storage`, puis `api`, `collab` et `compiler`, puis `caddy`. Au démarrage, `api` applique les migrations et crée le bucket S3 s'il manque.

## Configuration

Chaque service valide son environnement au démarrage avec un schéma Zod (`packages/shared/src/env.ts`) et s'arrête en listant les variables fautives, sans jamais afficher leur valeur. Les valeurs par défaut de `compose.yaml` suffisent pour une instance locale ; `.env.example` documente chaque variable.
