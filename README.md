# Le Multivers

Panel Discord de soirées jeux. Site statique sur GitHub Pages, données et API sur Supabase. Aucun serveur permanent et aucune dépendance JavaScript externe.

## Fonctionnalités

- Connexion Discord via Supabase Auth et PKCE ; renouvellement de session.
- Accueil public : jusqu’à trois prochaines soirées publiées, votes programmés et lien Discord.
- Inscriptions atomiques avec capacité maximale, annulation et un vote par utilisateur et scrutin.
- Page `gestion.html` réservée au rôle Discord `1564000010247475270` du serveur `1187492291892486195`. Chaque requête administrative revérifie le rôle auprès de Discord.
- Édition des soirées : images, descriptions, places, ordre, dates et heures locales converties en UTC, brouillons/publication/annulation.
- Votes : jeux, images, dates et heures d’ouverture/clôture, pourcentages et liste des votants réservés aux gestionnaires.
- Images PNG/JPEG/WebP jusqu’à 3 Mo, téléversées par l’API après autorisation.
- À la première publication, création d’un rôle sans permissions globales et d’un canal vocal privé par soirée. Synchronisation des rôles chaque minute, avec reprise des erreurs et suivi dans la gestion. Les horaires ne garantissent donc pas une exécution à la seconde.

## Installation déjà effectuée

Projet Supabase réutilisé : `ighxdlztzcifezqfxeyv` (ancien nom LS Design). Les tables, politiques RLS, bucket images, tâches cron et API sont installés. La configuration navigateur ne contient qu’une clé publique. Aucune donnée fictive n’est publiée.

## Configuration nécessaire avant ouverture

### 1. Application et bot Discord

Créer une application dans https://discord.com/developers/applications .

- Ajouter cette redirection OAuth2 : `https://ighxdlztzcifezqfxeyv.supabase.co/auth/v1/callback`.
- Inviter son bot sur le serveur `1187492291892486195` avec **Gérer les rôles**, **Gérer les salons**, **Voir les salons** et **Se connecter**. Ne pas lui donner Administrateur.
- Placer son rôle au-dessus des rôles de soirées qu’il créera.
- Dans Supabase > Edge Functions > Secrets, enregistrer `DISCORD_BOT_TOKEN`. Ne jamais le mettre dans GitHub, dans config.js ou dans une conversation.
- Dans Supabase > Authentication > Sign In / Providers > Discord : activer Discord, renseigner le Client ID et le Client Secret.

### 2. Redirections Supabase

Dans Authentication > URL Configuration :

- Site URL : `https://cgasmj-blip.github.io/le-multivers/`
- Redirect URLs : `https://cgasmj-blip.github.io/le-multivers/` et `https://cgasmj-blip.github.io/le-multivers/gestion.html`.

Ne pas activer de connexion anonyme ou d’inscription par email pour cette application Discord.

### 3. GitHub Pages

Le workflow `.github/workflows/pages.yml` publie l’accueil et la page de gestion. Si GitHub exige une activation manuelle, ouvrir Settings > Pages et sélectionner **GitHub Actions** comme source, puis relancer le workflow.

Adresse attendue une fois le déploiement réussi : `https://cgasmj-blip.github.io/le-multivers/`.

## Vérifier avant de lancer les soirées

1. Se connecter avec un membre sans rôle gestionnaire : bouton de gestion absent, API administrative refusée.
2. Se connecter avec un membre portant le rôle autorisé : accès à la gestion.
3. Publier une soirée proche, vérifier le rôle et le canal créés, puis s’inscrire.
4. Vérifier l’attribution dans la minute du début et le retrait après la fin ou une désinscription.
5. Tester un vote, modifier son choix et contrôler les résultats depuis la gestion.

Le retrait du rôle ferme l’accès futur au canal. Discord peut laisser un membre déjà connecté dans le vocal : les animateurs peuvent le déconnecter à la fin si nécessaire. Les administrateurs du serveur gardent leurs permissions Discord habituelles.

## Structure et développement

`index.html`, `gestion.html`, `app.js`, `style.css`, `config.js`, `assets/` : site public.

`supabase/functions/multivers-api/index.ts` : API Edge sans dépendances ; vérifie la session via `/auth/v1/user` et le rôle via l’API Discord. `verify_jwt=false` sur la passerelle est intentionnel : la fonction réalise elle-même l’authentification des utilisateurs et du cron.

`schema.sql` et `roles-due.sql` documentent les migrations déjà appliquées. Ne pas les réexécuter sur le projet installé. `tests/database.sql` teste les contraintes dans une transaction annulée.

Vérification locale : `node --check app.js`, `node --test tests/api.test.cjs` ; aperçu avec `python3 -m http.server 8000`. Les redirections locales doivent être autorisées séparément pour tester OAuth localement.

## Limites et maintenance

Les images téléversées sont publiques. Les participations, identifiants Discord et votes détaillés ne sont accessibles qu’à leur utilisateur via l’API ou aux gestionnaires autorisés. Aucun accès direct en écriture aux tables n’est accordé au navigateur. La synchronisation traite jusqu’à 50 changements de rôle par minute ; les erreurs Discord restent visibles et sont réessayées. Les ressources Discord créées restent sur le serveur après la soirée ; les inscriptions annulées sont conservées pour retirer les rôles et assurer le suivi.

