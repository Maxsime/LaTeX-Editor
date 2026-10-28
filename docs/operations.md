# Exploitation

Ce document rassemble ce qu'un administrateur doit savoir pour faire tourner une instance. L'installation d'un serveur public est décrite dans `docs/installation.md`, l'architecture dans `docs/architecture.md`.

## Ressources

- Disque : l'image du worker de compilation (TeX Live complet) occupe environ 7,5 Gio ; le premier `docker compose up --build` télécharge environ 2,6 Gio pour elle seule. Prévoir en plus les répertoires de travail des compilations (volume `compile-work`, 20 Gio au plus par défaut, `COMPILER_WORK_QUOTA_MB`), la base, le stockage objet et les dépôts Git des projets (volume `git-data`, de la taille des projets à peu près ; il se reconstruit depuis les projets s'il est perdu, mais les clones existants devront alors être refaits).
- Mémoire : chaque compilation peut utiliser jusqu'à `COMPILER_MEMORY_MB` (2 Gio) par processus ; compter au moins 2 Gio par compilation simultanée (`COMPILER_CONCURRENCY`, 2 par défaut) en plus des autres services. LanguageTool réserve en plus son tas Java (`LANGUAGETOOL_MEMORY`, 1 Gio par défaut ; 512 Mio suffisent pour quelques utilisateurs). Son image pèse environ 450 Mo et il met 20 à 40 s à démarrer ; l'éditeur reste utilisable sans lui.
- Réseau sortant : l'API appelle `api.crossref.org`, `export.arxiv.org`, `openlibrary.org` et `api.zotero.org` pour les imports bibliographiques, `api.openalex.org` (et `api.semanticscholar.org` avec une clé) pour les recherches de l'assistant, ainsi que le fournisseur d'IA configuré. Derrière un pare-feu, les ouvrir ou désigner un miroir (`CROSSREF_URL`, `ARXIV_URL`, `OPENLIBRARY_URL`, `ZOTERO_URL`, `OPENALEX_URL`, `SEMANTIC_SCHOLAR_URL`). Aucun autre service ne sort : LanguageTool et le worker de compilation sont sur le réseau interne.

## Clé maître

`GALLEY_MASTER_KEY` chiffre au repos les secrets que les utilisateurs confient à l'instance (clés d'API Zotero et des fournisseurs d'IA ; AES-256-GCM, chaque secret lié à son propriétaire). `scripts/init-env.sh` en génère une avec les autres secrets. Pour la créer à la main, 32 octets en base64 :

```sh
openssl rand -base64 32
```

