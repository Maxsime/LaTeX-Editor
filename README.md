# Galley

Éditeur LaTeX collaboratif, auto-hébergé, avec assistant IA intégré. Le cahier des charges est dans [`SPEC.md`](SPEC.md), les consignes de développement dans [`CLAUDE.md`](CLAUDE.md).

État : jalon J11 en cours (fonctions avancées). Comptes, projets, import Overleaf ou Prism, édition synchronisée à plusieurs, compilation TeX Live 2026 en bac à sable avec SyncTeX, commentaires et suivi des modifications, historique et accès Git, bibliographie et correcteur, assistant IA qui propose sans écrire. L'administrateur dispose d'une console (comptes, invitations, quotas, connexion unique OIDC, modèle d'IA de l'instance) et de scripts de sauvegarde et de restauration. Le jalon J11 ajoute la duplication, les modèles personnels, les fichiers liés, le texmf personnel, l'éditeur visuel, les modes Vim et Emacs, le PDF sombre ou détaché et les explications d'erreurs ; viennent ensuite la précompilation du préambule, l'envoi d'e-mails, la synchronisation GitHub et GitLab et le mode agent.

## Démarrer une instance

Prérequis : Docker avec Compose v2.

```sh
docker compose up --build
```

Le premier lancement est long : l'image de compilation embarque TeX Live complet (environ 2,6 Gio à télécharger, 7,5 Gio sur le disque). Sur un serveur Ubuntu 24.04, une option du noyau doit être changée avant le démarrage, voir [`docs/operations.md`](docs/operations.md).

L'instance est servie sur <https://localhost>. Aucune configuration n'est nécessaire : `compose.yaml` fournit des valeurs par défaut pour un usage local. Pour les modifier, `scripts/init-env.sh` crée `.env` à partir de `.env.example` avec des secrets aléatoires. Pour une instance publique (nom de domaine, Let's Encrypt, sauvegarde quotidienne, mise à jour), suivre [`docs/installation.md`](docs/installation.md) : l'API refuse de démarrer sur un autre hôte que `localhost` tant qu'un secret garde sa valeur de développement.

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

Le mode d'inscription se règle dans la console d'administration (menu « Administration ») ou, par défaut, par `REGISTRATION_MODE` :

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

### Dupliquer, modèles, fichiers partagés

Le menu « ⋯ » d'une ligne du tableau de bord duplique un projet (fichiers, dossiers et réglages, sans l'historique ni les membres) ou l'enregistre comme modèle. Les modèles enregistrés apparaissent dans « Nouveau projet », à côté des modèles fournis (vide, article, rapport, présentation Beamer, lettre) ; un administrateur peut en proposer à toute l'instance. Ils se gèrent depuis « Mon compte ».

Depuis la page d'un projet, « Copier depuis un projet… » copie des fichiers ou des dossiers d'un autre projet, sans jamais écraser un nom existant. « Fichier lié… » ajoute la copie d'un fichier d'un autre projet ou d'une adresse web publique : elle est en lecture seule, s'actualise à la demande (clic droit, « Actualiser depuis la source ») et redevient un fichier ordinaire après « Rompre le lien ».

« Mon texmf », dans « Mon compte », ouvre une arborescence personnelle : les classes, paquets et bibliographies qu'on y dépose sont trouvés par la compilation de tous ses projets, où qu'ils soient rangés dans cette arborescence. Elle ne se compile pas et ne se partage pas.

### Éditer

Un clic sur un fichier texte l'ouvre dans un onglet. Chaque frappe part aussitôt vers le serveur : il n'y a pas de bouton d'enregistrement, et la pastille de l'onglet indique l'état (synchronisé, envoi en cours, hors ligne). Hors ligne, les modifications restent dans l'onglet et repartent à la reconnexion ; le navigateur prévient si l'on ferme la page avant.

L'éditeur colore LaTeX et BibTeX, replie les environnements et les sections, et complète les commandes, les environnements et les chemins de fichiers, y compris ceux que le projet définit. Après `\ref{` et ses variantes, il propose les labels du projet ; après `\cite{` et ses variantes (natbib, BibLaTeX), les clés de tous les `.bib` du projet et des `\bibitem`, avec auteurs et année ; dans `\usepackage[...]` et `\documentclass[...]`, les options des paquets et classes courants. Sans compiler, il souligne les environnements mal fermés, les labels en double et les références ou citations inconnues. Le panneau « Plan » suit `\input`, `\include` et `\subfile` depuis le document principal et mène à la section choisie. Le panneau « Recherche » cherche dans tout le projet (texte ou expression régulière, casse, mot entier) et remplace partout après confirmation. Thème, taille de police, retour à la ligne et raccourcis (standard, Vim ou Emacs) se règlent au-dessus de l'éditeur.

