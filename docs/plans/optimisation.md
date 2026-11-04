# Optimisation et robustesse (après J11)

Demande du 2026-11-04 : alléger le code (« compression ») et le fiabiliser (« robustesse »). Les sujets de sécurité sont traités à part. Décisions détaillées dans `docs/decisions.md` (2026-11-04).

## Audit

| Constat | Mesure | Suite |
| --- | --- | --- |
| Module initial du client | 649 kB, 199 kB gzip | chargement par page |
| Aucune limite d'erreur React | écran blanc sur erreur de rendu | page d'erreur du routeur |
| Onglet ouvert pendant une mise à jour | morceaux introuvables | rechargement unique |
| Compression des assets à la volée | gzip seul, à chaque requête | précompression brotli, zstd, gzip |
| Source maps dans l'image Caddy | 9,8 Mo sur 15 Mo | mode `hidden`, retirées de l'image |
| Erreurs Valkey et BullMQ sans écouteur | console non structurée à chaque reconnexion | `logConnectionErrors` |
| Arrêt des services sans délai maximal | processus à moitié arrêté possible | `handleProcessLifecycle` |
| Promesses flottantes dans le worker de compilation | rejet non géré, arrêt du processus | erreurs interceptées et journalisées |

Déjà en place et conservé : construction multi-étapes, dépendances de production seules dans les images, `encode zstd gzip`, cache immuable des assets hachés, délais sur les appels sortants (collab, IA, LanguageTool, bibliographie).

## Tâches

1. `packages/shared/src/node/lifecycle.ts` et tests ; branchement dans `apps/api`, `apps/collab`, `apps/compiler`.
2. `apps/web/src/router.tsx` : pages chargées à la demande, `defaultErrorComponent`.
3. `apps/web/src/lib/stale-chunk.ts` et tests, `components/RouteError.tsx`, écoute de `vite:preloadError`.
4. `apps/web/scripts/precompress.mjs`, `infra/caddy/Dockerfile`, `infra/caddy/Caddyfile`.
5. Test de bout en bout `e2e/tests/home.spec.ts` (« static assets »).

## Bilan

Fonctionne : les tests unitaires des modules purs (cycle de vie, version périmée) et le test de bout en bout des assets (brotli, cache, absence des cartes, 404 sur asset inconnu, éditeur absent de la page d'état). Vérifié à la main en aperçu Vite : connexion et page d'état s'affichent, sans erreur, sans charger le code de l'éditeur.

Reste : la langue non utilisée est toujours embarquée (17 kB gzip) ; le module PDF (182 kB gzip) et KaTeX (78 kB gzip) pourraient être préchargés pendant l'inactivité de la page de projet plutôt qu'à la première ouverture.

Dette : la précompression ajoute une dizaine de secondes à la construction de l'image Caddy.
