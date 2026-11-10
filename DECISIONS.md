# DECISIONS — choix de design et de technique

Décisions prises seul pendant la session, avec leur raison. Les nombres d'équilibrage sont dans `src/config.ts`.

## Direction artistique

Palette tirée de la planche de DA (`raw-assets/da_board_1.png`) :

| Rôle | Couleur | Hex |
|---|---|---|
| Ombres, fonds d'interface | prune | `#2B1830` |
| Roche sombre, dessous des îles | prune clair | `#4A2A45` |
| Géodes, accents de pierre | terracotta | `#B65A3C` |
| Pierre éclairée | rose poussière | `#D49278` |
| Sol, arme | sable | `#ECC898` |
| Texte, ciel | crème | `#F7E3B8` |
| **Réservée aux échos** | sarcelle | `#3FC9B0` |
| **Accent réservé aux éclats** | ambre | `#FFB81F` |

- **Chaud et clair plutôt que bleu nuit.** Heure dorée, brume rose, îles flottantes : la première capture ne ressemble pas à un idle game générique.
- **Le bloom ne réagit qu'au HDR.** Seuil à 1,0 : seuls les cœurs de géodes, les éclats, les tirs et le minuteur dépassent. Les échos restent sous le seuil, donc 40 copies ne saturent jamais l'écran.
- **Tout est procédural sauf 5 images** (ciel, sol, mur, icônes, image de partage). Le jeu reste lisible si ces images manquent.

## Design

- **Le pattern de géodes est le même à chaque boucle** (graine fixe). On apprend le pattern et on optimise un trajet, comme un contre-la-montre. Il ne change que quand une amélioration d'arène est achetée.
- **Rembobinage au point de départ.** À la fin de la boucle, la caméra est ramenée au départ. Ça vend la boucle temporelle et rend les trajets comparables. Coût accepté : un téléport toutes les 12 s.
- **Les éclats non ramassés sont perdus à la fin de la boucle.** C'est ce qui donne un vrai rôle à l'aimant et oblige à se déplacer. Le jeu l'explique (bannière, info-bulle, message si plus d'un quart du butin reste au sol).
- **Un écho garde le rendement de sa boucle d'origine.** Améliorer l'arme ne dope pas les anciens échos : il faut ré-enregistrer. C'est ce qui garde le jeu actif utile. Seuls la Puissance des échos et les Fragments s'appliquent à tous.
- **Un écho rapporte 6 % du butin de sa boucle par rejeu** (au départ). Valeur imposée par la simulation : à 22 %, les échos dépassaient le jeu actif dès la 2ᵉ minute.
- **Les échos sont décalés dans le temps.** La boucle du joueur dure 12 s + 1,1 s de rembobinage, celle d'un écho 12 s : ils se décalent naturellement et forment une procession le long du trajet, au lieu de se superposer.
- **Géodes fantômes.** Chaque écho tire dans sa propre phase : on ne voit ses géodes qu'un instant, en fil de fer sarcelle, quand il les touche ou les casse.
- **Terminal réellement diégétique.** L'écran est une texture dans le monde ; on vise une ligne avec le viseur et on clique. Pas de pointeur à libérer, et ça marche au tactile (toucher une ligne).
- **Familles d'améliorations.** J'ai ajouté « Puissance » (dégâts) à l'arme et « Densité » à l'arène, et rangé « Mémoire longue » (plafond hors ligne) dans la famille Boucle.
- **Prestige.** Fragments = ⌊√(éclats de la partie / 9 M)⌋, minimum 5 pour déclencher, +20 % de gains par Fragment. Les 3 bonus proposés sont tirés de façon déterministe (pas de re-tirage en rechargeant) et se cumulent.
- **Tutoriel en 11 objectifs**, du premier tir à l'Effondrement, plutôt que seulement les 3 premières minutes : il y a toujours un prochain but affiché.

## Technique

