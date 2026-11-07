import { createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { get as httpsGet } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { Readable, pipeline } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, ActivityType, Routes } from 'discord.js';
import { AudioPlayerStatus, VoiceConnectionStatus, StreamType, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel } from '@discordjs/voice';

const { DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY, DISCORD_GUILD_ID, PORT = '8080' } = process.env;
if (!DISCORD_BOT_TOKEN || !/^[a-f0-9]{64}$/i.test(DISCORD_PUBLIC_KEY ?? '') || !/^\d{17,20}$/.test(DISCORD_GUILD_ID ?? '')) {
  throw new Error('Renseigner DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY et DISCORD_GUILD_ID.');
}

const stations = new Map(Object.entries(JSON.parse(process.env.MUSIC_RADIOS_JSON ?? '{}')));
for (const [name, address] of stations) {
  const url = new URL(address);
  if (!name.trim() || name.length > 100 || url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Chaque radio configurée doit avoir un nom et une URL HTTPS directe.');
  }
}
const publicKey = createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(DISCORD_PUBLIC_KEY, 'hex')]),
  format: 'der', type: 'spki',
});
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const commands = [
  { name: 'play', description: 'Joue un lien audio, une vidéo YouTube ou un fichier', options: [
    { type: 3, name: 'lien', description: 'Lien YouTube ou lien direct vers un fichier audio ou un flux radio' },
    { type: 11, name: 'fichier', description: 'Fichier audio à lire' },
  ] },
  { name: 'pause', description: 'Met la musique en pause' },
  { name: 'resume', description: 'Reprend la lecture' },
  { name: 'skip', description: 'Passe au morceau suivant' },
  { name: 'stop', description: 'Arrête la musique et quitte le vocal' },
  { name: 'queue', description: 'Affiche le morceau en cours et la file' },
];
const names = new Set(commands.map(command => command.name));
const DJ_NAME = 'DJ Multix · Fréquences galactiques';
const allowedFormats = /\.(mp3|ogg|opus|wav|flac|m4a|aac|webm)$/i;
let session;
let serial = Promise.resolve();
let pendingCommands = 0;

function schedule(task) {
  const result = serial.then(task);
  serial = result.catch(() => {});
  return result;
}

async function youtubeTitle(track) {
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.search = new URLSearchParams({ url: track.url, format: 'json' });
  try {
    const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(1500) });
    if (!response.ok) return;
    const data = await response.json();
    if (typeof data.title === 'string' && data.title.trim()) track.name = data.title.trim().slice(0, 200);
  } catch {}
}

async function updateMusicCard(current, status, track = current.track) {
  if (!track) return;
  const active = status === 'En lecture' || status === 'En pause';
  const embed = {
    color: status === 'En lecture' ? 0x8758ff : status === 'En pause' ? 0xf4b942 : 0x657086,
    author: { name: track.requester, ...(track.requesterAvatar ? { icon_url: track.requesterAvatar } : {}) },
    title: track.name.slice(0, 256),
    description: '**' + status + '** dans <#' + current.channel.id + '>',
    footer: { text: 'DJ Multix · Fréquences galactiques' },
    timestamp: new Date().toISOString(),
  };
  if (track.youtubeId) {
    embed.url = track.url;
    embed.thumbnail = { url: 'https://i.ytimg.com/vi/' + track.youtubeId + '/hqdefault.jpg' };
  } else {
    const avatar = client.user?.displayAvatarURL();
    if (avatar) embed.thumbnail = { url: avatar };
  }
  const body = { embeds: [embed], allowed_mentions: { parse: [] } };
  try {
    if (current.card) {
      try {
        await client.rest.patch(Routes.channelMessage(current.card.channelId, current.card.id), { body });
        return;
      } catch (error) {
        if (error.code !== 10008) throw error;
        current.card = undefined;
      }
    }
    if (active) {
      const message = await client.rest.post(Routes.channelMessages(track.textChannelId), { body });
      current.card = { id: message.id, channelId: track.textChannelId };
    }
  } catch (error) {
    console.warn('Carte musique indisponible', error.code ?? error.name);
  }
}

async function stopMusic(current) {
  if (session !== current) return;
  session = undefined;
  client.user?.setActivity(null);
  clearTimeout(current.idleTimer);
  current.track?.abort.abort();
  current.player.stop(true);
  if (current.connection.state.status !== VoiceConnectionStatus.Destroyed) current.connection.destroy();
  if (current.card && current.track) await updateMusicCard(current, 'Lecture arrêtée');
}