Le bouton « Visuel » d'un fichier `.tex` masque le balisage des titres, des emphases et des listes et affiche les formules, sauf sur la ligne où se trouve le curseur ; le fichier reste du LaTeX, et les suggestions restent affichées telles qu'écrites. Sur un `.bib`, « Trier et formater » range les entrées par clé, par premier auteur ou par année et aligne les champs ; l'opération s'annule comme une frappe. Un clic sur l'avatar d'un collaborateur le suit : son fichier s'ouvre et son curseur reste visible, jusqu'à ce que l'on clique ou tape soi-même.

### Rédiger : bibliographie, orthographe, aides

Le panneau « Références » liste les entrées de tous les `.bib` du projet, cherche dans leurs clés, titres, auteurs et années, distingue celles qui ne sont citées nulle part, insère `\cite{clé}` au curseur et mène à l'entrée. Son bouton « Importer » crée des entrées à partir d'un DOI (Crossref), d'un identifiant arXiv, d'un ISBN (Open Library), d'un BibTeX collé ou de votre bibliothèque Zotero, puis les ajoute au `.bib` choisi ou à un nouveau `references.bib`. Les clés suivent le motif du projet (par défaut `[auth:lower][year][shorttitle:lower]`, par exemple `knuth1984literate`) et ne reprennent jamais une clé existante. Les `.bib` sont vérifiés pendant la frappe : entrée sans clé, accolade ou virgule manquante, champ ou clé en double, y compris d'un fichier à l'autre.

Pour Zotero, créez une clé d'API sur zotero.org (lecture seule suffit) et reliez-la dans « Mon compte ». Elle est chiffrée sur le serveur et n'est plus jamais affichée en entier.

L'orthographe et la grammaire sont vérifiées par LanguageTool, hébergé avec l'instance : rien ne part vers un service extérieur. Les fautes d'orthographe sont soulignées en rouge, la grammaire en bleu, le style en pointillés ; un survol propose les corrections, l'ajout au dictionnaire personnel (géré dans « Mon compte ») ou « Ignorer ». Les commandes, formules, références et environnements non textuels ne sont jamais vérifiés. La langue vient de babel ou polyglossia, ou du réglage « Langue vérifiée » des options. La case « Orthographe » au-dessus de l'éditeur coupe la vérification pour vous seul.

Chaque compilation lance aussi chktex et texcount. Les remarques de chktex s'affichent dans la gouttière ; « Désactiver cette règle » les retire pour tout le projet (la liste se modifie dans les options). Le panneau « Mots » donne le nombre de mots du texte, des titres et des légendes, au total et par section.

Survolez une formule pour la voir rendue (KaTeX, avec les `\newcommand` et `\DeclareMathOperator` du projet) ; une pastille montre chaque couleur définie par `\definecolor` ou utilisée par `\color`, `\textcolor`... Au-dessus de l'éditeur, « Symboles » ouvre une palette d'environ 280 symboles (recherche par nom, paquet requis indiqué), et « Tableau », « Figure » et « Équations » écrivent le code d'un tableau (booktabs), d'une figure ou d'équations alignées, en rappelant le paquet à charger s'il manque.

### Assistant IA