- **Stack : Vite + TypeScript strict + Three.js r170**, sans moteur de jeu. Three.js donne l'instancing, le post-traitement et les ombres ; écrire un moteur n'aurait rien apporté de visible.
- **Simulation de boucle pure et déterministe** (`src/echo/loopsim.ts`), sans dépendance au rendu. Le jeu en direct et le rejeu passent par la même classe, alimentée par les mêmes données **quantifiées avant usage** (positions à 2 cm, angles à 0,1 mrad, tirs à la milliseconde). Un enregistrement redonne donc exactement le même butin, ce que les tests vérifient sur 8 jeux de paramètres.
- **Les échos ne simulent rien à l'affichage.** `replay()` calcule une fois la liste d'événements ; l'affichage interpole la pose (20 Hz) et rejoue les événements.
- **Rendu instancié et poolé** : géodes (2 draw calls), éclats (640), débris, tirs, ondes de choc, corps des échos (4 draw calls pour 40 échos). Aucune allocation dans les boucles chaudes de ces systèmes.
- **Pas d'occlusion par le décor pour les tirs.** Un tir traverse les plateformes. L'arène est ouverte, le cas est rare, et le déterminisme reste simple.
- **Collisions par formes logiques** (disques, anneau, rampes) plutôt que par maillage : suffisant pour cette arène, et utilisable tel quel par le bot de simulation.
- **Sauvegarde** : JSON versionné dans `localStorage`, migration tolérante (tout champ invalide reprend sa valeur par défaut), export/import en texte `ECHO1:…`. Les enregistrements des échos sont dans la sauvegarde (environ 10 Ko par écho).
- **Hors ligne** : calculé depuis l'horodatage de la dernière sauvegarde, plafonné. Un onglet resté en arrière-plan est traité comme une absence. Toute absence est créditée ; l'écran de retour ne s'affiche qu'au-delà d'une minute.
- **Son 100 % procédural** (Web Audio), aucune dépendance ni fichier audio.

## Équilibrage (simulation)

`npm run sim` fait jouer un bot « joueur moyen » (75 % de précision, 0,35 s de réaction, 80 % de la vitesse) qui enregistre de vraies boucles dans la simulation et achète par rapport gain/coût. Résultat final sur 3 graines :

| Graine | 1ᵉʳ achat | Plus long trou sans achat (15 premières min) | 1ᵉʳ Effondrement | Zone | Échos | Échos / actif max (10 premières min) |
|---|---|---|---|---|---|---|
| 11 | 12 s | 1 min 38 | 38 min 23 | 3 | 21 | 0,76 |
| 23 | 12 s | 1 min 31 | 35 min 25 | 3 | 21 | 0,74 |
| 37 | 12 s | 1 min 31 | 38 min 45 | 3 | 21 | 0,66 |

Avant réglage, le prestige arrivait entre 17 et 21 min et les échos rapportaient jusqu'à 5,5 fois le jeu actif. Principaux changements : efficacité des échos 22 % → 6 %, emplacements et puissance des échos plus chers, croissance des coûts d'arme relevée, diviseur du prestige porté à 9 M. Rayon d'aimant de base relevé ensuite de 6 à 7,5 m après le premier essai en jeu (trop d'éclats perdus à la première boucle) ; la simulation passe toujours.

Limite de ce chiffre : c'est un bot, pas un joueur. Un bon joueur ira plus vite.

## Relecture indépendante

Trois relecteurs séparés (logique, performance, conformité au cahier des charges) ont relu le code. Corrigé à la suite : angle de visée non normalisé à l'amarrage au terminal, absences de moins d'une minute non créditées, écran hors ligne d'une ancienne partie affiché sur une nouvelle, panneau de pause périmé après un import, écho fantôme après un import pendant le rembobinage, tir tactile bloqué après un `touchcancel`, achats involontaires au terminal sur tactile, effets affichés qui ignoraient les bonus permanents, animation de l'arme jouée hors champ, MSAA ×4 ramené à ×2 avec résolution adaptative, écran du terminal redessiné inutilement.

Non traité, par choix : fusion des petits meshes de décor (piédestaux, pads), regroupement des relances d'animation CSS du HUD. Impact mesuré négligeable à 60 fps.

## Ce qui a été coupé ou n'a pas marché

- **Modèles 3D générés** : hors budget ou en échec (détail dans `ASSETS.md`). Arme et échos sont procéduraux.
- **Variantes d'images** : une seule par asset, la file illimitée n'acceptant qu'un job à la fois.
- **Dépôt GitHub et lien jouable** : la création du dépôt public a été refusée par le garde-fou de permissions de la session. Le workflow de déploiement est prêt ; il reste à créer le dépôt et pousser (commandes dans le README).
