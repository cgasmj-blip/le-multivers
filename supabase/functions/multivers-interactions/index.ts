const GUILD='1187492291892486195',APP='1566913973687812286';
const URL=Deno.env.get('SUPABASE_URL'),KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const BOT=()=>Deno.env.get('DISCORD_BOT_TOKEN')?.trim();
async function db(path,method='GET',body,prefer='return=representation'){
 const r=await fetch(`${URL}/rest/v1/${path}`,{method,headers:{apikey:KEY,Authorization:`Bearer ${KEY}`,'Content-Type':'application/json',Prefer:prefer},body:body===undefined?undefined:JSON.stringify(body)});const t=await r.text();const d=t?JSON.parse(t):null;if(!r.ok)throw new Error('Impossible d’enregistrer la réponse.');return d;
}
async function discord(path,method='GET',body){const r=await fetch('https://discord.com/api/v10'+path,{method,headers:{Authorization:`Bot ${BOT()}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw new Error('Discord refuse cette action. Vérifie les permissions de Multix.');return r.status===204?null:await r.json()}
let keyCache,cacheUntil=0;
async function verificationKey(){if(keyCache&&Date.now()<cacheUntil)return keyCache;const settings=(await db('mv_settings?id=eq.true&select=discord_public_key'))[0];const value=settings?.discord_public_key;if(!/^[a-f0-9]{64}$/i.test(value||''))throw new Error('Clé publique Discord manquante.');keyCache=await crypto.subtle.importKey('raw',Uint8Array.from(value.match(/../g),h=>parseInt(h,16)),{name:'Ed25519'},false,['verify']);cacheUntil=Date.now()+600000;return keyCache}
const reply=(content,ephemeral=true)=>Response.json({type:4,data:{content,flags:ephemeral?64:0,allowed_mentions:{parse:[]}}});
async function feedbackTarget(eventId,discordId){if(!/^[a-f0-9-]{36}$/i.test(eventId))return false;const profile=(await db(`mv_profiles?discord_id=eq.${discordId}&select=user_id`))[0];if(!profile)return false;const regs=await db(`mv_registrations?event_id=eq.${eventId}&user_id=eq.${profile.user_id}&registered=eq.true&select=event_id`);const e=(await db(`mv_events?id=eq.${eventId}&cancelled=eq.false&select=ends_at`))[0];return regs.length>0&&e?.ends_at&&Date.parse(e.ends_at)<=Date.now()}
async function voiceSnapshot(channelId){
 const gate=await discord('/gateway/bot');if(gate.session_start_limit?.remaining<=20)throw new Error('Le quota de connexion Discord est presque atteint. Réessaie plus tard.');
 return new Promise((resolve,reject)=>{let done=false,seq=null,heartbeat;const ws=new WebSocket(gate.url+'?v=10&encoding=json');const timeout=setTimeout(()=>finish(new Error('Discord ne répond pas pour la liste du vocal.')),18000);
 function finish(err,value){if(done)return;done=true;clearTimeout(timeout);clearInterval(heartbeat);try{ws.close()}catch{}if(err)reject(err);else resolve(value)}
 ws.onmessage=event=>{try{const packet=JSON.parse(event.data);if(packet.s!==null&&packet.s!==undefined)seq=packet.s;
 if(packet.op===10){ws.send(JSON.stringify({op:2,d:{token:BOT(),intents:129,properties:{os:'linux',browser:'Multix',device:'Multix'},presence:{status:'online',since:null,activities:[],afk:false}}}));heartbeat=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({op:1,d:seq}))},packet.d.heartbeat_interval);}
 if(packet.op===1&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({op:1,d:seq}));
 if(packet.op===9||packet.op===7)finish(new Error('Connexion Discord temporairement indisponible.'));
 if(packet.t==='GUILD_CREATE'&&packet.d.id===GUILD){const guild=packet.d;const members=new Map((guild.members||[]).map(m=>[m.user.id,m.user]));const ids=(guild.voice_states||[]).filter(v=>v.channel_id===channelId&&!(v.member?.user?.bot||members.get(v.user_id)?.bot)).map(v=>v.user_id);finish(null,[...new Set(ids)]);}
 }catch(e){finish(new Error('Lecture du vocal impossible.'))}};
 ws.onerror=()=>finish(new Error('Connexion au vocal Discord impossible.'));ws.onclose=()=>finish(new Error('Connexion Discord interrompue.'));
 });
}
function randomIndex(max){const a=new Uint32Array(1);const limit=4294967296-4294967296%max;do{crypto.getRandomValues(a)}while(a[0]>=limit);return a[0]%max}
function makeTeams(ids,count){const shuffled=[...ids];for(let i=shuffled.length-1;i>0;i--){const j=randomIndex(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]]}const teams=Array.from({length:count},()=>[]);shuffled.forEach((id,i)=>teams[i%count].push(id));return teams}
async function runTeams(interaction){let content;try{
 const channel=await discord(`/channels/${interaction.channel_id}`);if(channel.guild_id!==GUILD||![2,13].includes(channel.type))throw new Error('Utilise /equipes directement dans le chat du canal vocal.');
 const bucket=Math.floor(Date.now()/60000);if(!await db('rpc/mv_claim_notification','POST',{p_key:'teams:'+GUILD+':'+bucket}))throw new Error('Un tirage a déjà été demandé cette minute. Réessaie dans un instant.');
 const ids=await voiceSnapshot(interaction.channel_id);const actor=interaction.member?.user?.id;if(!ids.includes(actor))throw new Error('Tu dois être connecté à ce vocal pour tirer les équipes.');
 const count=Number(interaction.data.options?.find(o=>o.name==='nombre')?.value||2);if(!Number.isInteger(count)||count<2||count>10||ids.length<count)throw new Error('Il faut au moins une personne par équipe.');
 const teams=makeTeams(ids,count);content='## 🎲 Équipes aléatoires\n'+teams.map((team,i)=>`\n### Équipe ${i+1}\n`+team.map(id=>`• <@${id}>`).join('\n')).join('\n')+'\n\n*Multix · tirage effectué avec les personnes présentes dans ce vocal. Aucun déplacement.*';
 if(content.length>1900)throw new Error('Il y a trop de personnes pour afficher le tirage dans un seul message.');
 }catch(e){content='⚠️ '+e.message}
 await fetch(`https://discord.com/api/v10/webhooks/${APP}/${interaction.token}/messages/@original`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({content,allowed_mentions:{parse:[]}})});
}
const PROFILE_BADGES=[
 ['premier-voyage','Premier voyage','1 soirée jouée'],['compagnon','Compagnon du Multivers','5 soirées jouées'],
 ['explorateur','Explorateur des mondes','5 jeux différents'],['pilier','Pilier du Multivers','20 soirées jouées'],
 ['coeur','Cœur du Multivers','Distinction attribuée par les fondateurs']
];
function profileEmbeds(member,collection,mapping=[]){
 const user=member.user,name=(member.nick||user.global_name||user.username).slice(0,100);
 const founder=member.roles.includes('1187492291947012126');
 const earned=founder?PROFILE_BADGES.map(b=>b[0]):collection?.earned||[];
 const avatar=/^[a-f0-9_]+$/i.test(user.avatar||'')?`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`:`https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id)>>22n)%6}.png`;
 const badgeEmoji=id=>{const m=mapping.find(m=>m.badge_id===id);return m?.emoji_id&&/^[0-9]{17,20}$/.test(m.emoji_id)&&/^[a-z0-9_]{2,32}$/i.test(m.emoji_name||'')?`<:${m.emoji_name}:${m.emoji_id}>`:'✦'};
 const summary={title:'✦ Collection de '+name,color:9854207,thumbnail:{url:avatar},description:(founder?'✦ **Fondateur du Multivers**\n\n':'')+`**${earned.length} / 5 Reliques cosmiques débloquées**`,fields:[{name:'Les soirées',value:`${collection?.sessions||0} présence(s) validée(s) · ${collection?.games||0} jeu(x) différent(s)`},{name:'La collection',value:PROFILE_BADGES.map(([id,label,condition])=>`${earned.includes(id)?badgeEmoji(id):'○'} **${label}** · ${earned.includes(id)?'Débloqué':condition}`).join('\n')}],footer:{text:'Multix · Les badges reflètent les présences validées sur le panel.'}};
 const embeds=[summary];
 if(!collection&&!founder)summary.description+='\n\nConnecte-toi au panel pour retrouver tes participations et débloquer tes premiers badges.';
 return embeds;
}
async function runProfile(i){
 let data;try{
 const target=i.data.options?.find(o=>o.name==='membre')?.value||i.member.user.id;
 if(typeof target!=='string'||!/^\d{17,20}$/.test(target))throw new Error('Membre invalide.');
 const member=await discord(`/guilds/${GUILD}/members/${target}`);
 const profile=(await db(`mv_profiles?discord_id=eq.${target}&select=user_id`))[0];
 if(profile)await db(`mv_profiles?user_id=eq.${profile.user_id}`,'PATCH',{is_founder:member.roles.includes('1187492291947012126')});
 const collection=profile?(await db(`rpc/mv_badge_collection?user_id=eq.${profile.user_id}`,'POST',{}))[0]:null;
 const mapping=await db('mv_badge_discord');
 data={embeds:profileEmbeds(member,collection,mapping),content:'',allowed_mentions:{parse:[]}};
 }catch(e){data={content:'⚠️ Impossible de charger ce profil. Vérifie que la personne est membre du serveur et réessaie.',embeds:[],allowed_mentions:{parse:[]}};console.error('profile',e.message);}
 const r=await fetch(`https://discord.com/api/v10/webhooks/${APP}/${i.token}/messages/@original`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 if(!r.ok)console.error('profile-reply',r.status);
}

async function relayMusic(raw,signature,timestamp){
 const destination=Deno.env.get('MULTIX_MUSIC_URL');
 if(!destination)return reply('Le service musique de Multix attend son hébergement.');
 try{
  const url=new globalThis.URL(destination);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/discord')throw new Error('URL musique invalide');
  const result=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(1800),headers:{
   'Content-Type':'application/json','X-Signature-Ed25519':signature,'X-Signature-Timestamp':timestamp
  },body:raw});
  if(!result.ok)throw new Error('Service indisponible');
  const ack=await result.json();
  if(ack.type===5)return Response.json({type:5,data:{flags:64}});
  if(ack.type===4&&typeof ack.data?.content==='string')return reply(ack.data.content.slice(0,1900));
 }catch{}
 return reply('Le service musique est momentanément indisponible.');
}