La valeur par défaut de `compose.yaml` est publique : l'API l'annonce en avertissement sur `localhost` et refuse de démarrer avec elle sur tout autre nom d'hôte, comme avec les autres secrets de développement. La clé ne quitte jamais le serveur et n'apparaît pas dans les sauvegardes de la base : la conserver à part, avec les autres secrets. La perdre ou la changer rend les clés enregistrées illisibles ; les utilisateurs les saisissent alors à nouveau (aucune autre donnée n'est perdue).

## Console d'administration

Le menu « Administration » (comptes administrateurs seulement) regroupe :

- Utilisateurs : recherche, création avec mot de passe temporaire affiché une fois, désactivation (les sessions de la personne sont fermées), droits d'administration, réinitialisation du mot de passe, quotas propres. L'instance garde toujours au moins un administrateur actif : la console refuse de retirer ses droits ou de désactiver le dernier.
- Invitations : liens d'inscription à usage unique, de 1 à 90 jours.
- Inscription et quotas : mode d'inscription (`open`, `invite`, `closed`) et quotas par défaut.
- Assistant IA : interrupteur de l'instance, modèle par défaut (clé chiffrée par la clé maître, affichée par ses 4 derniers caractères) et table des prix.
- Services : version, millésime TeX Live, file de compilation, compilations des dernières 24 h, comptes actifs, stockage, connexion unique.

Un réglage modifié dans la console est enregistré en base et l'emporte sur la variable d'environnement correspondante (`REGISTRATION_MODE`, `QUOTA_*`, `AI_ENABLED`, `AI_DEFAULT_*`), qui reste la valeur de départ. La console indique pour chaque réglage d'où vient sa valeur. Pour revenir à la variable d'environnement, supprimer la ligne de la table `instance_settings`, ou, pour le modèle d'IA, utiliser « Revenir à la configuration du serveur ».

Les commandes en ligne de `README.md` (`create-user`, `reset-password`, `create-invite`) restent disponibles, par exemple pour retrouver l'accès si plus aucun administrateur ne peut se connecter.

## Quotas

Deux limites, vides (illimitées) par défaut :

- Espace de stockage (`QUOTA_STORAGE_MB`) : somme des fichiers des projets dont la personne est propriétaire, corbeille comprise jusqu'à la purge. Vérifié avant chaque écriture qui ajoute des données : téléversement, import d'archive, création de projet, push Git, restauration d'une version, fichier créé par l'assistant. Une écriture qui fait grandir l'espace au-delà de la limite est refusée (`QUOTA_STORAGE_EXCEEDED`) ; supprimer ou réduire reste toujours possible. La frappe dans l'éditeur n'est jamais bloquée : un document qui grossit est compté, et c'est l'écriture bloquante suivante qui échoue.
- Temps de compilation par mois civil (`QUOTA_COMPILE_MINUTES`) : durée des compilations lancées par la personne, aperçus de l'assistant compris. Vérifié au lancement (`QUOTA_COMPILE_EXCEEDED`) ; une compilation en cours n'est jamais interrompue, si bien que le dernier mois peut dépasser la limite d'une compilation.

Chaque personne voit sa consommation dans « Mon compte ». Dans la console, une valeur propre à une personne remplace la valeur par défaut ; `-1` la rend illimitée. Le quota de stockage d'un projet partagé est celui de son propriétaire, quel que soit le membre qui écrit.

## Connexion unique (OIDC)

Galley accepte un fournisseur OpenID Connect : Keycloak, Authentik, Google Workspace, Microsoft Entra ID, ou tout fournisseur conforme. Dans la console du fournisseur, créer un client confidentiel de type « authorization code », avec l'adresse de retour `https://<GALLEY_HOST>/api/auth/oidc/callback`, puis renseigner dans `.env` :

```sh
OIDC_ISSUER=https://id.example.org/realms/ecole   # adresse de découverte, sans /.well-known/...
OIDC_CLIENT_ID=galley
OIDC_CLIENT_SECRET=...
OIDC_DISPLAY_NAME=Compte de l'école               # texte du bouton « Se connecter avec ... »
```

Le flux utilise PKCE, `state` et `nonce` ; l'état est lié au navigateur par un cookie, si bien qu'un lien de connexion forgé ne connecte personne. À la première connexion d'une identité :

1. si un compte a la même adresse e-mail et que le fournisseur garantit cette adresse (`email_verified`), l'identité lui est rattachée ;
2. sinon, si l'inscription est ouverte ou `OIDC_ALLOW_SIGNUP=true`, un compte est créé, sans mot de passe (l'administrateur peut lui en donner un depuis la console) ;
3. sinon la connexion est refusée avec un message explicite.

Un fournisseur qui ne garantit pas l'adresse e-mail ne peut ni rattacher ni créer de compte : c'est volontaire, sinon n'importe qui pourrait prendre un compte en déclarant son adresse. GitHub n'est pas un fournisseur OpenID Connect pour la connexion des personnes : passer par un courtier comme Keycloak ou Authentik, qui proposent GitHub comme source d'identité. Un fournisseur en HTTP simple n'est accepté que parce que l'administrateur l'a configuré ainsi (réseau interne, tests) ; en production, HTTPS.

## Sauvegarde et restauration

`scripts/backup.sh [dossier]` (défaut `./backups`) sauvegarde une instance en marche dans `galley-<date UTC>/` :

