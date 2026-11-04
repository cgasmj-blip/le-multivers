const GUILD='1187492291892486195';
const ROOT=Deno.env.get('SUPABASE_URL'),KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const token=()=>Deno.env.get('DISCORD_BOT_TOKEN')?.trim();
class DiscordError extends Error{constructor(message,status){super(message);this.status=status}}
async function db(path,method='GET',body,prefer='return=representation'){
 const r=await fetch(`${ROOT}/rest/v1/${path}`,{method,headers:{apikey:KEY,Authorization:`Bearer ${KEY}`,'Content-Type':'application/json',Prefer:prefer},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.text();const data=value?JSON.parse(value):null;if(!r.ok)throw new Error('Voice database: '+r.status+' '+(data?.message||'')+' ['+path.split('?')[0]+']');return data;
}
async function discord(path,method='GET',body){
 const r=await fetch('https://discord.com/api/v10'+path,{method,headers:{Authorization:`Bot ${token()}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 if(!r.ok)throw new DiscordError('Discord voice: '+r.status,r.status);return r.status===204?null:await r.json();
}
const LAUNCHER_NAME='➕・𝐂𝐫𝐞́𝐞𝐫 𝐮𝐧 𝐯𝐨𝐜𝐚𝐥';
function targetCategories(channels){
 const categories=channels.filter(c=>c.type===4).sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id));
 const start=categories.findIndex(c=>c.id==='1564005439178543174'),end=categories.findIndex(c=>c.id==='1566865084829929492');
 if(start<0||end<=start)throw new Error('Catégories Événements et Assistance introuvables ou déplacées.');
 return categories.slice(start+1,end);
}
function voiceName(name){
 let capital=false;return Array.from(('🔊・Vocal de '+name).normalize('NFKD').toLowerCase(),c=>{
 if(!capital&&/\p{L}/u.test(c)){capital=true;c=c.toUpperCase()}
 const n=c.codePointAt(0);return n>=65&&n<=90?String.fromCodePoint(0x1D400+n-65):n>=97&&n<=122?String.fromCodePoint(0x1D41A+n-97):c;
 }).slice(0,100).join('');
}
async function setupLaunchers(){
 const channels=await discord(`/guilds/${GUILD}/channels`),categories=targetCategories(channels),results=[];
 for(const category of categories){
 const existing=channels.find(c=>c.type===2&&c.parent_id===category.id&&c.name.normalize('NFKC')===LAUNCHER_NAME.normalize('NFKC'));
 const channel=existing||await discord(`/guilds/${GUILD}/channels`,'POST',{name:LAUNCHER_NAME,type:2,parent_id:category.id,permission_overwrites:category.permission_overwrites||[]});
 if(existing)await discord(`/channels/${channel.id}`,'PATCH',{permission_overwrites:category.permission_overwrites||[]});
 await db('mv_voice_launchers?on_conflict=channel_id','POST',{channel_id:channel.id,category_id:category.id,category_name:category.name},'resolution=merge-duplicates,return=representation');
 results.push({category:category.name,category_id:category.id,channel_id:channel.id,created:!existing});
 }
 return {launchers:results};
}
async function removeEmpty(channel,knownChannels){
 const occupied=await db(`mv_voice_presence?channel_id=eq.${channel.channel_id}&select=user_id&limit=1`);if(occupied.length)return false;
 const live=knownChannels?.find(c=>c.id===channel.channel_id)||await discord(`/channels/${channel.channel_id}`).catch(e=>{if(e.status===404)return null;throw e});
 if(live){const launcher=(await db(`mv_voice_launchers?channel_id=eq.${channel.launcher_id}`))[0];if(live.guild_id&&live.guild_id!==GUILD||live.type!==2||live.parent_id!==launcher?.category_id)throw new Error('Le vocal ne correspond plus à une ressource temporaire prévue.');await discord(`/channels/${channel.channel_id}`,'DELETE');}
 await db(`mv_temporary_voices?channel_id=eq.${channel.channel_id}`,'DELETE');return true;
}
async function handleVoice(state,launchers){
 if(state.guild_id!==GUILD)return;
 const before=(await db(`mv_voice_presence?user_id=eq.${state.user_id}`))[0]?.channel_id;
 await db('mv_voice_presence?on_conflict=user_id','POST',{user_id:state.user_id,channel_id:state.channel_id},'resolution=merge-duplicates,return=representation');
 const launcher=launchers.find(l=>l.channel_id===state.channel_id);
 if(launcher&&!state.member?.user?.bot){
 let temp=(await db(`mv_temporary_voices?launcher_id=eq.${launcher.channel_id}&owner_id=eq.${state.user_id}`))[0];
 if(temp){const live=await discord(`/channels/${temp.channel_id}`).catch(e=>{if(e.status===404)return null;throw e});if(!live){await db(`mv_temporary_voices?channel_id=eq.${temp.channel_id}`,'DELETE');temp=null;}}
 if(!temp){
 const category=await discord(`/channels/${launcher.category_id}`);if(category.guild_id!==GUILD||category.type!==4)throw new Error('Catégorie vocale invalide.');
 const name=state.member?.nick||state.member?.user?.global_name||state.member?.user?.username||'Joueur';
 const channel=await discord(`/guilds/${GUILD}/channels`,'POST',{name:voiceName(name),type:2,parent_id:launcher.category_id,permission_overwrites:category.permission_overwrites||[]});
 try{temp=(await db('mv_temporary_voices','POST',{channel_id:channel.id,launcher_id:launcher.channel_id,owner_id:state.user_id}))[0];}
 catch(e){await discord(`/channels/${channel.id}`,'DELETE').catch(()=>{});throw e;}
 }
 try{
 await discord(`/guilds/${GUILD}/members/${state.user_id}`,'PATCH',{channel_id:temp.channel_id});
 await db(`mv_voice_presence?user_id=eq.${state.user_id}`,'PATCH',{channel_id:temp.channel_id});
 }catch(e){await removeEmpty(temp).catch(()=>{});throw e;}
 }
 if(before&&before!==state.channel_id){const old=(await db(`mv_temporary_voices?channel_id=eq.${before}`))[0];if(old)await removeEmpty(old);}
}
const BEWTE_RULE='1567658000452161630';
function randomReplyIndex(max){
 const values=new Uint32Array(1),limit=4294967296-4294967296%max;
 do{crypto.getRandomValues(values)}while(values[0]>=limit);
 return values[0]%max;
}
async function handleWordBlock(event,eventKey){
 if(event.guild_id!==GUILD||event.rule_id!==BEWTE_RULE||event.action?.type!==1)return;
 if(!/^[0-9]{17,20}$/.test(event.channel_id||'')||!/^[0-9]{17,20}$/.test(event.user_id||''))return;
 if(eventKey&&!await db('rpc/mv_claim_notification','POST',{p_key:'bewte-reply:'+eventKey}))return;
 const lines=["Ton clavier a tenté une esquive, mon filtre a gagné. Bien tenté 😏","Même avec un déguisement, ce mot ne passe pas mon portail. Essaie un autre sort 😎","Tu pensais contourner Multix ? Mon filtre avait déjà préparé le contre-sort ✨","Tentative de passage en douce détectée. Le portail était fermé, pourtant 🚪","Joli camouflage. Dommage, j’ai équipé la vision nocturne 🤖","Ton message a tenté un speedrun. Éliminé au premier checkpoint 🏁","Le filtre : 1. Ton plan secret : 0. On remet ça ? 🎮","Tu as lancé une attaque surprise. J’avais une carte piège 🃏","Message intercepté en orbite. Retour à la case clavier 🪐","Le boss de fin, c’est moi. Et cette attaque ne traverse pas mon bouclier 🛡️","Tu as changé la tenue du mot, pas sa carte d’identité 🕵️","Une tentative ambitieuse… pour une porte marquée « accès refusé » 😌","Mon radar a fait bip. Ton message a fait pouf 📡","Tu as tenté le mode furtif avec les chaussures qui couinent 👟","Belle passe, mais Multix était dans les cages 🥅","Tu pensais avoir trouvé une faille ? C’était la porte du placard 🧹","J’ai vu le coup venir depuis une autre dimension 🌌","Ton sort a été contré. Il te reste plein d’autres mots dans l’inventaire 🪄","Ce message voulait devenir une légende. Il est devenu un écran de chargement ⏳","La mission infiltration vient de se transformer en tutoriel 😏","Ton clavier improvise, mon filtre connaît déjà la partition 🎵","Tu as invoqué le mot interdit. J’ai invoqué la gomme magique 🧽","Pas de passage VIP pour ce mot, même avec des lunettes de soleil 🕶️","Portail fermé. Merci de reformuler avec davantage de créativité ✨","Deux V dans un trench-coat ne deviennent pas un W invisible. Je te vois 😏","Les lettres ont changé de costume, mais elles ont oublié de changer de démarche 🕵️","Le double V avait un plan. Mon filtre avait le scénario complet 🎬","Ton opération camouflage vient de passer en mode spectateur 👀","Tu as pris le chemin secret… il menait directement à mon filtre 🗺️","Joli combo de lettres. Par contre, le coup spécial est bloqué 🕹️","Ton message a demandé un visa intergalactique. Dossier refusé 🛸","Nouvelle orthographe, même contrôle à l’entrée. Suivant 😎","Le clavier fait des acrobaties, mais la réception reste interdite 🤸","Tu as activé la cape d’invisibilité à l’envers. Ça arrive 🪄","J’ai reçu ta tentative. Le service des mauvaises idées l’a classée sans suite 📁","Le mot avait une fausse moustache. Ça ne suffisait pas 🥸","Ton raccourci vient de rallonger le trajet jusqu’à la touche effacer ⌨️","Bien essayé. Le videur du Multivers connaît aussi les pseudonymes 🚧","Tu as tenté un petit pont. Multix avait fermé les jambes ⚽","Cette tentative était sponsorisée par « presque, mais non » 😌","Le mot s’est présenté sous un faux nom. Son accent l’a trahi 🎭","Tu as lancé le dé. Résultat : retour à la case reformulation 🎲","Le filtre n’a pas cligné des yeux. Pratique, je suis un robot 🤖","Ton message a rencontré un mur invisible. Il était pourtant bien indiqué 🧱","Tu as débloqué le succès « Bien tenté ». La récompense, c’est cette réplique 🏅","Le plan était discret. Sauf la grande pancarte « tentative de contournement » 📣","Tu as changé les lettres de place sur la chaise. Je reconnais toujours les invités 🪑","Encore une livraison refusée au portail. Le colis sentait le contournement 📦","Ton mot a tenté de passer par la fenêtre. J’avais installé une moustiquaire 🪟","Le portail a reconnu ton mot avant même de demander son billet 🎟️","Une ruse de plus dans le musée des tentatives presque réussies 🏛️","Tu as choisi le mode difficile. Le filtre aussi 😎","Ton message était en mission secrète. Il a oublié de couper sa sonnerie 📱","Le camouflage était impeccable… jusqu’au moment où tu as écrit le mot 🫣","Mon filtre vient de faire une parade parfaite. Aucun dégât reçu ⚔️","Le mot a essayé de se téléporter. Destination : corbeille 🌀","Tu as apporté une échelle. Le mur venait de monter d’un étage 🪜","Ton message est arrivé au contrôle avec un passeport en carton 🛂","Le détour était joli. Il faisait quand même le tour de mon radar 🛰️","Mon détecteur de petits malins vient de gagner un point d’expérience 📈","La porte dérobée était une décoration. Surprise 🚪","Tu pensais arriver incognito. Le tapis rouge disait déjà ton nom 🎬","Ton mot a pris un taxi. Le chauffeur, c’était mon filtre 🚕","La tentative avait du style. Le blocage aussi 💅","Tu as lancé une diversion. J’ai regardé les deux côtés 👁️","Le code secret était écrit sur l’enveloppe. Petit souci de discrétion ✉️","Ton mot a demandé une seconde chance. Le portail a toussé 🤭","Tu viens de tester le filet de sécurité. Il fonctionne très bien 🕸️","Les lettres étaient déguisées en touristes. Je connais le quartier 🧳","Tu as appuyé sur esquive. J’avais verrouillé la cible 🎯","Le filtre vient de réussir son contrôle de perception 🔍","Ton mot a tenté une sortie de secours. Elle ramenait à l’entrée 🔄","Ce camouflage mérite une étoile. Le message, lui, reste dehors ⭐","Tu as trouvé le passage secret du tutoriel. Il était prévu dans le tuto 📖","Le mot a essayé de soudoyer le portail avec des accents. Refusé 💼","J’ai entendu tes lettres marcher sur la pointe des pieds 🐾","Le message était presque passé. Presque est un endroit très fréquenté ici 😏","Tu as invoqué un double. J’avais deux boucliers 🛡️","Cette tentative avait des ailes. Mon filtre avait un filet 🦋","Les caractères invisibles portaient un gilet fluorescent 🦺","Ton mot a lancé une fumigène. Je suis équipé pour le brouillard 🌫️","Le clavier a fait un salto. Le message a raté la plateforme 🤸","Tu viens de rencontrer le service après-contournement. Bonjour 🤖","La ruse était artisanale. Le filtre est fait maison aussi 🛠️","Ton message a cherché un angle mort. Je tourne sur moi-même 🧭","Le mot a changé de coiffure. Je reconnais quand même sa tête 💇","Ta tentative a sonné à la porte en disant que c’était la livraison. Raté 🛎️","Le filtre a sorti son plus beau carton : reformulation demandée 🟨","Tu as tenté le passage en force avec un coussin. C’était audacieux 🛋️","Le mot était caché sous un drap. On voyait encore ses chaussures 👻","Une nouvelle tentative rejoint ma collection de souvenirs 📚","Ton plan avait un plan B. J’avais lu les deux 📋","Tu as changé la police d’écriture. Pas le verdict du portail 🔤","Le message a fait semblant de ne pas me voir. Je l’ai vu quand même 🙈","Tu as visé la faille. C’était juste un effet de lumière 💡","Le mot a demandé à entrer pour cinq minutes. Il connaît la réponse ⌛","Le filtre vient de gagner son duel sans quitter sa chaise 🪑","Tu pensais profiter du chargement. Je modère aussi pendant l’écran titre 🎮","Ton message a tenté le hors-piste. J’avais placé les balises ⛷️","Cent façons de te taquiner, toujours le même portail à franchir. Bien tenté ✨"];
 const line=lines[randomReplyIndex(lines.length)];
 await discord(`/channels/${event.channel_id}/messages`,'POST',{content:`<@${event.user_id}> ${line}`,allowed_mentions:{parse:[],users:[event.user_id]}});
}

async function startGateway(lease,session){
 let ws,heartbeat,stopTimer,seq=session.seq,sessionId=session.session_id,resumeUrl=session.resume_url,acked=true,done=false,queue=Promise.resolve();
 const launchers=await db('mv_voice_launchers');
 const save=extra=>db(`mv_gateway_session?id=eq.true&lease_id=eq.${lease}`,'PATCH',{session_id:sessionId,resume_url:resumeUrl,seq,...extra});
 async function finish(error){if(done)return;done=true;clearInterval(heartbeat);clearTimeout(stopTimer);try{ws?.close(4000,'Multix resume')}catch{}await queue.catch(()=>{});await save({lease_until:new Date().toISOString(),last_error:error||null}).catch(e=>console.error('voice-save',e.message));}
 try{
 const gate=await discord('/gateway/bot');if(!sessionId&&gate.session_start_limit?.remaining<=20)throw new Error('Quota Discord de connexions initiales presque atteint.');
 ws=new WebSocket((resumeUrl||gate.url)+'?v=10&encoding=json');
 stopTimer=setTimeout(()=>finish(null),52000);
 ws.onmessage=event=>{
 let p;try{p=JSON.parse(event.data)}catch{return}
 if(p.op===10){
 if(sessionId&&seq!==null)ws.send(JSON.stringify({op:6,d:{token:token(),session_id:sessionId,seq}}));
 else ws.send(JSON.stringify({op:2,d:{token:token(),intents:2097281,properties:{os:'linux',browser:'Multix',device:'Multix'},presence:{status:'online',since:null,activities:[],afk:false}}}));
 const beat=()=>{if(!acked){finish('Heartbeat Discord sans réponse');return}if(ws.readyState===WebSocket.OPEN){acked=false;ws.send(JSON.stringify({op:1,d:seq}))}};
 beat();heartbeat=setInterval(beat,p.d.heartbeat_interval);return;
 }
 if(p.op===11){acked=true;return}if(p.op===1){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({op:1,d:seq}));return}
 if(p.op===7){finish('Reconnexion demandée par Discord');return}
 if(p.op===9){if(!p.d){sessionId=null;resumeUrl=null;seq=null;}finish('Session Discord à reprendre');return}
 if(p.op!==0)return;
 queue=queue.then(async()=>{
 if(p.t==='READY'){sessionId=p.d.session_id;resumeUrl=p.d.resume_gateway_url;await save({connected_at:new Date().toISOString()});}
 if(p.t==='GUILD_CREATE'&&p.d.id===GUILD){
 await db('rpc/mv_voice_snapshot','POST',{p_states:(p.d.voice_states||[]).map(v=>({user_id:v.user_id,channel_id:v.channel_id}))});
 for(const v of p.d.voice_states||[]){if(launchers.some(l=>l.channel_id===v.channel_id)){const member=v.member||(p.d.members||[]).find(m=>m.user?.id===v.user_id);await handleVoice({...v,member,guild_id:GUILD},launchers);}}
 const temps=await db('mv_temporary_voices');for(const t of temps)await removeEmpty(t);
 }
 if(p.t==='AUTO_MODERATION_ACTION_EXECUTION')await handleWordBlock(p.d,sessionId+':'+p.s);
 if(p.t==='VOICE_STATE_UPDATE'&&p.d.guild_id===GUILD)await handleVoice(p.d,launchers);
 seq=p.s;await save({last_event_at:new Date().toISOString(),last_error:null});
 }).catch(async e=>{console.error('temporary-voice',e.message);await save({last_error:e.message}).catch(()=>{});});
 };
 ws.onerror=()=>finish('Connexion Discord interrompue');
 ws.onclose=e=>{if([4007,4009].includes(e.code)){sessionId=null;resumeUrl=null;seq=null;}finish(done?null:'Discord fermé : '+e.code)};
 }catch(e){await finish(e.message);}
}
Deno.serve(async req=>{
 if(req.method!=='POST')return new Response('Method not allowed',{status:405});
 try{
 const secret=req.headers.get('x-cron-secret');if(!secret||!await db('rpc/mv_verify_cron','POST',{p_secret:secret}))return new Response('Forbidden',{status:403});
 const b=await req.json();
 if(b.action==='setup')return Response.json(await setupLaunchers());
 if(b.action==='status'){const state=(await db('mv_gateway_session?select=connected_at,last_event_at,last_error,lease_until'))[0];return Response.json({state,launchers:await db('mv_voice_launchers'),temporary:await db('mv_temporary_voices')});}
 if(b.action!=='run')return new Response('Unknown action',{status:400});
 const lease=crypto.randomUUID(),rows=await db('rpc/mv_acquire_gateway','POST',{p_lease:lease});if(!rows.length)return Response.json({busy:true});
 // The long-lived promise covers both WebSocket events and their database/Discord work.
 const running=new Promise(resolve=>{setTimeout(resolve,56000);});
 EdgeRuntime.waitUntil(Promise.all([startGateway(lease,rows[0]),running]).catch(e=>console.error('voice-worker',e.message)));
 return Response.json({started:true});
 }catch(e){console.error('voice-worker',e.message);return Response.json({error:e.message},{status:500});}
});