Deno.serve(async req=>{if(req.method!=='POST')return new Response('Method not allowed',{status:405});try{
 const signature=req.headers.get('x-signature-ed25519'),timestamp=req.headers.get('x-signature-timestamp');if(!/^[a-f0-9]{128}$/i.test(signature||'')||!/^\d+$/.test(timestamp||'')||Math.abs(Date.now()/1000-Number(timestamp))>300)return new Response('Invalid signature',{status:401});
 const raw=await req.text();if(raw.length>25000)return new Response('Too large',{status:413});
 const valid=await crypto.subtle.verify({name:'Ed25519'},await verificationKey(),Uint8Array.from(signature.match(/../g),h=>parseInt(h,16)),new TextEncoder().encode(timestamp+raw));if(!valid)return new Response('Invalid signature',{status:401});
 const i=JSON.parse(raw);if(i.type===1)return Response.json({type:1});if(i.guild_id!==GUILD)return reply('Cette fonction est réservée au Multivers.');
 if(i.type===2&&['play','pause','resume','skip','stop','queue'].includes(i.data.name))return relayMusic(raw,signature,timestamp);
 if(i.type===2&&i.data.name==='profil'){EdgeRuntime.waitUntil(runProfile(i));return Response.json({type:5,data:{allowed_mentions:{parse:[]}}})}
 if(i.type===2&&i.data.name==='equipes'){EdgeRuntime.waitUntil(runTeams(i));return Response.json({type:5,data:{allowed_mentions:{parse:[]}}})}
 const actor=i.member?.user?.id;if(!actor)return reply('Compte Discord introuvable.');
 if(i.type===3&&i.data.custom_id==='review-demo')return Response.json({type:9,data:{custom_id:'review-demo-submit',title:'Bilan · Démonstration',components:[{type:1,components:[{type:4,custom_id:'score',label:'Ta note sur 5 (de 1 à 5)',style:1,min_length:1,max_length:1,required:true}]},{type:1,components:[{type:4,custom_id:'comment',label:'Ton commentaire pour les animateurs',style:2,max_length:1000,required:false}]}]}});
 if(i.type===5&&i.data.custom_id==='review-demo-submit')return reply('🧪 Test réussi ! Aucune note ni aucun commentaire n’a été enregistré.');

 if(i.type===3&&i.data.custom_id?.startsWith('review:')){const eventId=i.data.custom_id.slice(7);if(!await feedbackTarget(eventId,actor))return reply('Ce bilan est réservé aux personnes inscrites à cette soirée terminée.');return Response.json({type:9,data:{custom_id:'review-submit:'+eventId,title:'Bilan de la soirée',components:[{type:1,components:[{type:4,custom_id:'score',label:'Ta note sur 5 (de 1 à 5)',style:1,min_length:1,max_length:1,required:true}]},{type:1,components:[{type:4,custom_id:'comment',label:'Ton commentaire pour les animateurs',style:2,max_length:1000,required:false}]}]}})}
 if(i.type===5&&i.data.custom_id?.startsWith('review-submit:')){const eventId=i.data.custom_id.slice(14);if(!await feedbackTarget(eventId,actor))return reply('Tu ne peux pas répondre à ce bilan.');const fields=i.data.components.flatMap(row=>row.components||[]);const score=Number(fields.find(f=>f.custom_id==='score')?.value);const comment=fields.find(f=>f.custom_id==='comment')?.value||'';if(!Number.isInteger(score)||score<1||score>5)return reply('La note doit être comprise entre 1 et 5.');await db('mv_feedback?on_conflict=event_id,discord_id','POST',{event_id:eventId,discord_id:actor,score,comment,created_at:new Date().toISOString()},'resolution=merge-duplicates,return=representation');return reply('Merci ! Ton avis a été transmis aux animateurs. Tu peux le modifier en cliquant à nouveau sur le bouton.')}
 return reply('Action non reconnue.');
 }catch(e){console.error('multivers-interactions',e.message);return new Response('Interaction unavailable',{status:500})}});