function armIdle(current) {
  clearTimeout(current.idleTimer);
  current.idleTimer = setTimeout(() => {
    void schedule(() => {
      if (session === current && !current.track) return stopMusic(current);
    });
  }, 30_000);
}

const nonPublic = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) nonPublic.addSubnet(address, prefix);
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) nonPublic.addSubnet(address, prefix, 'ipv6');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

function isPublicAddress(address, family) {
  if (family === 4) return !nonPublic.check(address);
  return family === 6 && globalV6.check(address, 'ipv6') && !nonPublic.check(address, 'ipv6');
}

function httpsAudioUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Colle un lien HTTPS complet.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('Choisis un lien HTTPS public.');
  }
  return url;
}

async function openPublicAudio(value, signal, redirects = 0) {
  const url = httpsAudioUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
    throw new Error('Le lien ne pointe pas vers une adresse publique.');
  }
  signal.throwIfAborted();
  const { address, family: resolvedFamily } = addresses[0];
  const response = await new Promise((resolve, reject) => {
    // Keep the checked address pinned for the connection, including after a redirect.
    const request = httpsGet(url, {
      signal, agent: false, family: resolvedFamily,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family: resolvedFamily }]);
        else callback(null, address, resolvedFamily);
      },
    }, resolve);
    request.once('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy();
    if (redirects >= 3 || !response.headers.location) throw new Error('Lien redirigé trop souvent.');
    return openPublicAudio(new URL(response.headers.location, url), signal, redirects + 1);
  }
  const type = response.headers['content-type'] ?? '';
  if (response.statusCode !== 200 || !/^(?:audio\/|video\/|application\/octet-stream(?:;|$))/i.test(type)) {
    response.destroy();
    throw new Error('Ce lien ne fournit pas un flux audio ou vidéo direct.');
  }
  return response;
}

function openYouTubeAudio(url, abort) {
  const process = spawn('yt-dlp', [
    '--ignore-config', '--no-playlist', '--no-progress', '--js-runtimes', 'node',
    '--socket-timeout', '10', '-f', 'bestaudio', '-o', '-', '--', url,
  ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  process.once('error', () => process.stdout.destroy());
  abort.signal.addEventListener('abort', () => process.kill('SIGKILL'), { once: true });
  return process.stdout;
}

async function playNext(current) {
  if (session !== current) return;
  const previousTrack = current.track;
  previousTrack?.abort.abort();
  current.track = undefined;
  while (current.queue.length) {
    const item = current.queue.shift();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10_000);
    try {
      let input;
      if (item.youtube) {
        input = openYouTubeAudio(item.url, abort);
      } else if (item.direct) {
        input = await openPublicAudio(item.url, abort.signal);
      } else {
        const response = await fetch(item.url, { signal: abort.signal, redirect: 'error' });
        if (!response.ok || !response.body) throw new Error('Source indisponible');
        input = Readable.fromWeb(response.body);
      }
      clearTimeout(timeout);
      const ffmpeg = spawn('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe',
        '-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'ignore'] });
      abort.signal.addEventListener('abort', () => ffmpeg.kill('SIGKILL'), { once: true });
      const track = { ...item, abort };
      const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus, metadata: track });
      current.track = track;
      clearTimeout(current.idleTimer);
      ffmpeg.once('error', () => {
        if (session === current && current.track === track) current.player.stop(true);
      });
      pipeline(input, ffmpeg.stdin, () => {});
      current.player.play(resource);
      await entersState(current.player, AudioPlayerStatus.Playing, item.youtube ? 30_000 : 8_000);
      if (track.youtube) await youtubeTitle(track);
      await updateMusicCard(current, 'En lecture');
      return true;
    } catch {
      current.track = undefined;
      current.player.stop(true);
      abort.abort();
    } finally {
      clearTimeout(timeout);
    }
  }
  if (current.card && previousTrack) await updateMusicCard(current, 'Lecture terminée', previousTrack);
  armIdle(current);
  return false;
}

