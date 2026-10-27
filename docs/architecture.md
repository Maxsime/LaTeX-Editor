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

Les dépendances déclarées dans `compose.yaml` attendent l'état sain : `postgres`, `valkey` et `storage`, puis `api` et `compiler`, puis `collab` (qui lit le schéma migré par l'API), puis `caddy`. Au démarrage, `api` applique les migrations de `packages/db` et crée le bucket S3 s'il manque.

## Configuration

Chaque service valide son environnement au démarrage avec un schéma Zod (`packages/shared/src/env.ts`) et s'arrête en listant les variables fautives, sans jamais afficher leur valeur. Les valeurs par défaut de `compose.yaml` suffisent pour une instance locale ; `.env.example` documente chaque variable.

## Comptes et sessions

L'API tient les sessions en base (`sessions`) et les résout à chaque requête depuis le cookie `__Host-galley_session`. Les routes sous `/api` sont privées par défaut ; seules celles de connexion, d'inscription et d'installation sont publiques. Les requêtes modifiantes exigent l'en-tête `X-CSRF-Token` de la session. Les compteurs de limitation de débit vivent dans Valkey (`galley:rate-limit:*`).

## Projets et fichiers

- L'arborescence est dans `files` (dossiers, fichiers texte, fichiers binaires). Le contenu d'un fichier texte n'existe que dans son état Yjs (`yjs_states`, `Y.Text` nommé `content`) ; celui d'un binaire dans le stockage objet, sous `blobs/<sha256>`.
- Le contrôle d'accès passe par `project_members` à chaque route ; un projet inaccessible répond 404.
- Chaque modification de l'arborescence publie un événement sur le canal Valkey `project:<id>`, que `collab` relaie aux navigateurs (voir « Édition collaborative »).
- Les projets mis à la corbeille depuis plus de 30 jours sont purgés par une tâche BullMQ horaire (file `maintenance`), planifiée par chaque instance de l'API de façon idempotente.

## Import et export

L'import reçoit l'archive dans un dossier temporaire (`API_TMP_DIR`), valide tout le répertoire central avant d'extraire quoi que ce soit, puis extrait chaque entrée en mesurant les octets réels. Les blobs sont envoyés ensuite, et l'arborescence est écrite en une transaction : un refus ou une panne ne laisse aucun projet partiel. L'export passe par `materializeProject` et produit le zip en flux, un blob à la fois.

## Édition collaborative

- Le navigateur ouvre une seule connexion WebSocket par projet (`wss://<hôte>/collab`), multiplexée entre le canal d'événements `project:<id>` et un document `file:<id>` par onglet ouvert.
- `collab` refuse toute mise à niveau dont l'en-tête `Origin` ne correspond pas à l'hôte, puis authentifie chaque document par le cookie de session et le rôle sur le projet. Les rôles `reader` et `reviewer` reçoivent une connexion en lecture seule, appliquée par le serveur.
- Persistance : écriture dans `yjs_states` 2 s après la dernière modification, au plus tard 10 s après la première (`COLLAB_PERSIST_DEBOUNCE_MS`, `COLLAB_PERSIST_MAX_DEBOUNCE_MS`), et immédiatement à la dernière déconnexion. L'écriture met à jour la taille du fichier et la date du projet ; elle est abandonnée si le fichier a été supprimé ou est devenu binaire.
- Routes internes de `collab`, sur son port et protégées par `COLLAB_INTERNAL_TOKEN` : `POST /internal/projects/:id/flush` (écrire maintenant les documents chargés du projet), `POST /internal/documents/:fileId/replace` (remplacer le texte par une connexion serveur), `POST /internal/documents/:fileId/close` (déconnecter et oublier un document supprimé). `materializeProject`, le plan, l'index et la recherche appellent `flush` avant de lire `yjs_states`.
- Avec plusieurs instances de `collab`, l'extension Redis de Hocuspocus synchronise les documents entre elles ; `flush` ne vide que l'instance appelée, ce qui suffit tant qu'une seule instance tourne.
- Présence : chaque client publie dans l'awareness de ses documents un champ `user` (identifiant, nom, couleur) et, sur le canal du projet, l'identifiant du fichier de l'onglet actif. `collab` remplace le champ `user` par l'identité de la session avant toute diffusion (`beforeHandleAwareness`), si bien qu'un client ne peut pas se faire passer pour un autre. La couleur dérive de l'identifiant (`presenceColor`, `packages/shared`).
- Révocation : un changement de rôle, un retrait ou un transfert publie `members.changed` avec l'utilisateur concerné. Chaque instance de `collab` ferme alors la WebSocket de cet utilisateur sur le projet (code 4205) ; le client se reconnecte aussitôt et chaque document est autorisé de nouveau, avec le nouveau rôle ou refusé. L'interface recharge le projet et revient au tableau de bord si l'accès a disparu, y compris lorsque l'événement a été manqué pendant une coupure (refus du canal du projet).

## Partage

