import { createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Readable, pipeline } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } from 'discord.js';
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
  { name: 'play', description: 'Ajoute un fichier audio ou une radio à la file', options: [
    { type: 11, name: 'fichier', description: 'Fichier audio à lire' },
    { type: 3, name: 'radio', description: 'Nom d’une radio configurée' },
  ] },
  { name: 'pause', description: 'Met la musique en pause' },
  { name: 'resume', description: 'Reprend la lecture' },
  { name: 'skip', description: 'Passe au morceau suivant' },
  { name: 'stop', description: 'Arrête la musique et quitte le vocal' },
  { name: 'queue', description: 'Affiche le morceau en cours et la file' },
];
const names = new Set(commands.map(command => command.name));
const allowedFormats = /\.(mp3|ogg|opus|wav|flac|m4a|aac|webm)$/i;
let session;
let serial = Promise.resolve();
let pendingCommands = 0;

function schedule(task) {
  const result = serial.then(task);
  serial = result.catch(() => {});
  return result;
}

function stopMusic(current) {
  if (session !== current) return;
  session = undefined;
  clearTimeout(current.idleTimer);
  current.track?.abort.abort();
  current.player.stop(true);
  if (current.connection.state.status !== VoiceConnectionStatus.Destroyed) current.connection.destroy();
}

function armIdle(current) {
  clearTimeout(current.idleTimer);
  current.idleTimer = setTimeout(() => {
    void schedule(() => {
      if (session === current && !current.track) stopMusic(current);
    });
  }, 30_000);
}

async function playNext(current) {
  if (session !== current) return;
  current.track?.abort.abort();
  current.track = undefined;
  while (current.queue.length) {
    const item = current.queue.shift();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await fetch(item.url, { signal: abort.signal, redirect: 'error' });
      if (!response.ok || !response.body) throw new Error('Source indisponible');
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
      pipeline(Readable.fromWeb(response.body), ffmpeg.stdin, () => {});
      current.player.play(resource);
      await entersState(current.player, AudioPlayerStatus.Playing, 8_000);
      return true;
    } catch {
      current.track = undefined;
      current.player.stop(true);
      abort.abort();
    } finally {
      clearTimeout(timeout);
    }
  }
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
  } catch {
    stopMusic(current);
    throw new Error('Multix n’a pas réussi à rejoindre le vocal.');
  }
  return current;
}

function getItem(interaction) {
  const options = interaction.data.options ?? [];
  const fileId = options.find(option => option.name === 'fichier')?.value;
  const radio = options.find(option => option.name === 'radio')?.value;
  if (Boolean(fileId) === Boolean(radio)) throw new Error('Choisis un fichier audio ou une seule radio.');
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
    current.queue.push(item);
    if (current.track) return 'Ajouté à la file — ' + item.name;
    return await playNext(current) ? 'Lecture — ' + item.name : 'Cette source audio est indisponible.';
  }
  const current = session;
  if (name === 'stop' && current) {
    stopMusic(current);
    return 'Musique arrêtée et file vidée.';
  }
  if (!current?.track) return 'Aucun morceau en cours.';
  if (name === 'pause') return current.player.pause() ? 'Lecture en pause.' : 'La lecture est déjà en pause ou en cours de chargement.';
  if (name === 'resume') return current.player.unpause() ? 'Lecture reprise.' : 'La lecture n’est pas en pause.';
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