async function connect(channel) {
  const connection = joinVoiceChannel({
    channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  const player = createAudioPlayer();
  const current = { connection, player, channel, queue: [], track: undefined, idleTimer: undefined };
  session = current;
  connection.subscribe(player);
  player.on('stateChange', (previous, next) => {
    if (next.status !== AudioPlayerStatus.Idle || !previous.resource) return;
    void schedule(async () => {
      if (session === current && current.track === previous.resource.metadata) await playNext(current);
    });
  });
  player.on('error', error => console.warn('Lecture audio interrompue', error.name));
  connection.on('error', () => { void schedule(() => stopMusic(current)); });
  connection.on(VoiceConnectionStatus.Disconnected, () => { void schedule(() => stopMusic(current)); });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 12_000);
    client.user.setActivity(DJ_NAME, { type: ActivityType.Listening });
  } catch {
    await stopMusic(current);
    throw new Error('Multix n’a pas réussi à rejoindre le vocal.');
  }
  return current;
}

function youtubeItem(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Colle un lien vers une vidéo YouTube.'); }
  const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'];
  let videoId;
  if (url.protocol === 'https:' && !url.username && !url.password && !url.port) {
    if (url.hostname === 'youtu.be') {
      videoId = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    } else if (hosts.includes(url.hostname)) {
      videoId = url.pathname === '/watch' ? url.searchParams.get('v')
        : /^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    }
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId ?? '')) {
    throw new Error('Colle un lien HTTPS vers une vidéo YouTube.');
  }
  return { name: 'YouTube · ' + videoId, url: 'https://www.youtube.com/watch?v=' + videoId, youtube: true, youtubeId: videoId };
}

function linkItem(value) {
  const url = httpsAudioUrl(value);
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)) {
    return youtubeItem(url.href);
  }
  if (url.hostname === 'open.spotify.com' || url.hostname === 'spotify.link') {
    throw new Error('Ce lien Spotify n’est pas un flux audio direct. Essaie le lien YouTube du morceau ou joins un fichier.');
  }
  return { name: 'Lien audio · ' + url.hostname, url: url.href, direct: true };
}

function getItem(interaction) {
  const options = interaction.data.options ?? [];
  const fileId = options.find(option => option.name === 'fichier')?.value;
  const radio = options.find(option => option.name === 'radio')?.value;
  const youtube = options.find(option => option.name === 'youtube')?.value;
  const link = options.find(option => option.name === 'lien')?.value;
  if ([fileId, radio, youtube, link].filter(Boolean).length !== 1) throw new Error('Choisis un lien ou un fichier audio.');
  if (link) return linkItem(link);
  if (youtube) return youtubeItem(youtube);
  if (radio) {
    const url = stations.get(radio);
    if (!url) throw new Error(stations.size ? 'Radios disponibles — ' + [...stations.keys()].join(', ') : 'Aucune radio n’est configurée.');
    return { name: radio, url };
  }
  const file = interaction.data.resolved?.attachments?.[fileId];
  if (!file || !allowedFormats.test(file.filename) || file.size > 25 * 1024 * 1024) {
    throw new Error('Choisis un fichier audio pris en charge de 25 Mo maximum.');
  }
  const url = new URL(file.url);
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.discordapp.com' || url.port ||
      url.username || url.password || !url.pathname.startsWith('/attachments/')) {
    throw new Error('Le fichier doit être joint directement dans Discord.');
  }
  return { name: file.filename.slice(0, 100), url: url.href };
}

