# ASSETS — registre des générations Higgsfield

**Crédits payants dépensés : 0 / 90.** Solde relevé à 10 crédits avant la première génération, après l'image test, après les deux essais 3D et en fin de session : il n'a jamais bougé.

## Test initial (règle 1)

| Étape | Résultat |
|---|---|
| Solde avant | 10 crédits (plan « ultra », essai illimité actif jusqu'au 13/11/2026) |
| Image test | `da_board_1.png`, générée avec `use_unlim: true` |
| Solde après | 10 crédits → l'illimité fonctionne pour les images |
| Téléchargement | OK (`curl` vers `raw-assets/`, 1,8 Mo) |

Constat : l'illimité n'accepte **qu'une génération à la fois**. Un lot de 12 demandes a été refusé pour 11 d'entre elles (`429 rate_limit_reached`, aucun job créé, rien de débité). Les images ont donc été générées une par une, en tâche de fond pendant le développement. En conséquence, **une seule variante par asset** a été générée (au lieu des 3 ou 4 envisagées) : chaque première variante était utilisable, et la file en série aurait bloqué le reste.

Descripteur de style repris dans tous les prompts : *« Stylized low-poly 3D game art, flat-shaded faceted geometry, warm golden-hour lighting, soft shadows, atmospheric haze, restrained palette of deep plum, terracotta, dusty rose, warm sand and teal, with glowing amber-gold reserved for crystal shards. No text, no watermark, no logo. »*

## Images

Le modèle demandé était `nano_banana_pro` (sauf la planche : `nano_banana_2`) ; l'API indique avoir servi `nano_banana_2` / `nano_banana_flash` en illimité.

| # | Fichier source | Sujet du prompt (avant le descripteur de style) | Format | Coût | Fichier produit | Usage | Statut |
|---|---|---|---|---|---|---|---|
| 1 | `raw-assets/da_board_1.png` | Planche de DA : arène circulaire flottante à l'heure dorée, géodes facettées fissurées qui luisent en ambre, silhouettes fantômes sarcelle d'un coureur, plateformes et passerelles | 16:9, 1k | 0 | (référence) | Palette et ambiance, reportées dans `DECISIONS.md` ; modèle de l'arène | **retenu** |
| 2 | `raw-assets/weapon_src_1.png` | Accessoire seul sur fond gris uni, vue 3/4 : blaster à cristal trapu, corps grès, plaques terracotta, poignée prune, bague sarcelle, cœur de cristal ambre | 4:3, 1k | 0 | (référence) | Image source de l'arme ; la conversion 3D a échoué (voir plus bas), l'arme est modélisée en code d'après cette image | **retenu comme référence** |
| 3 | `raw-assets/sky_1.png` | Panorama équirectangulaire 360°, horizon au centre, ciel doré à nuages stylisés, mesas lointaines, pas de disque solaire, brume prune-terracotta en bas | 21:9, 2k | 0 | `public/assets/sky.webp` (4096×2048, 115 Ko), `sky_env.webp` (512×256) | Ciel + environnement de reflets | **retenu** (voir note) |
| 4 | `raw-assets/floor_1.png` | Texture tuilable, vue orthogonale de dessus, éclairage plat, sans ombres : grandes dalles de grès irrégulières à joints sombres | 1:1, 1k | 0 | `public/assets/floor.webp` (1024², 23 Ko) | Sol de toutes les plateformes | **retenu** (raccord 2×2 vérifié, désaturé) |
| 5 | `raw-assets/wall_1.png` | Texture tuilable, vue de face, éclairage plat : mur de gros blocs terracotta-prune, quelques motifs d'anneaux gravés | 1:1, 1k | 0 | `public/assets/wall.webp` (1024², 20 Ko) | Flancs des plateformes | **retenu** |
| 6 | `raw-assets/icons_1.png` | Grille stricte de 20 icônes d'amélioration (5 × 4) sur fond prune uni : balle, cadence, ricochet, perforation, explosions, fantômes, sablier… | 5:4, 2k | 0 | `public/assets/icons.webp` (atlas 640×512, cellules de 128 px) | Icônes du terminal (20 icônes pour une génération) | **retenu** |
| 7 | `raw-assets/title_1.png` | Illustration : vue FPS, blaster visant une géode qui éclate, une douzaine de fantômes sarcelle qui tirent en rythme, ciel calme en haut | 16:9, 2k | 0 | `public/assets/og.jpg` (1200×630), `title.webp` | Image de partage (og:image, README) | **retenu** |

Note sur le ciel : l'image n'est pas réellement raccordée gauche/droite. `scripts/process-assets.mjs` la met en miroir (image + image retournée) pour obtenir un 360° sans couture, puis la ramène en 2:1. Le monde est donc symétrique derrière le joueur ; ça ne se remarque pas en jeu.

Une grille 4 × 4 était prévue ; elle est passée à 5 × 4 parce que le jeu a 17 améliorations (toujours une seule génération).

## Modèles 3D

Preflight (`get_cost: true`, gratuit) sur l'image de la planche :

| Modèle | Coût annoncé | Décision |
|---|---|---|
| `meshy_v7_image_to_3d` (low-poly, 8 000 faces, texturé) | 38 crédits | Impossible : solde de 10 crédits |
| `tripo_p2_image_to_3d` (8 000 faces) | 34 crédits | Impossible : solde de 10 crédits |
| `sam_3_3d` (image → GLB texturé) | 1 crédit | Tenté |

La 3D n'est **pas** couverte par l'illimité, et le solde (10) est bien en dessous du plafond de 90.

| # | Modèle | Entrée | Résultat | Coût |
|---|---|---|---|---|
| 8 | `sam_3_3d`, avec prompt « the blaster pistol » | `weapon_src_1.png` | **Échec du job** côté Higgsfield | 0 (non débité) |
| 9 | `sam_3_3d`, sans prompt | `weapon_src_1.png` | **Échec du job** une seconde fois | 0 (non débité) |

Après deux échecs, repli en procédural comme prévu par la règle : l'arme (`src/player/weapon.ts`) est construite en code à partir de l'image source, avec quatre paliers visuels. Le corps des échos (humanoïde rigué : 34 à 38 crédits) était hors budget dès le preflight : silhouettes procédurales instanciées (`src/echo/echoRenderer.ts`).

## Poids

Assets générés livrés dans `public/assets/` : **environ 370 Ko** (objectif : moins de 5 Mo). Les sources brutes (`raw-assets/`, 23 Mo) sont versionnées pour rester disponibles après la fin de l'essai, mais ne sont pas incluses dans le build.

Interdits respectés : aucune vidéo, aucun 4K, aucun upscale.