- Tables `project_invites` (invitation nominative en attente, une au plus par projet et par personne) et `project_links` (lien de partage : empreinte SHA-256 du jeton, rôle, expiration facultative, révocation, nombre d'utilisations).
- Seul le propriétaire invite, crée ou révoque des liens, change les rôles, retire des membres et transfère la propriété (l'ancien propriétaire devient éditeur). Tout membre voit la liste des membres et peut quitter le projet ; les adresses e-mail ne sont montrées qu'au propriétaire.
- Une invitation vise un compte existant, trouvé par adresse ou nom d'utilisateur ; elle s'accepte depuis le tableau de bord. Un lien de partage (`/join/<jeton>`, 32 octets aléatoires) n'est affiché qu'à sa création ; il ne rétrograde jamais un membre existant. Limites de débit : 30 invitations par heure et par utilisateur, 30 usages de lien par minute.
- Un visiteur non connecté qui ouvre un lien passe par la page de connexion (`/login?redirect=...`, chemin interne uniquement) puis revient au lien.

## Indexation LaTeX

`packages/latex-index` est un module pur : il extrait d'un fichier les titres (parties à sous-paragraphes, frames Beamer), les `\label`, les commandes et environnements définis et les fichiers référencés, en ignorant commentaires et verbatim. L'API s'en sert pour `GET /api/projects/:id/outline` (plan depuis le document principal, en suivant `\input`, `\include`, `\subfile` et `\import`), `GET /api/projects/:id/index` (définitions, labels et entrées bibliographiques pour la complétion ; les `.bib` sont lus par `@retorquere/bibtex-parser`), `GET /api/projects/:id/search` et `POST /api/projects/:id/replace` (moteur RE2, au plus 1 000 résultats).

## Compilation

- `POST /api/projects/:id/compile` (tout membre, 60 par minute) attend que `collab` ait écrit les documents, matérialise le projet, crée une ligne `compile_runs` (`queued`) et met une tâche dans la file BullMQ `compile` avec `jobId` = identifiant de la compilation. Une compilation encore en attente pour le même projet est retirée et marquée `superseded`. L'API suit la file par `QueueEvents`, met la ligne à jour et publie `compile.updated` sur `project:<id>` à chaque changement d'état ; l'interface interroge aussi `GET .../compiles/latest` toutes les 2 s tant qu'une compilation est en cours, au cas où l'événement se perdrait.
- Le worker (`apps/compiler`) prend un verrou par projet dans Valkey, synchronise `work/<projectId>/src` depuis le stockage d'après les empreintes du manifeste (seuls les fichiers modifiés sont téléchargés, les auxiliaires de `out/` sont conservés), puis lance `latexmk` sous `bwrap` : aucun réseau, environnement vidé, `/usr` en lecture seule, sources sous `/project`, sorties sous `/out`, limites de durée (180 s), d'espace d'adressage (2 Gio par processus), de processus (64) et de taille de sortie (500 Mio). Les répertoires de travail sont évincés par ordre d'utilisation au-delà de `COMPILER_WORK_QUOTA_MB`.
- Résultat : PDF, journaux, `.synctex.gz` et annexes publiés sous `compiles/<compileId>/` dans le stockage, diagnostics analysés par `packages/latex-log` (500 au plus). `GET .../compiles/:compileId/output/*` ne sert que les fichiers publiés par cette compilation.
- Annulation : `POST .../compiles/:compileId/cancel` retire une tâche en attente ou prévient le worker par le canal Valkey `compile:cancel`, qui arrête `bwrap` et tout son espace de PID.
- Rétention : les trois dernières compilations terminées et la dernière ayant produit un PDF ; le reste est supprimé du stockage et de la base.
- Au démarrage, le worker vérifie que `bwrap` fonctionne et lit le millésime TeX Live (`GET /api/compiler`). Les conditions côté hôte et Docker sont dans `docs/operations.md`.

## SyncTeX

- `GET /api/projects/:id/compiles/:compileId/synctex/edit?page&x&y` (PDF vers source) et `.../synctex/view?fileId&line&column` (source vers PDF), pour tout membre, 240 par minute. Coordonnées en points depuis le coin supérieur gauche de la page ; la conversion depuis pdf.js est faite par `apps/web/src/lib/synctex.ts`.
- L'API met une tâche dans la file BullMQ `synctex` et attend la réponse 5 s au plus. Le worker la traite dans un `Worker` séparé (concurrence 4) : il télécharge au besoin le `.synctex.gz` publié par la compilation demandée dans `<COMPILER_WORK_DIR>/synctex-cache/<compileId>` (32 compilations au plus), puis lance `synctex` sous `bwrap` avec ce seul dossier monté en lecture seule.
- Les chemins enregistrés par TeX (`/project/./chapters/intro.tex`) sont ramenés au projet puis à un identifiant de fichier ; un point issu d'une classe ou d'un paquet de TeX Live est signalé comme externe.

## Diagnostics dans l'éditeur

Un seul linter CodeMirror affiche les marqueurs de la dernière compilation (déplacés avec le texte modifié) et ceux de `lintDocument` (`packages/latex-index`), calculés dans le navigateur après chaque pause de frappe sur les fichiers `.tex`, avec les labels et clés bibliographiques des autres fichiers venus de l'index.

## Politique de sécurité du contenu

Caddy envoie une CSP stricte (`script-src 'self'`). `style-src` porte un nonce propre à chaque réponse, que `index.html` reçoit par la directive `templates` et que le client transmet aux bibliothèques qui insèrent des éléments `<style>` (CodeMirror, Radix). `index.html` n'est jamais mis en cache.
