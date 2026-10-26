# Galley — consignes pour Claude Code

Galley est un éditeur LaTeX collaboratif, auto-hébergé, avec assistant IA intégré. Il remplace Prism (ex-Crixet) et vise la parité fonctionnelle avec Overleaf. Le cahier des charges est dans `SPEC.md` : le lire intégralement au premier lancement, puis relire à chaque jalon la section concernée et les sections qu'elle référence.

## Méthode

- Travailler jalon par jalon, dans l'ordre de `SPEC.md` §9. Un jalon ne commence que lorsque le précédent satisfait la définition de « terminé » ci-dessous.
- Au début de chaque jalon, rédiger `docs/plans/JNN.md` (découpage en tâches, fichiers créés ou modifiés, risques, points à trancher) et attendre validation avant de coder.
- Question produit (comportement visible, priorité, compromis fonctionnel) : poser la question. Question technique interne : trancher, consigner, avancer.
- Toute décision qui complète ou modifie la pile imposée (`SPEC.md` §4) est consignée dans `docs/decisions.md` : date, contexte, décision, alternatives écartées.
- En cas de blocage (bibliothèque défaillante, exigence irréalisable telle quelle), le signaler avec deux options argumentées plutôt que contourner en silence.
- Commits atomiques, messages Conventional Commits en anglais (`feat(compiler): ...`).

## Définition de « terminé » (par jalon)

1. `pnpm lint`, `pnpm typecheck`, `pnpm test` et `pnpm test:e2e` passent.
2. Chaque critère d'acceptation du jalon est couvert par au moins un test automatisé.
3. `docker compose up --build` depuis un clone propre démarre l'ensemble sans intervention manuelle.
4. `README.md`, `docs/` et `.env.example` sont à jour.
5. Un bilan est ajouté à `docs/plans/JNN.md` : ce qui fonctionne, ce qui reste, dette technique identifiée.

## Arborescence du dépôt

```
apps/
  web/          SPA React (tableau de bord, éditeur, visionneuse PDF)
  api/          API HTTP Fastify (auth, projets, fichiers, historique, Git, proxy IA)
  collab/       serveur Hocuspocus (Yjs, présence, événements projet)
  compiler/     worker de compilation (TeX Live, bac à sable, SyncTeX)
packages/
  shared/       schémas Zod, types et constantes partagés
  latex-log/    analyseur de journaux LaTeX, Biber, latexmk (pur, sans E/S)
  latex-index/  extraction de structure : plan, labels, citations, commandes définies
  ai/           abstraction fournisseurs, outils, prompts versionnés
  ui/           composants d'interface partagés
fixtures/projects/   corpus de compilation (SPEC §8)
docs/                plans, décisions, exploitation
scripts/             sauvegarde, restauration, maintenance
```

## Commandes (à mettre en place au J0)

```
pnpm install
pnpm dev                              # services applicatifs en watch, dépendances via compose.dev.yml
pnpm lint | pnpm typecheck | pnpm format
pnpm test                             # Vitest (unitaires + intégration via Testcontainers)
pnpm test:e2e                         # Playwright
pnpm --filter compiler test:corpus    # compile tout fixtures/projects/
docker compose up --build             # instance complète
```

## Conventions de code

- TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Pas de `any` ni de `as` sans commentaire justificatif.
- Validation Zod à chaque frontière : requêtes HTTP, messages WebSocket, tâches de file, variables d'environnement. Schémas dans `packages/shared`.
- Identifiants, commentaires et commits en anglais. Textes d'interface exclusivement via i18n (français par défaut, anglais).
- Les commentaires expliquent le pourquoi, pas le quoi. Fonctions exportées documentées en TSDoc.
- Logique métier hors des composants React (hooks, stores, modules purs). Modules purs couverts par des tests unitaires.
- Logs structurés (pino) avec identifiants de requête, d'utilisateur et de projet. Jamais de contenu de document, de clé API ni de jeton dans les logs.
- Erreurs d'API typées : code machine stable et message i18n. Jamais de trace d'exécution renvoyée au client.
- Préférer une bibliothèque maintenue à une réimplémentation. Toute dépendance client de plus de 100 kB (gzip) est justifiée dans `docs/decisions.md`.

## Sécurité (non négociable)

- Toute compilation s'exécute dans le bac à sable de `SPEC.md` §6.3 : sans réseau, sans privilèges, avec limites de temps, mémoire, disque et processus, environnement vidé.
- Chemins : normalisation et rejet côté serveur de toute sortie de la racine du projet (`..`, chemins absolus, liens symboliques), y compris dans les archives zip et les push Git.
- Contrôle d'accès vérifié côté serveur sur chaque route HTTP, chaque connexion et chaque message WebSocket. Le rôle annoncé par le client n'est jamais pris en compte.
- Mots de passe en argon2id. Cookies de session `HttpOnly`, `Secure`, `SameSite=Lax`. Protection CSRF sur toute requête modifiante.
- Clés API des fournisseurs IA chiffrées au repos (AES-256-GCM, clé maître en variable d'environnement), jamais renvoyées au navigateur au-delà des quatre derniers caractères.
- Limites de taille sur les uploads, les archives (taille décompressée et nombre d'entrées), les push Git et les messages WebSocket.
- Secrets uniquement par variables d'environnement ; `.env` jamais versionné.

## Interdits

- Copier du code d'Overleaf (AGPL-3.0). S'inspirer de son comportement est permis, reprendre son code ne l'est pas.
- Désactiver ou ignorer un test pour faire passer la CI.
- Laisser l'assistant IA intégré modifier un fichier sans validation explicite de l'utilisateur.
- Stocker le contenu d'un fichier texte ailleurs que dans son document Yjs (source de vérité unique, `SPEC.md` §6.2).