L'onglet « Assistant » du panneau de gauche ouvre une conversation qui connaît le projet : plan, labels, clés de citation, paquets, fichier ouvert autour du curseur et dernières erreurs de compilation. L'assistant lit les fichiers dont il a besoin, cherche dans le projet et, pour les éditeurs, propose des modifications. Une proposition s'affiche en différentiel, fichier par fichier, et dans l'éditeur (texte d'origine barré, remplacement en vert) : rien n'est écrit tant que vous ne l'acceptez pas, morceau par morceau, par fichier ou en bloc. Si le texte a changé entre-temps au point qu'elle ne s'applique plus, elle est signalée en conflit et le fichier n'est pas touché.

Ctrl+Alt+K sur une sélection demande une réécriture de ce passage. Dans le journal de compilation, « Expliquer et corriger » transmet l'erreur à l'assistant. Le bouton « Générer… » au-dessus de l'éditeur écrit un tableau, une figure TikZ, un graphique pgfplots ou une formule à partir d'une description, ou d'une image si le modèle lit les images ; le code est compilé seul pour l'aperçu, inséré au curseur sur demande, et les paquets à charger sont rappelés. Pour la bibliographie, l'assistant cherche dans Crossref, arXiv et OpenAlex, mais n'ajoute au `.bib` que des entrées récupérées auprès de ces services : une clé de citation inventée est refusée par le serveur.

Le modèle se choisit dans « Mon compte » : Anthropic, OpenAI, Mistral, ou un serveur compatible OpenAI comme Ollama. La clé d'API y est chiffrée et n'est plus jamais affichée en entier ; la consommation du mois (jetons, coût estimé si l'administrateur a saisi les prix) s'y affiche. Sans configuration personnelle, l'assistant utilise le modèle de l'instance s'il y en a un. Le propriétaire d'un projet peut désactiver l'assistant pour ce projet (« Options »). Les extraits du projet envoyés au fournisseur choisi quittent l'instance ; avec un modèle local, rien ne sort (voir `docs/operations.md`).

### Travailler à plusieurs

Le bouton « Partager » d'un projet liste ses membres. Son propriétaire peut inviter une personne qui a déjà un compte (par adresse e-mail ou nom d'utilisateur) comme éditeur, relecteur ou lecteur : l'invitation apparaît sur le tableau de bord de la personne, qui l'accepte ou la refuse. Il peut aussi créer un lien de partage pour un rôle, avec une durée de validité facultative ; le lien n'est affiché qu'une fois et se révoque à tout moment. Depuis la même fenêtre, il change les rôles, retire un membre (son accès est coupé aussitôt) ou transfère la propriété.

Les lecteurs voient le projet sans pouvoir le modifier ; les relecteurs le modifient en suggestions seulement (voir ci-dessous). Les pastilles de l'en-tête indiquent qui a le projet ouvert et dans quel fichier ; un clic y mène. Dans l'éditeur, le curseur et la sélection de chacun s'affichent à son nom. Après une coupure réseau, les modifications faites des deux côtés se fusionnent sans perte.

### Relire, commenter, discuter

Une case « Suggérer », au-dessus de l'éditeur, enregistre les modifications comme suggestions : le texte ajouté est souligné en vert, le texte supprimé reste visible, barré en rouge. Elle est toujours active pour un relecteur ; un éditeur la coche à son gré, et le propriétaire peut l'imposer à tous les éditeurs avec la case « Pour tous ». L'onglet « Revue » du panneau de gauche liste les suggestions du fichier ouvert, que les éditeurs acceptent ou rejettent une à une ou en bloc. Le serveur refuse toute autre modification venant d'un relecteur.

Pour commenter, sélectionnez du texte puis Ctrl+Alt+M (⌘⌥M sur Mac) : le commentaire s'écrit dans l'onglet « Revue », où chacun peut répondre, et où l'auteur ou un éditeur résout le fil. Écrire `@identifiant` mentionne un membre : la mention l'attend sur son tableau de bord. L'onglet « Discussion » est le fil de messages du projet, mis à jour en direct.

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

Le bouton « Journal » liste les erreurs et avertissements : un clic ouvre le fichier à la ligne fautive, également marquée dans la gouttière de l'éditeur. F8 et Maj+F8 passent d'une erreur à la suivante ou à la précédente. Sous les erreurs courantes (commande inconnue, `$` manquant, fichier introuvable, accolade en trop, environnement mal refermé, référence ou citation indéfinie…), une phrase explique la cause probable et la correction habituelle.

Un double-clic dans le PDF ouvre le fichier source à la ligne correspondante, y compris dans un fichier inclus. Dans l'autre sens, le bouton « Vers le PDF » ou Ctrl+Alt+J fait défiler le PDF jusqu'à la ligne du curseur et la surligne. Le bouton « Mode sombre » de la visionneuse inverse les couleurs des pages ; « Détacher » ouvre le PDF dans une fenêtre séparée, pour un second écran, où le double-clic et « Vers le PDF » fonctionnent toujours. Le journal brut et les fichiers produits (`.log`, `.bbl`, `.synctex.gz`...) y sont téléchargeables. Le menu « Options » règle le moteur (pdfLaTeX, XeLaTeX, LuaLaTeX), l'outil bibliographique, le shell-escape, la compilation en brouillon et l'arrêt à la première erreur, et propose « Nettoyer et recompiler ».

Chaque compilation tourne sans réseau, dans un bac à sable limité en temps (3 min), en mémoire et en disque. Le shell-escape complet (minted, par exemple) n'est accepté que si l'administrateur l'autorise (`COMPILER_ALLOW_FULL_SHELL_ESCAPE`) ; sinon le projet compile avec la liste restreinte de TeX Live.

### Administration, quotas et sauvegardes

Le menu « Administration », visible des administrateurs, regroupe les comptes (création, désactivation, rôle, réinitialisation du mot de passe, quotas individuels), les invitations, le mode d'inscription et les quotas par défaut, le modèle d'IA de l'instance et l'état des services. Les réglages faits dans la console priment sur `.env`. Chacun voit sa consommation (stockage, temps de compilation du mois) dans « Mon compte ».

La connexion unique passe par un fournisseur OpenID Connect (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`). `scripts/backup.sh` sauvegarde l'instance sans l'arrêter, `scripts/restore.sh` la restaure. Le détail est dans [`docs/operations.md`](docs/operations.md).

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
packages/review      suggestions : texte accepté, acceptation, rejet (Yjs)
fixtures/            archives de référence pour les tests
e2e/                 tests Playwright
infra/               Dockerfiles et configuration de Caddy
scripts/             scripts d'exploitation
docs/                plans de jalons, décisions, architecture
```

Documentation : [`docs/architecture.md`](docs/architecture.md), [`docs/decisions.md`](docs/decisions.md), plans de jalons dans [`docs/plans/`](docs/plans/).

## Licence

[AGPL-3.0](LICENSE). Toute instance modifiée et mise à disposition d'utilisateurs doit leur donner accès à son code source ; l'interface affiche pour cela un lien vers le dépôt, configurable par `VITE_SOURCE_URL` à la construction.