| Fichier         | Contenu                                                                        |
| --------------- | ------------------------------------------------------------------------------ |
| `database.dump` | base PostgreSQL (`pg_dump` au format personnalisé)                             |
| `objects.tar`   | fichiers binaires, contenus des versions, sorties de compilation (stockage S3) |
| `git.tar`       | dépôts Git des projets                                                         |
| `manifest.json` | date, version, nombre de migrations, nombre d'objets, empreinte du contenu     |
| `SHA256SUMS`    | empreintes des quatre fichiers, vérifiées avant toute restauration             |

La base est sauvegardée avant les objets. Un objet n'est jamais réécrit : chaque ligne de la base retrouve donc son objet, et un objet stocké après la sauvegarde de la base est simplement inutilisé. Le dossier n'est lisible que par son propriétaire ; il contient tous les documents et les empreintes des mots de passe : le traiter comme une donnée sensible. Valkey (files d'attente, caches) n'est pas sauvegardé.

`scripts/restore.sh <dossier> [--yes]` restaure sur une instance neuve ou existante :

1. vérifie les empreintes et refuse une sauvegarde d'une version plus récente que le code ;
2. demande confirmation si l'instance a déjà des comptes ;
3. arrête les services applicatifs, remplace la base, vide Valkey, restaure les objets et les dépôts Git ;
4. compare l'empreinte du contenu restauré (comptes, projets, arborescence, texte de chaque fichier, versions, objets) à celle du manifeste, avant que les services ne redémarrent ;
5. relance l'instance ; les migrations plus récentes s'appliquent au démarrage.

`backup.sh` calcule l'empreinte au début et à la fin de la sauvegarde et ne l'enregistre que si elles sont égales ; sinon (l'instance a changé pendant la sauvegarde, par exemple une version automatique de l'historique), la sauvegarde reste utilisable mais la restauration ne peut pas être vérifiée par l'empreinte. `--verify` fait de toute différence une erreur (CI). La clé maître n'est pas dans la sauvegarde : sur une nouvelle machine, reprendre le `.env` d'origine avant de restaurer, sinon les clés Zotero et d'IA enregistrées devront être ressaisies.

La CI exerce l'ensemble après les tests de bout en bout (`scripts/ci-backup-roundtrip.sh`) : sauvegarde (refaite jusqu'à trois fois si l'instance a changé pendant), `docker compose down --volumes`, pile neuve, restauration avec `--verify`, connexion avec un compte créé avant la sauvegarde.

## Supervision

Chaque service expose ses métriques Prometheus sur le réseau interne, sans passer par Caddy : `api:3000/metrics`, `collab:3001/metrics`, `compiler:3002/metrics`. Outre les métriques de Node.js :

- `galley_http_request_duration_seconds` : durée des requêtes HTTP par route ;
- `galley_compile_queue_jobs` : compilations en attente, en cours, différées, en échec ;
- `galley_compile_jobs_total`, `galley_compile_duration_seconds` : issue et durée des compilations ;
- `galley_collab_connections`, `galley_collab_documents` : connexions et documents ouverts ;
- `galley_ai_requests_total`, `galley_ai_tokens_total` : requêtes à l'assistant par issue, jetons consommés par fournisseur.

Le profil Compose `monitoring` ajoute un Prometheus qui collecte les trois services (`infra/monitoring/prometheus.yml`), 30 jours de rétention (`PROMETHEUS_RETENTION`) :

```sh
docker compose --profile monitoring up -d
```

Il écoute sur `127.0.0.1:9090` du serveur seulement (`PROMETHEUS_PORT`) : y accéder par un tunnel SSH (`ssh -L 9090:localhost:9090 serveur`). `infra/monitoring/grafana-dashboard.json` est un tableau de bord d'exemple à importer dans un Grafana existant.

## Assistant IA

L'assistant est actif par défaut (`AI_ENABLED`), mais n'a pas de modèle : chaque utilisateur renseigne le sien dans « Mon compte », ou l'instance en fournit un à tous avec `AI_DEFAULT_PROVIDER`, `AI_DEFAULT_MODEL`, `AI_DEFAULT_API_KEY` et, pour un serveur compatible OpenAI, `AI_DEFAULT_BASE_URL`. La clé de l'instance n'est jamais montrée aux utilisateurs. Fournisseurs pris en charge : Anthropic (cache de prompt activé), OpenAI, Mistral, et tout serveur compatible avec l'API Chat Completions d'OpenAI (Ollama, vLLM, LM Studio). Pour un modèle que Galley ne connaît pas, `AI_DEFAULT_VISION` et `AI_DEFAULT_CONTEXT_TOKENS` indiquent s'il lit les images et la taille de sa fenêtre ; sans indication, il est traité comme un modèle sans vision de 32 000 jetons.

Limites : 20 requêtes par minute et par personne (`AI_RATE_LIMIT_PER_MINUTE`), 2 minutes et 8 appels au modèle par requête, images de 4 Mo. Les propositions de modification sont gardées 24 h dans Valkey ; la conversation elle-même ne vit que dans l'onglet du navigateur.

### Modèle local avec Ollama

Ollama tourne sur la machine hôte ; le conteneur `api` la joint à l'adresse `host.docker.internal` (déclarée dans `compose.yaml`). Dans `.env` :

```sh
AI_DEFAULT_PROVIDER=openai-compatible
AI_DEFAULT_MODEL=llama3.1
AI_DEFAULT_BASE_URL=http://host.docker.internal:11434/v1
```

Puis `docker compose up -d api`. Avec Docker Desktop (Windows, macOS), Ollama installé normalement suffit. Sous Linux, Ollama n'écoute par défaut que sur `127.0.0.1` : le faire écouter sur l'interface du pont Docker (`OLLAMA_HOST=0.0.0.0`, ou l'adresse de `docker0`) et vérifier que le pare-feu laisse passer le port 11434 depuis les conteneurs. Les petits modèles appellent mal les outils : la réécriture d'une sélection et la génération n'en ont pas besoin, la conversation se contente alors de répondre sans proposer de modification.

### Adresses choisies par les utilisateurs

Par défaut, un utilisateur ne peut viser que l'adresse officielle des fournisseurs : un serveur compatible OpenAI personnel est refusé (`AI_ENDPOINT_FORBIDDEN`). `AI_ALLOW_USER_ENDPOINTS=true` lève cette restriction ; l'API appelle alors n'importe quelle adresse saisie, y compris celles du réseau interne de l'instance. À réserver à une instance dont tous les comptes sont de confiance. La CI l'active pour le test de bout en bout de l'assistant, qui sert un faux modèle depuis la machine de test.

### Confidentialité

À chaque requête, l'API envoie au fournisseur choisi : la liste des fichiers, le plan, les labels, les clés de citation, les paquets et commandes du projet, une fenêtre du fichier ouvert autour du curseur, les dernières erreurs de compilation, puis le contenu des fichiers que le modèle demande à lire. Avec un fournisseur en ligne, ces extraits quittent l'instance et relèvent de ses conditions ; avec un modèle local, rien ne sort. Les journaux de l'API ne contiennent ni texte de document, ni clé, ni réponse du modèle : seulement le fournisseur, le modèle, le nombre de jetons et le type d'erreur. Le propriétaire d'un projet peut y couper l'assistant ; `AI_ENABLED=false` le coupe pour toute l'instance.

### Coûts

Le coût estimé d'une requête vient de la table des prix, vide à l'installation (les tarifs changent trop souvent pour en livrer). En attendant l'écran de la console d'administration, un administrateur la remplace en entier par l'API, depuis une session ouverte (`root.crt` : certificat local, voir le README) :

```sh
curl --cacert root.crt -c c.txt -H 'content-type: application/json' \
  -d '{"login":"admin","password":"..."}' https://localhost/api/auth/login
CSRF=$(curl --cacert root.crt -b c.txt -s https://localhost/api/auth/session | jq -r .csrfToken)
curl --cacert root.crt -b c.txt -X PUT https://localhost/api/admin/ai/prices \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"prices":[{"provider":"anthropic","model":"<modèle>","inputPerMTok":3,"outputPerMTok":15,"cachedInputPerMTok":0.3,"currency":"USD"}]}'
```

Sans prix, la consommation s'affiche en jetons et le coût est indiqué comme inconnu.

### Vérifier un fournisseur réel

Les tests automatisés jouent le même scénario contre de faux serveurs aux protocoles d'Anthropic et d'OpenAI. Pour valider un fournisseur réel, la suite d'évaluation fait corriger une coquille, puis générer un tableau, une formule et une figure TikZ, et vérifie que chaque résultat compile (pdflatex local, sinon l'image `galley/compiler:dev`, sans réseau) :

```sh
pnpm --filter @galley/ai build
EVAL_PROVIDER=anthropic EVAL_MODEL=<modèle> EVAL_API_KEY=... pnpm --filter @galley/ai eval
EVAL_PROVIDER=openai-compatible EVAL_MODEL=llama3.1 EVAL_BASE_URL=http://localhost:11434/v1 pnpm --filter @galley/ai eval
```

Puis, dans l'interface : configurer le fournisseur dans « Mon compte », demander dans un projet de corriger une phrase, vérifier que le fichier ne change qu'après « Accepter ».

## Fichiers liés par adresse web

Un fichier peut être lié à une adresse `http` ou `https` et actualisé à la demande. L'API télécharge alors le fichier elle-même, avec ces garde-fous : seules les adresses publiques sont contactées (boucle locale, réseaux privés, liens locaux, plage partagée des opérateurs, multidiffusion et adresses IPv4 encapsulées en IPv6 sont refusés, après résolution DNS et à chaque redirection), 5 redirections au plus, 15 s, 20 Mo, aucun identifiant dans l'adresse. Pour couper cette fonction, `LINKED_URLS_ENABLED=false` : les liens entre projets restent possibles, les liens existants vers le web ne s'actualisent plus.

## Bac à sable de compilation

Le worker refuse de démarrer si `bwrap` ne peut pas créer son bac à sable, et son journal donne la raison (`sandbox unavailable: ...`). `compose.yaml` fournit déjà ce qu'il faut côté Docker : profil seccomp `infra/compiler/seccomp.json`, `systempaths=unconfined` et `apparmor=unconfined` sur le seul conteneur `compiler` (le profil AppArmor par défaut de Docker interdit les montages dont `bwrap` a besoin ; voir `docs/decisions.md`).

Côté hôte, Ubuntu 23.10 et suivantes (24.04 comprise) interdisent par défaut les espaces de noms utilisateur non privilégiés. Il faut lever cette restriction :

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-galley-userns.conf
```

Docker Desktop (Windows, macOS) n'est pas concerné.

## Changer de millésime TeX Live

Le millésime est figé par l'empreinte de l'image `texlive/texlive` dans `infra/docker/node-service.Dockerfile` (`TEXLIVE_IMAGE`).

1. Récupérer l'empreinte de la nouvelle image : `docker buildx imagetools inspect texlive/texlive:latest-full`.
2. Remplacer l'empreinte et le commentaire qui la date dans le `Dockerfile`.
3. Reconstruire et lancer le corpus : `docker compose build compiler && pnpm --filter @galley/compiler test:corpus`.
4. Redémarrer `compiler`. Le millésime affiché dans les options de compilation change ; les répertoires de travail existants restent valables, latexmk recompile ce qui doit l'être.

Le changement de millésime peut modifier le rendu de documents existants : l'annoncer aux utilisateurs.

## Purge

Les projets mis à la corbeille depuis plus de 30 jours sont purgés chaque heure (file `maintenance`). Les compilations au-delà de la rétention (trois dernières et dernier PDF) sont supprimées à la fin de chaque compilation.
