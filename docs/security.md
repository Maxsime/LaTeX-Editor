# Sécurité

Ce document décrit le modèle de sécurité de Galley, le bilan de l'audit du 4 novembre 2026 et les risques résiduels connus. Il complète `SPEC.md` §6.3 (bac à sable) et la section « Sécurité » de `CLAUDE.md`.

## Modèle de menace

Galley est exposé sur Internet derrière Caddy. Les acteurs considérés sont :

- un visiteur anonyme, qui ne voit que les pages publiques et les routes de connexion ;
- un utilisateur authentifié malveillant, qui cherche à lire ou modifier les projets d'autrui ;
- un projet LaTeX hostile, qui cherche à sortir du bac à sable de compilation ;
- un site tiers, qui cherche à agir au nom d'un visiteur connecté (CSRF, WebSocket inter-sites) ;
- un composant compromis à l'intérieur de l'instance (image tierce, dépendance), qui cherche à atteindre les données.

## Défenses en place

| Domaine              | Mesure                                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mots de passe        | argon2id (19 MiB, 2 itérations), longueur bornée, temps constant pour un compte inconnu.                                                                                                        |
| Sessions             | Jeton de 256 bits dans le cookie `__Host-galley_session` (`HttpOnly`, `Secure`, `SameSite=Lax`), seule son empreinte en base, rotation à la connexion.                                          |
| CSRF                 | Vérification de l'en-tête `Origin` et jeton par session sur toute requête modifiante.                                                                                                           |
| Force brute          | Limitation de débit par adresse et par compte sur la connexion, par adresse sur l'inscription et la réinitialisation.                                                                           |
| Contrôle d'accès     | Rôle vérifié côté serveur sur chaque route (`loadProject`) et chaque connexion WebSocket ; lecteurs en lecture seule, relecteurs limités aux suggestions.                                       |
| WebSocket            | Origine vérifiée à l'ouverture, taille des trames bornée, identité de présence imposée par le serveur, fermeture des connexions après changement de rôle ou révocation de session.              |
| Compilation          | bubblewrap sans réseau, environnement vidé, `prlimit` (temps, mémoire, processus, taille de fichier), conteneur sans capacité, racine en lecture seule, profil seccomp.                         |
| Fichiers et archives | Rejet de `..`, des chemins absolus et des liens symboliques ; limites de taille, de nombre d'entrées et de taux de compression ; mêmes règles pour les push Git.                                |
| Fichiers servis      | Types inconnus téléchargés, politique `sandbox` sur les types affichés, `nosniff`.                                                                                                              |
| Requêtes sortantes   | Fichiers liés : adresses privées, de bouclage, de liaison locale et réservées refusées, vérifiées à la résolution DNS et à chaque redirection. Synchronisation Git limitée aux hôtes autorisés. |
| Secrets              | Clés de fournisseurs IA et jetons chiffrés en AES-256-GCM ; refus de démarrer avec les secrets de développement sur un nom public.                                                              |
| En-têtes HTTP        | CSP stricte avec nonce, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP et CORP `same-origin`, `frame-ancestors 'none'`.                                                         |
| Réseau Docker        | Bases de données sur un réseau interne inaccessible à Caddy ; seul Caddy publie des ports.                                                                                                      |

## Audit du 4 novembre 2026

L'audit a couvert l'authentification, les sessions, le contrôle d'accès par projet, le bac à sable de compilation, l'import d'archives, les push Git, le stockage objet, le serveur collaboratif, les requêtes sortantes, les en-têtes HTTP, les dépendances (`pnpm audit`) et la configuration Docker.