async function run(interaction) {
  const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
  const channel = guild?.voiceStates.cache.get(interaction.member.user.id)?.channel;
  if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('Rejoins un salon vocal avant d’utiliser la musique.');
  if (session && session.channel.id !== channel.id) throw new Error('Rejoins le salon où Multix diffuse la musique.');
  const name = interaction.data.name;
  if (name === 'play') {
    const item = getItem(interaction);
    if (!channel.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw new Error('Multix a besoin des permissions Se connecter et Parler dans ce salon.');
    }
    const current = session ?? await connect(channel);
    if (current.queue.length >= 10) throw new Error('La file contient déjà 10 morceaux.');
    const user = interaction.member.user;
    const requester = interaction.member.nick || user.global_name || user.username || 'Un membre';
    const requesterAvatar = user.avatar && /^[a-f0-9_]+$/i.test(user.avatar)
      ? 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png?size=64'
      : undefined;
    current.queue.push({ ...item, requester: requester.slice(0, 100), requesterAvatar, textChannelId: interaction.channel_id });
    if (current.track) return 'Ajouté à la file — ' + item.name;
    return await playNext(current) ? '🎧 DJ Multix prend les platines — ' + item.name : (item.youtube ? 'Impossible de lire cette vidéo. Vérifie qu’elle est publique et que yt-dlp est installé et à jour sur le PC.' : 'Ce lien ou ce fichier ne fournit pas un flux que Multix peut lire.');
  }
  const current = session;
  if (name === 'stop' && current) {
    await stopMusic(current);
    return 'Musique arrêtée et file vidée.';
  }
  if (!current?.track) return 'Aucun morceau en cours.';
  if (name === 'pause') {
    if (!current.player.pause()) return 'La lecture est déjà en pause ou en cours de chargement.';
    await updateMusicCard(current, 'En pause');
    return 'Lecture en pause.';
  }
  if (name === 'resume') {
    if (!current.player.unpause()) return 'La lecture n’est pas en pause.';
    await updateMusicCard(current, 'En lecture');
    return 'Lecture reprise.';
  }
  if (name === 'skip') {
    current.player.stop(true);
    return 'Morceau passé.';
  }
  return ['En cours — ' + current.track.name, ...current.queue.map((item, index) => (index + 1) + '. ' + item.name)].join('\n');
}

client.on('voiceStateUpdate', (before, after) => {
  const current = session;
  if (!current || before.channelId !== current.channel.id || after.channelId === before.channelId) return;
  if (!before.channel?.members.some(member => !member.user.bot)) void schedule(() => stopMusic(current));
});

async function finish(interaction, content) {
  const url = 'https://discord.com/api/v10/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original';
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, {
      method: 'PATCH', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
    });
    if (response.ok || ![404, 429].includes(response.status)) return;
    const retryAfter = response.status === 429 ? Number(response.headers.get('retry-after')) : 0;
    await delay(Math.max(300 * (attempt + 1), Math.min(5000, (retryAfter || 0) * 1000)));
  }
}

const seen = new Map();
function json(response, code, body) {
  response.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return json(response, client.isReady() ? 200 : 503, { ready: client.isReady() });
  if (request.method !== 'POST' || request.url !== '/discord') return json(response, 404, {});
  try {
    const signature = request.headers['x-signature-ed25519'];
    const timestamp = request.headers['x-signature-timestamp'];
    if (!/^[a-f0-9]{128}$/i.test(signature ?? '') || !/^\d+$/.test(timestamp ?? '') ||
        Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return json(response, 401, {});
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 25000) return json(response, 413, {});
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (!verify(null, Buffer.concat([Buffer.from(timestamp), body]), publicKey, Buffer.from(signature, 'hex'))) {
      return json(response, 401, {});
    }
    const interaction = JSON.parse(body.toString());
    if (interaction.type !== 2 || interaction.guild_id !== DISCORD_GUILD_ID ||
        interaction.application_id !== client.application?.id || !interaction.member?.user?.id ||
        !names.has(interaction.data?.name)) return json(response, 400, {});
    if (pendingCommands >= 20) return json(response, 200, { type: 4, data: { content: 'Multix est occupé. Réessaie dans un instant.', flags: 64 } });
    for (const [id, expiry] of seen) if (expiry <= Date.now()) seen.delete(id);
    json(response, 200, { type: 5, data: { flags: 64 } });
    if (seen.has(interaction.id)) return;
    seen.set(interaction.id, Date.now() + 600_000);
    pendingCommands++;
    void schedule(async () => {
      try { return await run(interaction); }
      catch (error) { return error.message; }
    }).then(content => finish(interaction, content))
      .catch(() => console.warn('Réponse Discord indisponible'))
      .finally(() => { pendingCommands--; });
  } catch {
    if (!response.headersSent) json(response, 400, {});
  }
});

client.once('clientReady', async () => {
  try {
    const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
    const existing = await guild.commands.fetch();
    for (const command of commands) {
      const found = existing.find(item => item.name === command.name);
      if (found) await found.edit(command);
      else await guild.commands.create(command);
    }
    console.log('Multix musique connecté');
  } catch (error) {
    console.error('Impossible d’enregistrer les commandes de musique', error.message);
    process.exit(1);
  }
});
server.listen(Number(PORT), '0.0.0.0');
await client.login(DISCORD_BOT_TOKEN);
