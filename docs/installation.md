# Installation sur un serveur

Ce guide installe une instance publique de Galley sur un serveur Linux neuf, avec un certificat Let's Encrypt, une sauvegarde quotidienne et la procédure de mise à jour. Pour un essai sur son poste, `docker compose up --build` suffit (voir `README.md`).

Durée : une quinzaine de minutes, dont l'essentiel est le téléchargement de TeX Live. La CI rejoue les étapes 3 à 5 à chaque modification, depuis un clone propre, et vérifie qu'elles tiennent en moins de 15 minutes (voir « Durée mesurée » plus bas).

## 1. Serveur

- Linux 64 bits (Debian 12 ou Ubuntu 24.04 testés), 4 vCPU, 8 Gio de mémoire, 40 Gio de disque au moins. Les besoins détaillés sont dans `docs/operations.md` (« Ressources »).
- Docker Engine 24 ou plus récent avec l'extension Compose v2 : suivre <https://docs.docker.com/engine/install/>, puis vérifier avec `docker compose version`.
- Ports 80 et 443 ouverts en entrée (le port 80 sert à la validation Let's Encrypt et redirige vers 443).
- Sous Ubuntu 23.10 et suivantes, autoriser les espaces de noms utilisateur dont le bac à sable de compilation a besoin :

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-galley-userns.conf
```

## 2. Nom de domaine

Créer chez le fournisseur du domaine un enregistrement `A` (et `AAAA` en IPv6) qui pointe le nom choisi, par exemple `tex.example.org`, vers l'adresse du serveur. Vérifier avant de continuer : `dig +short tex.example.org` doit renvoyer cette adresse. Caddy demande le certificat au premier démarrage ; si le nom ne pointe pas encore sur le serveur, il réessaie seul quelques minutes plus tard.

## 3. Code et configuration

```sh
git clone https://github.com/Maxsime/LaTeX-Editor.git galley
cd galley
scripts/init-env.sh tex.example.org admin@example.org
```

`init-env.sh` crée `.env` à partir de `.env.example` avec des secrets aléatoires (base de données, stockage, jeton interne, clé maître) et l'adresse publique. L'adresse e-mail est celle que Let's Encrypt utilise pour prévenir d'un certificat qui expire. Le fichier n'est lisible que par son propriétaire. **En garder une copie hors du serveur** : la clé maître `GALLEY_MASTER_KEY` n'est pas dans les sauvegardes et sert à relire les clés que les utilisateurs ont enregistrées.

L'API refuse de démarrer si `GALLEY_HOST` désigne autre chose que `localhost` alors qu'un secret garde sa valeur de développement : le journal de l'API nomme alors les variables à changer.

Les autres réglages (quotas, inscription, connexion unique, assistant IA) se font dans `.env`, décrit ligne par ligne, ou plus tard dans la console d'administration.

## 4. Démarrage

```sh
docker compose up --detach --build --wait
```

La commande construit les images, démarre les services et rend la main quand tous sont en bonne santé. Les migrations de la base s'appliquent au démarrage de l'API.

## 5. Premier administrateur

```sh
docker compose logs api | grep setupCode
```

Ouvrir `https://tex.example.org`, qui mène à la page « Créer le compte administrateur », et saisir ce code à usage unique. La console d'administration est ensuite dans le menu « Administration » : comptes, invitations, mode d'inscription, quotas, état des services, modèle d'IA de l'instance.

## 6. Sauvegarde quotidienne

`scripts/backup.sh` sauvegarde l'instance sans l'arrêter : base de données, fichiers stockés, dépôts Git, plus un manifeste. Les sauvegardes de plus de `BACKUP_KEEP_DAYS` jours (14 par défaut) sont supprimées après chaque nouvelle. Le détail, la restauration et les conseils de copie hors site sont dans `docs/operations.md` (« Sauvegarde et restauration »).

Avec systemd, créer `/etc/systemd/system/galley-backup.service` :

```ini
[Unit]
Description=Galley backup
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/srv/galley
ExecStart=/srv/galley/scripts/backup.sh /srv/galley-backups
```

et `/etc/systemd/system/galley-backup.timer` :

```ini
[Unit]
Description=Daily Galley backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
```

puis `sudo systemctl daemon-reload && sudo systemctl enable --now galley-backup.timer`. Remplacer `/srv/galley` par le dossier du clone. Sans systemd, une ligne de `crontab -e` fait de même :

```cron
30 3 * * * cd /srv/galley && scripts/backup.sh /srv/galley-backups >> /var/log/galley-backup.log 2>&1
```

Une sauvegarde qui reste sur le serveur ne protège pas d'une panne de disque : copier le dossier ailleurs (`rsync`, `restic`, stockage objet).

## 7. Mise à jour

```sh
cd /srv/galley
scripts/backup.sh /srv/galley-backups
git pull
docker compose up --detach --build --wait
```

Les migrations de la base s'appliquent au démarrage de la nouvelle version. Lire auparavant la section du jalon concerné dans `docs/decisions.md` lorsqu'une version change la configuration ; `.env.example` montre les variables nouvelles, absentes du `.env` existant, qui gardent alors leur valeur par défaut.

## 8. Retour arrière

Une migration de base ne se défait pas. Pour revenir à la version précédente :

```sh
git log --oneline -5                       # repérer la version d'avant la mise à jour
git checkout <commit>
docker compose up --detach --build --wait
scripts/restore.sh /srv/galley-backups/galley-<date de la sauvegarde d'avant la mise à jour>
```

`restore.sh` refuse une sauvegarde faite par une version plus récente que le code en place. Les modifications faites entre la mise à jour et le retour arrière sont perdues : c'est la raison de la sauvegarde juste avant `git pull`.

## Durée mesurée

La CI (job « Images, compose stack and end-to-end tests ») suit les étapes 3 et 4 depuis le dépôt fraîchement cloné : `init-env.sh`, construction des images, démarrage, attente de la bonne santé de tous les services. Elle échoue au-delà de 15 minutes et écrit la durée dans le résumé du job. Les images applicatives profitent du cache de construction de la CI, pas l'image de compilation, qui domine la durée (téléchargement de TeX Live). Mesure au J10 : 7 minutes environ, dont 3 pour l'image de compilation (détail dans le bilan de `docs/plans/J10.md`). Restent hors mesure les étapes manuelles : installation de Docker, enregistrement DNS, réglage du noyau sous Ubuntu.
