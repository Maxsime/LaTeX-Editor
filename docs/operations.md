# Exploitation

Ce document rassemble ce qu'un administrateur doit savoir pour faire tourner une instance. L'architecture est décrite dans `docs/architecture.md`.

## Ressources

- Disque : l'image du worker de compilation (TeX Live complet) occupe environ 7,5 Gio ; le premier `docker compose up --build` télécharge environ 2,6 Gio pour elle seule. Prévoir en plus les répertoires de travail des compilations (volume `compile-work`, 20 Gio au plus par défaut, `COMPILER_WORK_QUOTA_MB`), la base, le stockage objet et les dépôts Git des projets (volume `git-data`, de la taille des projets à peu près ; il se reconstruit depuis les projets s'il est perdu, mais les clones existants devront alors être refaits).
- Mémoire : chaque compilation peut utiliser jusqu'à `COMPILER_MEMORY_MB` (2 Gio) par processus ; compter au moins 2 Gio par compilation simultanée (`COMPILER_CONCURRENCY`, 2 par défaut) en plus des autres services.

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
