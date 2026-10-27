# Galley

Éditeur LaTeX collaboratif, auto-hébergé, avec assistant IA intégré. Le cahier des charges est dans [`SPEC.md`](SPEC.md), les consignes de développement dans [`CLAUDE.md`](CLAUDE.md).

État : jalon J4 (navigation et diagnostics). On crée un compte, on gère ses projets, on importe un projet Overleaf ou Prism en zip, on édite ses fichiers dans un éditeur LaTeX synchronisé en continu, on compile avec TeX Live 2026 dans un bac à sable, on lit le PDF à côté du source et on passe de l'un à l'autre par SyncTeX. La collaboration (présence, commentaires, partage) arrive au jalon suivant (`SPEC.md` §9).

## Démarrer une instance

Prérequis : Docker avec Compose v2.

```sh
docker compose up --build
```

Le premier lancement est long : l'image de compilation embarque TeX Live complet (environ 2,6 Gio à télécharger, 7,5 Gio sur le disque). Sur un serveur Ubuntu 24.04, une option du noyau doit être changée avant le démarrage, voir [`docs/operations.md`](docs/operations.md).

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

Le bouton « Importer un zip » du tableau de bord accepte l'export d'un projet Overleaf ou Prism, ou n'importe quel dossier compressé. Aucune organisation n'est imposée : le document principal est le fichier `.tex` racine qui déclare `\documentclass`, et il se change depuis la page du projet. Les fichiers texte en UTF-8 sont stockés comme documents texte, éditables dans l'éditeur ; les autres (images, PDF, fichiers texte dans un autre encodage) sont conservés octet pour octet. L'export redonne exactement les mêmes fichiers.

Limites d'une archive : 5 000 entrées, 500 Mio décompressés, 100 Mio par fichier, 32 niveaux de dossiers. Les archives contenant des chemins sortant du projet, des liens symboliques ou un taux de compression anormal sont refusées en entier.

### Éditer

Un clic sur un fichier texte l'ouvre dans un onglet. Chaque frappe part aussitôt vers le serveur : il n'y a pas de bouton d'enregistrement, et la pastille de l'onglet indique l'état (synchronisé, envoi en cours, hors ligne). Hors ligne, les modifications restent dans l'onglet et repartent à la reconnexion ; le navigateur prévient si l'on ferme la page avant.

L'éditeur colore LaTeX et BibTeX, replie les environnements et les sections, et complète les commandes, les environnements et les chemins de fichiers, y compris ceux que le projet définit. Après `\ref{` et ses variantes, il propose les labels du projet ; après `\cite{` et ses variantes (natbib, BibLaTeX), les clés de tous les `.bib` du projet et des `\bibitem`, avec auteurs et année ; dans `\usepackage[...]` et `\documentclass[...]`, les options des paquets et classes courants. Sans compiler, il souligne les environnements mal fermés, les labels en double et les références ou citations inconnues. Le panneau « Plan » suit `\input`, `\include` et `\subfile` depuis le document principal et mène à la section choisie. Le panneau « Recherche » cherche dans tout le projet (texte ou expression régulière, casse, mot entier) et remplace partout après confirmation. Thème, taille de police et retour à la ligne se règlent au-dessus de l'éditeur.

### Travailler à plusieurs

Le bouton « Partager » d'un projet liste ses membres. Son propriétaire peut inviter une personne qui a déjà un compte (par adresse e-mail ou nom d'utilisateur) comme éditeur, relecteur ou lecteur : l'invitation apparaît sur le tableau de bord de la personne, qui l'accepte ou la refuse. Il peut aussi créer un lien de partage pour un rôle, avec une durée de validité facultative ; le lien n'est affiché qu'une fois et se révoque à tout moment. Depuis la même fenêtre, il change les rôles, retire un membre (son accès est coupé aussitôt) ou transfère la propriété.

Les relecteurs et lecteurs voient le projet sans pouvoir le modifier. Les pastilles de l'en-tête indiquent qui a le projet ouvert et dans quel fichier ; un clic y mène. Dans l'éditeur, le curseur et la sélection de chacun s'affichent à son nom. Après une coupure réseau, les modifications faites des deux côtés se fusionnent sans perte.

### Historique et Git

Le bouton « Historique » d'un projet liste ses versions : un enregistrement automatique toutes les 5 minutes d'activité, un après chaque compilation réussie, et les versions nommées. Pour chaque version, la fenêtre montre les fichiers modifiés depuis, le différentiel ligne à ligne des fichiers texte, et permet de restaurer un fichier ou tout le projet, ou de télécharger la version en zip. Restaurer n'efface rien : l'état remplacé reste dans l'historique.

Chaque projet est aussi un dépôt Git. Créez un jeton dans « Mon compte » (lien en haut de page), puis :

```sh
git clone https://localhost/git/<identifiant-du-projet>
# Nom d'utilisateur : quelconque. Mot de passe : le jeton.
```

