# Musique de Multix

Le service joue les fichiers audio joints à une commande et les flux radio HTTPS directs configurés par le serveur. Les commandes du Multivers sont `/play fichier:…`, `/play radio:…`, `/pause`, `/resume`, `/skip`, `/stop` et `/queue`. Les fichiers audio sont limités à 25 Mo et la file à 10 titres en attente. La personne qui utilise les commandes doit être dans le même vocal que Multix. Multix quitte le vocal quand la dernière personne part ou après 30 secondes sans musique.

1. Héberger ce Dockerfile comme un service toujours actif. L’hébergeur doit autoriser les connexions HTTPS et UDP sortantes et fournir une adresse HTTPS publique qui relaie le port HTTP 8080.
2. Renseigner `DISCORD_BOT_TOKEN` avec le token existant de Multix dans les secrets de l’hébergeur, `DISCORD_PUBLIC_KEY` avec la clé publique de son application Discord et `DISCORD_GUILD_ID` avec `1187492291892486195`. Le service enregistre ses commandes sur ce serveur au démarrage.
3. Dans Supabase, configurer le secret Edge `MULTIX_MUSIC_URL` avec l’adresse HTTPS du service suivie de `/discord`. L’endpoint d’interactions existant relaie uniquement les commandes musique avec leur signature Discord d’origine. Le service vérifie cette signature à son tour. `GET /health` permet de vérifier que le bot est connecté.
4. Donner à Multix **Se connecter** et **Parler** dans les vocaux concernés. Rejoindre un vocal et lancer `/play` avec un fichier MP3 pour vérifier la lecture.

Pour ajouter des radios, définir le secret facultatif `MUSIC_RADIOS_JSON` sous la forme `{"Nom de la radio":"https://example.org/live.mp3"}`, avec les flux directs autorisés par leurs diffuseurs. Les liens redirigés et les playlists HLS ne sont pas pris en charge.

Pour lancer le service localement, utiliser Node.js 22.12 ou ultérieur et FFmpeg avec libopus. Exécuter `npm ci`, puis `npm start` avec les mêmes variables d’environnement. L’adresse de relais doit rester joignable en HTTPS pour que les commandes Discord fonctionnent.