## Ajouts communautaires

- Canaux permanents dans la catégorie événements : Rappels, Jeu gagnant, Planning, Bilans des soirées. Le canal Suggestions de jeux existant est réutilisé.
- Rappels : une notification des inscrits dans les 30 minutes avant le début, avec lien du vocal. Déduplication par soirée.
- Résultats : annonce à la clôture d’un vote, pourcentages et gestion des égalités ; aucune annonce de gagnant sans vote.
- Planning : le dimanche à 18 h Europe/Paris, soirées de la semaine et jeux proposés au vote. Déduplication par dimanche.
- Absences : seuls les statuts `absent` explicitement renseignés comptent. Chaque groupe de trois absences non excusées déclenche sept jours de blocage des nouvelles inscriptions. Les votes restent accessibles. Une correction qui ramène le total sous le seuil retire le blocage correspondant. L’expiration ne redéclenche pas la même sanction.
- Bilans : message permanent dans Bilans des soirées après une fin manuelle. Le bouton ouvre un formulaire Discord (note de 1 à 5 et commentaire destiné aux animateurs), réservé aux inscrits. Les avis se consultent dans la tuile Bilans des soirées du panel.
- `/equipes nombre:2` : à utiliser dans le chat du vocal, en étant connecté à ce vocal. Répartition écrite des membres actuellement connectés, bots exclus, sans déplacement. Le bot prend un instantané via une courte connexion Gateway puis se déconnecte. Limitation à un tirage par minute sur le serveur et protection du quota de connexions Discord.

`supabase/functions/multivers-interactions/index.ts` valide les signatures Ed25519 et les timestamps Discord avant de répondre aux commandes et formulaires. Le token reste uniquement dans les secrets Supabase. La clé publique de vérification est obtenue depuis l’application Discord puis stockée dans les réglages, accessibles uniquement au serveur.

L’endpoint d’interactions est configuré sur l’application Discord et la commande est enregistrée au niveau du serveur. Une session Gateway reprenable est désormais pilotée par `multivers-voice`, relancée chaque minute par un cron privé. Elle suit les arrivées et départs des vocaux, conserve son identifiant de session et sa séquence entre les exécutions et évite les identifications répétées. Une courte interruption lors d’une reprise peut retarder une création ; les événements sont rejoués par Discord.

Tests : `node --test tests/api.test.cjs tests/interactions.test.cjs`.

## Badges et vocaux temporaires

- `/profil` affiche ses badges avec cinq émojis personnalisés ; `/profil membre:@pseudo` consulte ceux d’un autre membre. Réponse publique sans notification de mention.
- Quatre badges automatiques : 1 soirée, 5 soirées, 5 jeux différents, 20 soirées. Seules les inscriptions marquées présent, sur une soirée publiée commencée, non annulée et hors test comptent. Les corrections recalculent la collection et les rôles.
- Le rôle Fondateur `1187492291947012126`, vérifié auprès de Discord, débloque les cinq badges. Seuls ses membres attribuent ou retirent Cœur du Multivers depuis le panel. Les écritures sont journalisées.
- Cinq rôles de badges sans permissions et cinq émojis sont enregistrés dans `mv_badge_discord`. Synchronisation dans le cron existant, et immédiatement après un pointage ou une attribution manuelle ; les échecs Discord sont réessayés au prochain passage.
- Dans les 14 catégories de jeux strictement entre Événements et Assistance, rejoindre `➕・Créer un vocal` crée un salon dans la même catégorie avec ses permissions héritées puis y déplace le membre. Le salon est supprimé quand sa dernière personne quitte. Les salons existants hors gestion Multix ne sont jamais supprimés.
- `mv_voice_launchers`, `mv_temporary_voices`, `mv_voice_presence`, `mv_gateway_session` sont exclusivement accessibles au service. `multivers-voice` vérifie le secret du cron avant chaque opération. Le token Discord reste dans les secrets Edge, sans copie en base ou dans GitHub.
- Les fichiers `temporary-voice.sql` et `badge-discord-roles.sql` documentent les migrations installées ; ne pas les rejouer sur une base déjà configurée. Tests : `node --test tests/*.test.cjs`.

## Filtre de mot Multix

La règle AutoMod `Multix · Filtre bewte` bloque les nouveaux messages et leurs modifications avant publication, avec une explication taquine privée. Le filtre couvre les variantes courantes : casse, accents, répétitions, substitutions de chiffres, séparateurs, caractères invisibles et plusieurs alphabets stylisés. Aucune détection textuelle ne couvre toutes les substitutions imaginables ni le texte dans les images. Les anciens messages ne sont pas purgés.

Le worker reçoit `AUTO_MODERATION_ACTION_EXECUTION` via l’intent non privilégié `AUTO_MODERATION_EXECUTION`. Une réponse légère est envoyée dans le salon en mentionnant uniquement l’auteur ; déduplication persistante des seuls événements rejoués par Discord, sans limite de fréquence ajoutée par Multix. Les autres règles AutoMod ne déclenchent aucune réplique. Aucun contenu de message n’est enregistré par cette fonction. Discord exempte nativement les administrateurs et les membres avec Gérer le serveur, ainsi que les bots, des règles AutoMod.