L'adresse exacte est affichée dans la fenêtre « Historique ». `git pull` récupère les modifications faites dans l'éditeur, `git push` envoie les vôtres, visibles aussitôt par les personnes qui ont le projet ouvert. Un push est refusé si le projet a changé depuis votre dernier `git pull` : récupérez, laissez Git fusionner, puis poussez. Seule la branche `main` est acceptée ; liens symboliques et sous-modules sont refusés. Avec le certificat local, indiquez-le à Git : `git -c http.sslCAInfo=root.crt clone ...`.

### Compiler

Le PDF s'affiche à droite de l'éditeur ; les boutons de l'en-tête basculent entre éditeur seul, PDF seul ou les deux. Un projet compile à son ouverture, puis à chaque pause de frappe (2 s par défaut, réglable ou désactivable dans « Options »), avec le bouton « Compiler », Ctrl+S ou Ctrl+Entrée. Le PDF garde sa position de lecture et son zoom d'une compilation à l'autre.

Le bouton « Journal » liste les erreurs et avertissements : un clic ouvre le fichier à la ligne fautive, également marquée dans la gouttière de l'éditeur. F8 et Maj+F8 passent d'une erreur à la suivante ou à la précédente.

Un double-clic dans le PDF ouvre le fichier source à la ligne correspondante, y compris dans un fichier inclus. Dans l'autre sens, le bouton « Vers le PDF » ou Ctrl+Alt+J fait défiler le PDF jusqu'à la ligne du curseur et la surligne. Le journal brut et les fichiers produits (`.log`, `.bbl`, `.synctex.gz`...) y sont téléchargeables. Le menu « Options » règle le moteur (pdfLaTeX, XeLaTeX, LuaLaTeX), l'outil bibliographique, le shell-escape, la compilation en brouillon et l'arrêt à la première erreur, et propose « Nettoyer et recompiler ».

Chaque compilation tourne sans réseau, dans un bac à sable limité en temps (3 min), en mémoire et en disque. Le shell-escape complet (minted, par exemple) n'est accepté que si l'administrateur l'autorise (`COMPILER_ALLOW_FULL_SHELL_ESCAPE`) ; sinon le projet compile avec la liste restreinte de TeX Live.

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

L'interface de développement est servie par Vite sur <http://localhost:5173>, qui relaie `/api` vers l'API locale et `/collab` (WebSocket) vers le serveur de collaboration.

| Commande         | Rôle                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------ |
| `pnpm lint`      | ESLint sur chaque paquet, puis vérification Prettier                                 |
| `pnpm typecheck` | Vérification des types                                                               |
| `pnpm format`    | Formatage Prettier                                                                   |
| `pnpm test`      | Tests Vitest ; les tests d'intégration démarrent leurs conteneurs via Testcontainers |
| `pnpm test:e2e`  | Tests Playwright contre la pile Compose démarrée                                     |
| `pnpm build`     | Construction de tous les paquets                                                     |

Les tests d'intégration sont ignorés en local si Docker est absent, et obligatoires en CI.

Le worker de compilation lancé par `pnpm dev` a besoin de TeX Live et de `bwrap` sur la machine (Linux uniquement). Ailleurs, compiler avec la pile complète (`docker compose up --build`). `pnpm --filter @galley/compiler test:corpus` compile tout `fixtures/projects/` dans l'image du worker et vérifie chaque résultat attendu.

### Construire derrière un proxy d'inspection TLS

Sur un réseau d'entreprise ou d'école qui intercepte le TLS, la construction des images échoue faute de connaître l'autorité du proxy. Les Dockerfiles acceptent un secret de construction facultatif `extra_ca_cert` :

```sh
docker buildx build --secret id=extra_ca_cert,src=/chemin/vers/ca.pem \
  -f infra/docker/node-service.Dockerfile --build-arg SERVICE=api -t galley/api:dev .
```

## Organisation du dépôt

```
apps/web             SPA React servie par Caddy
apps/api             API HTTP Fastify
apps/collab          serveur Hocuspocus (Yjs)
apps/compiler        worker de compilation (BullMQ)
packages/shared      schémas, configuration, journalisation partagés
packages/db          schéma PostgreSQL, migrations, sessions (API et collab)
packages/latex-index extraction du plan, des labels et des définitions LaTeX
fixtures/            archives de référence pour les tests
e2e/                 tests Playwright
infra/               Dockerfiles et configuration de Caddy
scripts/             scripts d'exploitation
docs/                plans de jalons, décisions, architecture
```

Documentation : [`docs/architecture.md`](docs/architecture.md), [`docs/decisions.md`](docs/decisions.md), plans de jalons dans [`docs/plans/`](docs/plans/).

## Licence

[AGPL-3.0](LICENSE). Toute instance modifiée et mise à disposition d'utilisateurs doit leur donner accès à son code source ; l'interface affiche pour cela un lien vers le dépôt, configurable par `VITE_SOURCE_URL` à la construction.
