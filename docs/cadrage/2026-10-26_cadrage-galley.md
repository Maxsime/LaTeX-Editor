# Cadrage du projet Galley — conversation du 26 octobre 2026

Trace de la conversation avec Claude ayant produit `CLAUDE.md` et `SPEC.md`. À conserver dans `docs/` du dépôt.

## Demande initiale

Créer un prompt ou un contexte pour développer une application de type Crixet/Prism, en prévision de la fermeture de Prism. Objectif : une application aussi complète que Prism ou Overleaf.

## Rappel sur Prism

- Lancé par OpenAI le 27 janvier 2026, construit sur Crixet, plateforme LaTeX en ligne rachetée par OpenAI. Crixet n'est plus proposé séparément.
- Espace de travail LaTeX en ligne, gratuit avec un compte ChatGPT, projets et collaborateurs illimités, aucune installation LaTeX locale.
- Assistant IA (GPT-5.2) intégré au projet, avec accès à la structure du document, aux équations, aux références et au contexte.
- Fonctions notables : collaboration temps réel avec commentaires, recherche et intégration de littérature (arXiv), génération de la bibliographie, conversion d'équations ou de schémas de tableau blanc en LaTeX/TikZ, création et réécriture d'équations, citations et figures.

Sources : annonce OpenAI « Introducing Prism » (openai.com/blog/introducing-prism), Engadget, The Decoder, IT Daily.

## Décisions de cadrage

| Question | Choix retenu |
|---|---|
| Déploiement | Web auto-hébergé (Docker Compose sur PC ou VPS, accès navigateur) |
| Collaboration | Temps réel complète : curseurs partagés, commentaires, suivi des modifications, historique |
| Assistant IA | Multi-fournisseur : Anthropic, OpenAI, Mistral, modèle local via Ollama ; clé fournie par l'utilisateur |
| Outil de développement | Claude Code, piloté par un `CLAUDE.md` et une spécification découpée en jalons |

Nom de code retenu : Galley (à renommer librement).

## Livrables

- `CLAUDE.md` : règles permanentes de l'agent (méthode jalon par jalon, définition de « terminé », arborescence du dépôt, commandes, conventions de code, règles de sécurité, interdits).
- `SPEC.md` : cahier des charges (exigences P0/P1/P2, pile technique imposée, architecture, points de conception, exigences non fonctionnelles, corpus de compilation, jalons J0 à J11 avec critères d'acceptation, hors périmètre).

Les deux fichiers se placent à la racine d'un dépôt vide.

## Premier message à envoyer dans Claude Code

```
Lis CLAUDE.md puis SPEC.md en entier. Rédige le plan du jalon J0 dans docs/plans/J00.md et attends ma validation avant de coder.
```

## Recommandations

- Si la fermeture de Prism est proche, viser d'abord J0 à J4 : remplaçant solo utilisable (éditeur, compilation, PDF, SyncTeX). Collaboration et IA ensuite.
- Point technique le plus risqué : le bac à sable de compilation au J3 (`SPEC.md` §6.3). Bubblewrap dans Docker dépend des réglages seccomp et AppArmor de l'hôte ; un repli par conteneur éphémère est prévu.
- Solution de transition : Overleaf Community Edition auto-hébergé en Docker, opérationnel rapidement, sans IA et sans les fonctions réservées à Server Pro.