| N°  | Constat                                                                                                                                                                                                                                                                 | Gravité | Correction                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Une connexion WebSocket ouverte restait active après la déconnexion, la réinitialisation du mot de passe ou la suspension du compte : l'autorisation n'avait lieu qu'à l'ouverture. Un appareil volé ou une session révoquée gardait l'accès en écriture aux documents. | Élevée  | Collab vérifie toutes les 30 s (`COLLAB_SESSION_CHECK_MS`) la validité de la session de chaque connexion et ferme les autres.                            |
| 2   | LanguageTool, image tierce, partageait le réseau des données. Les ports internes de SeaweedFS (filer, volume) y répondent sans authentification : un conteneur compromis pouvait lire ou altérer tous les fichiers.                                                     | Élevée  | LanguageTool est déplacé sur un réseau interne dédié, partagé avec l'API seule.                                                                          |
| 3   | Valkey n'exigeait aucun mot de passe. Il porte la file de compilation, les compteurs de limitation de débit et la diffusion collaborative.                                                                                                                              | Moyenne | Mot de passe `VALKEY_PASSWORD`, généré par `init-env.sh`, refusé à sa valeur de développement sur un nom public.                                         |
| 4   | nodemailer 10.1.0 : trois failles de l'analyseur d'adresses permettant d'ajouter un destinataire (GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h).                                                                                                       | Moyenne | Mise à jour vers 10.1.4.                                                                                                                                 |
| 5   | Le filtre des fichiers liés acceptait les adresses IPv6 qui embarquent une adresse IPv4 (compatibles `::/96`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`), par lesquelles une passerelle peut atteindre un réseau privé.                                                    | Faible  | Plages ajoutées à la liste de refus.                                                                                                                     |
| 6   | Caddy n'impose aucun délai par défaut : un client qui envoie ses en-têtes au compte-gouttes ou garde des connexions inactives monopolise des sockets.                                                                                                                   | Faible  | Délais de lecture des en-têtes (15 s) et d'inactivité (5 min). Corps et réponses restent sans limite pour les téléversements et les flux de l'assistant. |
| 7   | Les réponses de l'instance pouvaient être incluses par un autre site comme image ou script.                                                                                                                                                                             | Faible  | En-tête `Cross-Origin-Resource-Policy: same-origin`.                                                                                                     |

Aucune faille n'a été trouvée dans le contrôle d'accès des routes, la protection CSRF, le traitement des archives et des push Git, ni dans le bac à sable de compilation.

## Risques résiduels et recommandations

- **Changement de mot de passe et sessions actives.** Un utilisateur ne peut pas changer son mot de passe lui-même (seulement par réinitialisation par e-mail ou par un administrateur), ni voir et fermer ses sessions ouvertes. Fonction à ajouter dans « Mon compte ».
- **Ports internes de SeaweedFS.** Le filer et les serveurs de volume restent sans authentification sur le réseau des données, où ne figurent plus que les services de Galley. L'activation de la signature JWT de SeaweedFS (`security.toml`) supprimerait ce risque.
- **Pont Git.** Les routes `/git/*` ne sont pas soumises à la limitation de débit. Les jetons de 256 bits rendent la force brute impossible, mais un clonage répété coûte du calcul.
- **Force brute distribuée.** La limite de connexion est par adresse et par compte : un attaquant disposant de nombreuses adresses n'est pas bloqué. Un verrouillage par compte seul permettrait en retour de bloquer un tiers ; le choix reste à faire.
- **Sauvegardes.** `scripts/backup.sh` produit une copie en clair de la base et des fichiers. Une copie hors du serveur doit être chiffrée (par exemple avec `age` ou `gpg`).
- **Bac à sable.** Le conteneur du compilateur fonctionne sans profil AppArmor et avec `systempaths=unconfined`, nécessaires à bubblewrap (voir `docs/decisions.md`). bubblewrap reste la frontière de confinement ; une faille du noyau dans les espaces de noms utilisateur la contournerait. Maintenir le noyau de l'hôte à jour.
- **Dépendances de développement.** `pnpm audit` signale encore esbuild (via drizzle-kit), minimatch (via ESLint) et glob (via Testcontainers). Ces paquets ne sont pas dans les images de production.
- **Supervision.** Le profil facultatif `monitoring` place Prometheus sur le réseau des données.

## Signaler une faille

Écrire au mainteneur en privé (alerte privée depuis l'onglet « Security » du dépôt GitHub si elle est activée) plutôt qu'ouvrir un ticket public.
