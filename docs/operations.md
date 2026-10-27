# Exploitation

Ce document rassemble ce qu'un administrateur doit savoir pour faire tourner une instance. L'architecture est décrite dans `docs/architecture.md`.

## Ressources

- Disque : l'image du worker de compilation (TeX Live complet) occupe environ 7,5 Gio ; le premier `docker compose up --build` télécharge environ 2,6 Gio pour elle seule. Prévoir en plus les répertoires de travail des compilations (volume `compile-work`, 20 Gio au plus par défaut, `COMPILER_WORK_QUOTA_MB`), la base, le stockage objet et les dépôts Git des projets (volume `git-data`, de la taille des projets à peu près ; il se reconstruit depuis les projets s'il est perdu, mais les clones existants devront alors être refaits).
- Mémoire : chaque compilation peut utiliser jusqu'à `COMPILER_MEMORY_MB` (2 Gio) par processus ; compter au moins 2 Gio par compilation simultanée (`COMPILER_CONCURRENCY`, 2 par défaut) en plus des autres services. LanguageTool réserve en plus son tas Java (`LANGUAGETOOL_MEMORY`, 1 Gio par défaut ; 512 Mio suffisent pour quelques utilisateurs). Son image pèse environ 450 Mo et il met 20 à 40 s à démarrer ; l'éditeur reste utilisable sans lui.
- Réseau sortant : l'API appelle `api.crossref.org`, `export.arxiv.org`, `openlibrary.org` et `api.zotero.org` pour les imports bibliographiques, `api.openalex.org` (et `api.semanticscholar.org` avec une clé) pour les recherches de l'assistant, ainsi que le fournisseur d'IA configuré. Derrière un pare-feu, les ouvrir ou désigner un miroir (`CROSSREF_URL`, `ARXIV_URL`, `OPENLIBRARY_URL`, `ZOTERO_URL`, `OPENALEX_URL`, `SEMANTIC_SCHOLAR_URL`). Aucun autre service ne sort : LanguageTool et le worker de compilation sont sur le réseau interne.

## Clé maître

`GALLEY_MASTER_KEY` chiffre au repos les secrets que les utilisateurs confient à l'instance (clés d'API Zotero et des fournisseurs d'IA ; AES-256-GCM, chaque secret lié à son propriétaire). Générer une clé de 32 octets avant toute mise en service :

```sh
openssl rand -base64 32
```

La valeur par défaut de `compose.yaml` est publique et l'API l'annonce en avertissement à chaque démarrage. La clé ne quitte jamais le serveur et n'apparaît pas dans les sauvegardes de la base : la conserver à part, avec les autres secrets. La perdre ou la changer rend les clés enregistrées illisibles ; les utilisateurs les saisissent alors à nouveau (aucune autre donnée n'est perdue).

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
