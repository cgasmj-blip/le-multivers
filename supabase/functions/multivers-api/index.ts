const GUILD='1187492291892486195', MANAGER='1564000010247475270';
const LOG_CHANNEL='1566867467882463383';
const ORIGIN='https://cgasmj-blip.github.io';
const URL=Deno.env.get('SUPABASE_URL'), KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const cors={'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-cron-secret','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin','Content-Type':'application/json','Cache-Control':'no-store'};
class HttpError extends Error { constructor(message,status=400){super(message);this.status=status} }
async function db(path,method='GET',body,prefer='return=representation'){
 const r=await fetch(`${URL}/rest/v1/${path}`,{method,headers:{apikey:KEY,Authorization:`Bearer ${KEY}`,'Content-Type':'application/json',Prefer:prefer},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await r.text(); const data=text?JSON.parse(text):null;
 if(!r.ok)throw new HttpError(data?.message||'Erreur de base de données',400);return data;
}
async function discord(path,method='GET',body){
 const token=Deno.env.get('DISCORD_BOT_TOKEN')?.trim();if(!token)throw new HttpError('Le bot Discord doit encore être configuré.',503);
 const r=await fetch('https://discord.com/api/v10'+path,{method,headers:{Authorization:`Bot ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 if(r.status===429)throw new HttpError('Discord est temporairement occupé. Réessaie dans quelques instants.',503);
 if(r.status===404)throw new HttpError('Membre ou ressource introuvable sur le serveur Discord.',403);
 if(r.status===401)throw new HttpError('Le token du bot Discord est invalide. Un responsable doit le remplacer dans Supabase.',503);
 if(r.status===403)throw new HttpError('Le bot n’a pas accès à ce serveur ou à cette action Discord.',502);
 if(!r.ok)throw new HttpError('Discord est indisponible pour le moment.',502);
 return r.status===204?null:await r.json();
}
function text(v,max=100){if(typeof v!=='string'||!v.trim()||v.trim().length>max)throw new HttpError('Texte invalide');return v.trim()}
function image(v){if(!v)return '';const u=new globalThis.URL(v);if(u.protocol!=='https:')throw new HttpError('L’image doit utiliser HTTPS');return u.href}
function dates(a,b){const start=new Date(a),end=new Date(b);if(!Number.isFinite(+start)||!Number.isFinite(+end)||end<=start)throw new HttpError('Dates ou heures invalides');return [start.toISOString(),end.toISOString()]}
function uuid(v){if(typeof v!=='string'||!/^[a-f0-9-]{36}$/i.test(v))throw new HttpError('Identifiant invalide');return v}
async function identity(req){
 const auth=req.headers.get('authorization');if(!auth?.startsWith('Bearer '))throw new HttpError('Connecte-toi avec Discord.',401);
 const r=await fetch(`${URL}/auth/v1/user`,{headers:{apikey:KEY,Authorization:auth}});if(!r.ok)throw new HttpError('Session expirée. Reconnecte-toi.',401);
 const user=await r.json();const di=user.identities?.find(i=>i.provider==='discord');const id=di?.provider_id||di?.identity_data?.provider_id||di?.identity_data?.sub;
 if(!id||!/^\d{17,20}$/.test(id))throw new HttpError('Une connexion Discord est requise.',403);
 const member=await discord(`/guilds/${GUILD}/members/${id}`);
 const profile={user_id:user.id,discord_id:id,display_name:member.nick||member.user.global_name||member.user.username};
 await db('mv_profiles?on_conflict=user_id','POST',profile,'resolution=merge-duplicates,return=representation');
 return {user_id:user.id,discord_id:id,display_name:profile.display_name,manager:member.roles.includes(MANAGER)};
}
async function notifyRoster(eventId){
 const settings=(await db('mv_settings?id=eq.true'))[0];
 if(!settings?.roster_channel_id)return {configured:false};
 const e=(await db(`mv_events?id=eq.${eventId}`))[0];
 const rows=await db(`mv_registrations?event_id=eq.${eventId}&registered=eq.true&select=*,mv_profiles(discord_id)&order=updated_at.asc`);
 if(!e.published||e.cancelled){if(!e.roster_message_id)return {skipped:true};}
 if(!e.roster_message_id&&rows.length<e.capacity)return {waiting_for_full:true};
 const labels={present:'✅ Présent',absent:'❌ Absent',excused:'💬 Excusé',unmarked:'Inscrit'};
 const ended=e.ends_at&&Date.parse(e.ends_at)<=Date.now();
 const title=(e.cancelled?'🚫 SOIRÉE ANNULÉE':ended?'🏁 SOIRÉE TERMINÉE':'🎮 INSCRITS')+' · '+e.game;
 const lines=['## '+title,'',`📅 **Début** · <t:${Math.floor(Date.parse(e.starts_at)/1000)}:F>`,`👥 **Participation** · ${rows.length} / ${e.capacity} places`,'','### Les joueurs',...rows.map((r,i)=>`${i+1}. <@${r.mv_profiles.discord_id}> · ${labels[r.attendance]||'Inscrit'}`)];
 if(!rows.length)lines.push('Aucune personne inscrite pour le moment.');
 lines.push('','— **Multix** · Le Multivers');
 const chunks=[];let chunk='';for(const line of lines){if((chunk+'\n'+line).length>1900){chunks.push(chunk);chunk=''}chunk+=(chunk?'\n':'')+line;}if(chunk)chunks.push(chunk);
 const channel=settings.roster_channel_id;
 const existing=e.roster_channel_id===channel?[e.roster_message_id,...(e.roster_extra_message_ids||[])].filter(Boolean):[];
 const ids=[];
 for(let i=0;i<chunks.length;i++){
 const users=[...chunks[i].matchAll(/<@(\d+)>/g)].map(m=>m[1]);
 const data={content:chunks[i],embeds:i===chunks.length-1&&e.image_url?[{image:{url:e.image_url}}]:[],allowed_mentions:existing[i]?{parse:[]}:{parse:[],users}};
 if(existing[i]){await discord(`/channels/${channel}/messages/${existing[i]}`,'PATCH',data);ids.push(existing[i]);}
 else{const message=await discord(`/channels/${channel}/messages`,'POST',data);ids.push(message.id);}
 }
 for(const id of existing.slice(chunks.length))await discord(`/channels/${channel}/messages/${id}`,'DELETE');
 await db(`mv_events?id=eq.${eventId}`,'PATCH',{roster_message_id:ids[0],roster_extra_message_ids:ids.slice(1),roster_channel_id:channel});return {ok:true};
}
async function notifyAnnouncement(eventId){
 const e=(await db(`mv_events?id=eq.${eventId}`))[0];
 if(!e.published&&!e.announcement_message_id)return {skipped:true};
 const settings=(await db('mv_settings?id=eq.true'))[0];
 const channel=settings?.announcement_channel_id;if(!channel)return {configured:false};
 const data={content:e.is_test?'🧪 **TEST — aucune notification @everyone**':'@everyone',allowed_mentions:{parse:e.is_test?[]:['everyone']},embeds:[{title:(e.cancelled?'Soirée annulée · ':e.ends_at&&Date.parse(e.ends_at)<=Date.now()?'Soirée terminée · ':!e.published?'Soirée retirée · ':'Nouvelle soirée · ')+e.game,description:e.description||'Rejoins-nous pour une nouvelle soirée jeux !',color:e.cancelled?13848932:9854207,fields:[{name:'Début',value:`<t:${Math.floor(Date.parse(e.starts_at)/1000)}:F>`,inline:true},{name:'Places proposées',value:String(e.capacity),inline:true},{name:'Inscriptions',value:'[S’inscrire sur Le Multivers](https://cgasmj-blip.github.io/le-multivers/)'}],...(e.image_url?{image:{url:e.image_url}}:{}),footer:{text:'Multix · Le Multivers'}}]};
 if(e.announcement_message_id&&e.announcement_channel_id===channel){await discord(`/channels/${channel}/messages/${e.announcement_message_id}`,'PATCH',{...data,allowed_mentions:{parse:[]}});return {ok:true};}
 if(e.cancelled||!e.published)return {skipped:true};
 const message=await discord(`/channels/${channel}/messages`,'POST',data);
 await db(`mv_events?id=eq.${eventId}`,'PATCH',{announcement_message_id:message.id,announcement_channel_id:channel});return {ok:true};
}
async function safeAnnouncement(id){try{return await notifyAnnouncement(id)}catch(e){console.error('event-announcement',e.message);return {error:e.message}}}
async function safeNotify(eventId){try{return await notifyRoster(eventId)}catch(e){console.error('roster-notification',e.message);return {error:e.message}}}
function channelTypography(value,category=false){let base=value.normalize('NFKD');if(category)base=base.toUpperCase();else{let capitalized=false;base=Array.from(base.toLowerCase(),c=>{if(!capitalized&&/\p{L}/u.test(c)){capitalized=true;return c.toUpperCase()}return c}).join('')}return Array.from(base,c=>{const n=c.codePointAt(0);if(n>=65&&n<=90)return String.fromCodePoint(0x1D400+n-65);if(n>=97&&n<=122)return String.fromCodePoint(0x1D41A+n-97);if(n>=48&&n<=57)return String.fromCodePoint(0x1D7CE+n-48);return c}).slice(0,100).join('')}
function voiceName(game){return channelTypography('⭐・'+game)}
async function normalizeGuildChannels(){
 const channels=await discord(`/guilds/${GUILD}/channels`);const pending=channels.filter(c=>[0,2,4,5,13,15,16].includes(c.type)).map(c=>({id:c.id,name:c.name,next:channelTypography(c.name,c.type===4)})).filter(c=>c.name.normalize('NFC')!==c.next.normalize('NFC'));
 const results=[];for(const c of pending.slice(0,10)){try{await discord(`/channels/${c.id}`,'PATCH',{name:c.next});results.push({channel_id:c.id,name:c.next,ok:true})}catch(e){results.push({channel_id:c.id,ok:false,error:e.message});if(e.status===503)break;}}
 return {updated:results.filter(r=>r.ok).length,remaining:pending.length-results.filter(r=>r.ok).length,channels:results};
}
async function eventCategory(){
 const settings=(await db('mv_settings?id=eq.true'))[0];
 const first=await discord(`/channels/${settings.announcement_channel_id}`);
 const second=await discord(`/channels/${settings.roster_channel_id}`);
 if(first.guild_id!==GUILD||second.guild_id!==GUILD||!first.parent_id||first.parent_id!==second.parent_id)throw new HttpError('Les deux canaux doivent appartenir à la même catégorie Discord.',400);
 return first.parent_id;
}
async function ensureResources(eventId){
 let e=(await db(`mv_events?id=eq.${eventId}`))[0];
 if(!e||!e.published||e.cancelled||(e.ends_at&&Date.parse(e.ends_at)<=Date.now()))return;
 if(e.resources_owned&&e.role_id&&!e.role_deleted&&e.channel_id&&!e.channel_closed)return;
 if(!await db('rpc/mv_claim_resources','POST',{p_event:eventId}))throw new HttpError('Création du vocal déjà en cours. Réessaie dans un instant.',409);
 try{
 const parent=await eventCategory();
 if(!e.resources_owned||!e.role_id||e.role_deleted){const role=await discord(`/guilds/${GUILD}/roles`,'POST',{name:('⭐・Soirée — '+e.game).slice(0,100),permissions:'0',mentionable:false});
 await db(`mv_events?id=eq.${eventId}`,'PATCH',{role_id:role.id,resources_owned:true,role_deleted:false});e.role_id=role.id;}
 const bot=await discord('/users/@me');
 const channel=await discord(`/guilds/${GUILD}/channels`,'POST',{name:voiceName(e.game),type:2,parent_id:parent,permission_overwrites:[{id:GUILD,type:0,deny:'1049600',allow:'0'},{id:e.role_id,type:0,allow:'1049600',deny:'0'},{id:bot.id,type:1,allow:'1049600',deny:'0'}]});
 await db(`mv_events?id=eq.${eventId}`,'PATCH',{channel_id:channel.id,channel_closed:false,resource_error:null});
 }catch(err){await db(`mv_events?id=eq.${eventId}`,'PATCH',{resource_error:err.message});throw err;}
 finally{await db(`mv_events?id=eq.${eventId}`,'PATCH',{resources_busy_until:null});}
}
async function closeFinishedVocals(){
 const events=await db('mv_events?resources_owned=eq.true&or=(channel_closed.eq.false,role_deleted.eq.false)');
 let closed=0,failed=0;
 for(const e of events){if(e.published&&!e.cancelled&&(!e.ends_at||Date.parse(e.ends_at)>Date.now()))continue;
 const errors=[];
 if(!e.channel_closed){try{
 if(e.channel_id){const channel=await discord(`/channels/${e.channel_id}`);if(channel.guild_id!==GUILD||channel.type!==2)throw new Error('Le canal à fermer n’est pas le vocal prévu.');await discord(`/channels/${e.channel_id}`,'DELETE');}
 await db(`mv_events?id=eq.${e.id}`,'PATCH',{channel_closed:true});closed++;
 }catch(err){if(err.status===403){await db(`mv_events?id=eq.${e.id}`,'PATCH',{channel_closed:true});closed++;}else errors.push(err.message);}}
 if(!e.role_deleted){try{
 if(e.role_id)await discord(`/guilds/${GUILD}/roles/${e.role_id}`,'DELETE');
 await db(`mv_events?id=eq.${e.id}`,'PATCH',{role_deleted:true});
 await db(`mv_registrations?event_id=eq.${e.id}`,'PATCH',{role_granted:false,sync_error:null});
 }catch(err){if(err.status===403){await db(`mv_events?id=eq.${e.id}`,'PATCH',{role_deleted:true});await db(`mv_registrations?event_id=eq.${e.id}`,'PATCH',{role_granted:false,sync_error:null});}else errors.push(err.message);}}
 if(errors.length)failed++;
 await db(`mv_events?id=eq.${e.id}`,'PATCH',{resource_error:errors.length?errors.join(' · '):null});
 }
 return {closed,failed};
}
async function flushEventLogs(){
 const rows=await db('mv_cancellation_logs?message_id=is.null&order=cancelled_at.asc&limit=20');let sent=0,failed=0;
 for(const row of rows){try{
 const message=await discord(`/channels/${LOG_CHANNEL}/messages`,'POST',{allowed_mentions:{parse:[]},embeds:[{title:({programmation:'📅 Soirée programmée · ',annulation:'🚫 Soirée annulée · ',fin:'🏁 Soirée terminée · ',suppression:'🗑️ Soirée supprimée · ',restauration:'♻️ Soirée restaurée · '}[row.action]||'Soirée · ')+row.game,color:row.action==='annulation'?13848932:9854207,fields:[{name:({programmation:'Programmée par',annulation:'Annulée par',fin:'Terminée par',suppression:'Supprimée par',restauration:'Restaurée par'}[row.action]||'Auteur'),value:`<@${row.actor_discord_id}> · ${row.actor_name}`},{name:'Soirée prévue le',value:`<t:${Math.floor(Date.parse(row.starts_at)/1000)}:F>`},{name:'Action enregistrée le',value:`<t:${Math.floor(Date.parse(row.cancelled_at)/1000)}:F>`}],footer:{text:'Multix · Journal des événements'}}]});
 await db(`mv_cancellation_logs?id=eq.${row.id}`,'PATCH',{message_id:message.id,error:null});sent++;
 }catch(e){failed++;await db(`mv_cancellation_logs?id=eq.${row.id}`,'PATCH',{error:e.message});}}
 return {sent,failed};
}
async function syncRoles(){
 const leased=await db('rpc/mv_acquire_sync','POST',{});if(!leased)return {busy:true};
 let changed=0,failed=0;
 try{
 const rows=await db('rpc/mv_due_roles','POST',{});
 for(const row of rows){const e=row.mv_events;const desired=row.registered&&e.published&&!e.cancelled&&Date.now()>=Date.parse(e.starts_at)-1800000&&(!e.ends_at||Date.now()<Date.parse(e.ends_at));
 try{await discord(`/guilds/${GUILD}/members/${row.mv_profiles.discord_id}/roles/${e.role_id}`,desired?'PUT':'DELETE');await db(`mv_registrations?event_id=eq.${row.event_id}&user_id=eq.${row.user_id}`,'PATCH',{role_granted:desired,sync_error:null});changed++;}
 catch(err){failed++;await db(`mv_registrations?event_id=eq.${row.event_id}&user_id=eq.${row.user_id}`,'PATCH',{sync_error:err.message});}
 }
 const cleanup=await closeFinishedVocals();const logs=await flushEventLogs();let typography;try{typography=await normalizeGuildChannels()}catch(e){typography={error:e.message}}let community;try{community=await communityNotifications()}catch(e){community={error:e.message}}return {changed,failed:failed+cleanup.failed,closed:cleanup.closed,logs,typography,community};
 }finally{await db('rpc/mv_release_sync','POST',{});}
}
async function deleteStat(b,me){
 const kind=b.kind,id=uuid(b.id);if(!['event','poll','registration','vote','feedback'].includes(kind))throw new HttpError('Suppression invalide');
 const user=['registration','vote'].includes(kind)?uuid(b.user_id):null;
 const discordId=kind==='feedback'?String(b.discord_id||''):null;if(kind==='feedback'&&!/^\d{17,20}$/.test(discordId))throw new HttpError('Identifiant Discord invalide');
 if(kind==='event'){
 const e=(await db(`mv_events?id=eq.${id}`))[0];if(!e)throw new HttpError('Soirée introuvable',404);
 await db(`mv_events?id=eq.${id}`,'PATCH',{cancelled:true});
 await syncRoles();const current=(await db(`mv_events?id=eq.${id}`))[0];
 if(current.resources_owned&&((current.channel_id&&!current.channel_closed)||(current.role_id&&!current.role_deleted)))throw new HttpError('Le nettoyage Discord n’est pas terminé. Réessaie la suppression dans un instant.',409);
 await db('rpc/mv_queue_event_log','POST',{p_event:id,p_actor:me.discord_id,p_name:me.display_name,p_action:'suppression'});
 await safeAnnouncement(id);await safeNotify(id);
 }
 if(kind==='registration'){
 await db(`mv_registrations?event_id=eq.${id}&user_id=eq.${user}`,'PATCH',{registered:false,attendance:'unmarked'});await syncRoles();
 const r=(await db(`mv_registrations?event_id=eq.${id}&user_id=eq.${user}`))[0];if(r?.role_granted)throw new HttpError('Le retrait du rôle est encore en cours. Réessaie dans un instant.',409);
 }
 await db('rpc/mv_delete_stat','POST',{p_kind:kind,p_id:id,p_user:user,p_discord:discordId});
 if(kind==='registration')await safeNotify(id);
 if(kind==='event')await flushEventLogs();
 return {ok:true};
}
async function setupCommunity(){
 const parent=await eventCategory();let channels=await discord(`/guilds/${GUILD}/channels`);const settings=(await db('mv_settings?id=eq.true'))[0];
 const specs=[['reminder_channel_id','🔔・Rappels'],['winner_channel_id','🏆・Jeu gagnant'],['weekly_channel_id','📅・Planning'],['feedback_channel_id','💬・Bilans des soirées']];const patch={};
 for(const [key,label] of specs){const name=channelTypography(label);let ch=channels.find(c=>c.id===settings[key])||channels.find(c=>c.parent_id===parent&&c.type===0&&c.name.normalize('NFKC').toLowerCase()===name.normalize('NFKC').toLowerCase());
 if(!ch){ch=await discord(`/guilds/${GUILD}/channels`,'POST',{name,type:0,parent_id:parent});channels.push(ch)}patch[key]=ch.id;}
 const suggestions=channels.find(c=>{const n=c.name.normalize('NFKD').toLowerCase();return n.includes('suggest')&&n.includes('jeu')});if(suggestions)patch.suggestions_channel_id=suggestions.id;
 const app=await discord('/oauth2/applications/@me');if(app.verify_key)patch.discord_public_key=app.verify_key;
 await db('mv_settings?id=eq.true','PATCH',patch);
 const roster=channels.find(c=>c.id===settings.roster_channel_id);if(roster){const base=roster.position;const ordered=specs.map(([key],i)=>({id:patch[key],position:base+1+i}));await discord(`/guilds/${GUILD}/channels`,'PATCH',ordered)}
 const command=await discord(`/applications/1566913973687812286/guilds/${GUILD}/commands`,'POST',{name:'equipes',description:'Répartit par écrit les personnes présentes dans ce vocal.',type:1,options:[{type:4,name:'nombre',description:'Nombre d’équipes (2 par défaut)',required:false,min_value:2,max_value:10}]});
 let interactions;try{await discord('/applications/@me','PATCH',{interactions_endpoint_url:'https://ighxdlztzcifezqfxeyv.supabase.co/functions/v1/multivers-interactions'});interactions={active:true};}catch(e){interactions={active:false,error:e.message}}
 return {channels:patch,command_id:command.id,interactions,interactions_endpoint:'https://ighxdlztzcifezqfxeyv.supabase.co/functions/v1/multivers-interactions'};
}
async function sendOnce(key,channel,payload){
 if(!channel)return {configured:false};if(!await db('rpc/mv_claim_notification','POST',{p_key:key}))return {already_sent:true};
 try{const message=await discord(`/channels/${channel}/messages`,'POST',payload);await db(`mv_notifications?key=eq.${encodeURIComponent(key)}`,'PATCH',{message_id:message.id,error:null});return {ok:true,message_id:message.id}}
 catch(e){await db(`mv_notifications?key=eq.${encodeURIComponent(key)}`,'PATCH',{error:e.message});return {error:e.message}}
}
async function communityNotifications(){
 const settings=(await db('mv_settings?id=eq.true'))[0];let sent=0,failed=0;const results=[];
 const events=await db('mv_events?published=eq.true&cancelled=eq.false&ends_at=is.null&order=starts_at.asc');
 for(const e of events){const start=Date.parse(e.starts_at);if(Date.now()<start-1800000||Date.now()>=start)continue;
 const regs=await db(`mv_registrations?event_id=eq.${e.id}&registered=eq.true&select=mv_profiles(discord_id)`);const ids=regs.map(r=>r.mv_profiles.discord_id);
 for(let i=0;i<ids.length;i+=60){const group=ids.slice(i,i+60);const result=await sendOnce(`reminder:${e.id}:${i/60}`,settings.reminder_channel_id,{content:group.map(id=>`<@${id}>`).join(' '),allowed_mentions:{parse:[],users:group},embeds:[{title:'🔔 La soirée commence bientôt · '+e.game,description:`Rendez-vous <t:${Math.floor(start/1000)}:R> !\n\n`+(e.channel_id?`[Rejoindre le vocal](https://discord.com/channels/${GUILD}/${e.channel_id})`:'[Ouvrir Le Multivers](https://cgasmj-blip.github.io/le-multivers/)'),...(e.image_url?{image:{url:e.image_url}}:{}),footer:{text:'Multix · Bon jeu à tous !'}}]});results.push(result);}
 }
 // Only newly closed polls are announced, with a 7-day recovery window.
 const polls=await db('mv_polls?published=eq.true&select=*,mv_options(*)&closes_at=gte.'+encodeURIComponent(settings.features_live_at)+'&closes_at=lte.'+encodeURIComponent(new Date().toISOString())+'&closes_at=gte.'+encodeURIComponent(new Date(Date.now()-7*86400000).toISOString()));
 for(const p of polls){const votes=await db(`mv_votes?poll_id=eq.${p.id}&select=option_id`);if(!votes.length)continue;const scores=p.mv_options.map(o=>({...o,count:votes.filter(v=>v.option_id===o.id).length})).sort((a,b)=>b.count-a.count);const winners=scores.filter(o=>o.count===scores[0]?.count);const desc=scores.map(o=>`**${o.game}** · ${o.count} vote(s) · ${Math.round(o.count/votes.length*100)} %`).join('\n');results.push(await sendOnce('winner:'+p.id,settings.winner_channel_id,{allowed_mentions:{parse:[]},embeds:[{title:'🏆 '+(winners.length>1?'Égalité pour le jeu de la semaine':'Le jeu gagnant · '+winners[0].game),description:(winners.length>1?'Jeux à égalité : '+winners.map(w=>w.game).join(', ')+'\n\n':'')+desc,color:15844367,...(winners.length===1&&winners[0].image_url?{image:{url:winners[0].image_url}}:{}),footer:{text:`Multix · ${votes.length} votant(s)`}}]}));}
 const finished=await db('mv_events?cancelled=eq.false&ends_at=not.is.null&ends_at=gte.'+encodeURIComponent(settings.features_live_at));
 for(const e of finished){if(Date.parse(e.ends_at)>Date.now())continue;results.push(await sendOnce('feedback:'+e.id,settings.feedback_channel_id,{allowed_mentions:{parse:[]},content:'## 💬 Bilan · '+e.game+'\nLa soirée est terminée ! Qu’en as-tu pensé ?\nClique sur le bouton pour donner une note et laisser un commentaire aux animateurs.',components:[{type:1,components:[{type:2,style:1,label:'Donner mon avis',custom_id:'review:'+e.id}]}]}));}
 const now=new Date(),parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Paris',weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
 if(parts.weekday==='Sun'&&Number(parts.hour)>=18){const upcoming=events.filter(e=>Date.parse(e.starts_at)>Date.now()&&Date.parse(e.starts_at)<Date.now()+8*86400000);const active=await db('mv_polls?published=eq.true&select=*,mv_options(*)&closes_at=gt.'+encodeURIComponent(now.toISOString()));
 const programme=upcoming.length?upcoming.map(e=>`• **${e.game}** — <t:${Math.floor(Date.parse(e.starts_at)/1000)}:F>`).join('\n'):'Les prochaines soirées seront annoncées ici.';
 const choices=active.length?active.map(p=>`**${p.title}** : ${p.mv_options.map(o=>o.game).join(', ')}`).join('\n'):'Les propositions pour le prochain vote arrivent bientôt.';
 results.push(await sendOnce(`weekly:${parts.year}-${parts.month}-${parts.day}`,settings.weekly_channel_id,{allowed_mentions:{parse:[]},embeds:[{title:'📅 Cette semaine dans Le Multivers',description:('### Les soirées à venir\n'+programme+'\n\n### Les jeux proposés au vote\n'+choices+'\n\n[Voir le panel](https://cgasmj-blip.github.io/le-multivers/)'+(settings.suggestions_channel_id?` · [Suggérer un jeu](https://discord.com/channels/${GUILD}/${settings.suggestions_channel_id})`:'')).slice(0,4096),color:9854207,footer:{text:'Multix · Votre rendez-vous du dimanche à 18 h'}}]}));}
 for(const r of results){if(r.ok)sent++;if(r.error)failed++;}return {sent,failed};
}

Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{headers:cors});
 try{
 if(req.method!=='POST')throw new HttpError('Méthode non autorisée',405);
 if(Number(req.headers.get('content-length'))>4600000)throw new HttpError('Fichier trop volumineux',413);
 const raw=await req.text();if(raw.length>4600000)throw new HttpError('Fichier trop volumineux',413);
 let b;try{b=JSON.parse(raw)}catch{throw new HttpError('Requête invalide')}
 const action=b.action;
 if(action==='availability'){
 if(!Array.isArray(b.event_ids)||b.event_ids.length>3)throw new HttpError('Liste de soirées invalide');
 const ids=b.event_ids.map(uuid);if(!ids.length)return new Response('[]',{headers:cors});
 const events=await db(`mv_events?id=in.(${ids.join(',')})&published=eq.true&cancelled=eq.false&select=id,capacity`);
 const registrations=await db(`mv_registrations?event_id=in.(${events.map(e=>e.id).join(',')||'00000000-0000-0000-0000-000000000000'})&registered=eq.true&select=event_id`);
 return new Response(JSON.stringify(events.map(e=>{const enrolled=registrations.filter(r=>r.event_id===e.id).length;return {event_id:e.id,capacity:e.capacity,enrolled,remaining:Math.max(0,e.capacity-enrolled)}})),{headers:cors});
 }

 if(action==='sync'||action==='check-discord'||action==='test-messages'||action==='check-category'||action==='test-session'||action==='rename-event-voices'||action==='normalize-channels'||action==='setup-community'||action==='inspect-recovery'||action==='restore-programme'){
 const secret=req.headers.get('x-cron-secret');if(!secret||!await db('rpc/mv_verify_cron','POST',{p_secret:secret}))throw new HttpError('Accès interdit',403);
 if(action==='inspect-recovery'||action==='restore-programme'){
 const settings=(await db('mv_settings?id=eq.true'))[0];const messages=await discord(`/channels/${settings.announcement_channel_id}/messages?limit=100`);
 const message=messages.find(m=>m.author?.id==='1566913973687812286'&&m.embeds?.some(e=>e.title?.normalize('NFKC').toLowerCase().includes('dead by daylight')));
 if(!message)throw new HttpError('Annonce Dead by Daylight introuvable dans les messages récents.',404);
 const embed=message.embeds.find(e=>e.title?.normalize('NFKC').toLowerCase().includes('dead by daylight'));
 const rosterMessages=await discord(`/channels/${settings.roster_channel_id}/messages?limit=100`);
 const roster=rosterMessages.find(m=>m.author?.id==='1566913973687812286'&&m.content?.normalize('NFKC').toLowerCase().includes('dead by daylight'));
 const ids=roster?[...new Set([...roster.content.matchAll(/<@(\d{17,20})>/g)].map(m=>m[1]))]:[];
 if(action==='restore-programme'&&Array.isArray(b.participant_ids)){for(const id of b.participant_ids)if(typeof id==='string'&&/^\d{17,20}$/.test(id)&&!ids.includes(id))ids.push(id);}
 const recovered={message_id:message.id,embed,roster_message_id:roster?.id||null,participant_ids:ids};
 if(action==='inspect-recovery')return new Response(JSON.stringify(recovered),{headers:cors});
 const timestamp=embed.fields?.find(f=>f.name==='Début')?.value.match(/<t:(\d+)/)?.[1];const capacity=Number(embed.fields?.find(f=>f.name==='Places proposées')?.value);
 if(!timestamp||!Number.isInteger(capacity)||capacity<1||capacity>100)throw new HttpError('Les détails récupérés sont incomplets.',400);
 let event=(await db('mv_events?game=eq.Dead%20by%20daylight&cancelled=eq.false&ends_at=is.null&limit=1'))[0];
 if(!event)event=(await db('mv_events','POST',{game:'Dead by daylight',description:embed.description||'',image_url:embed.image?.url||'',capacity,starts_at:new Date(Number(timestamp)*1000).toISOString(),published:true,cancelled:false,announcement_message_id:message.id,announcement_channel_id:settings.announcement_channel_id,roster_message_id:roster?.id||null,roster_channel_id:roster?settings.roster_channel_id:null}))[0];
 await ensureResources(event.id);const restored=[],failed=[];
 for(const id of ids){const profile=(await db(`mv_profiles?discord_id=eq.${id}`))[0];if(profile){try{await db('rpc/mv_register','POST',{p_event:event.id,p_user:profile.user_id,p_registered:true});restored.push(id)}catch(e){failed.push({discord_id:id,error:e.message})}}}
 const announcement=await safeAnnouncement(event.id),participants=await safeNotify(event.id);await syncRoles();
 return new Response(JSON.stringify({event:(await db(`mv_events?id=eq.${event.id}`))[0],restored,failed,announcement,participants}),{headers:cors});
 }
 if(action==='setup-community')return new Response(JSON.stringify(await setupCommunity()),{headers:cors});
 if(action==='normalize-channels')return new Response(JSON.stringify(await normalizeGuildChannels()),{headers:cors});
 if(action==='rename-event-voices'){
 const events=await db('mv_events?resources_owned=eq.true&channel_closed=eq.false&channel_id=not.is.null');const results=[];
 for(const e of events){try{const channel=await discord(`/channels/${e.channel_id}`);if(channel.guild_id!==GUILD||channel.type!==2)throw new HttpError('Ce canal ne correspond pas au vocal prévu.',400);const name=voiceName(e.game);if(channel.name!==name)await discord(`/channels/${e.channel_id}`,'PATCH',{name});results.push({channel_id:e.channel_id,name,ok:true});}catch(err){results.push({channel_id:e.channel_id,ok:false,error:err.message});}}
 return new Response(JSON.stringify({channels:results}),{headers:cors});
 }
 if(action==='test-session'){
 const target='497181585989435392';const member=await discord(`/guilds/${GUILD}/members/${target}`);
 const profile=(await db(`mv_profiles?discord_id=eq.${target}`))[0];if(!profile)throw new HttpError('Cette personne doit d’abord se connecter au panel.',400);
 let event=(await db('mv_events?is_test=eq.true&game=eq.Test%20complet%20Multix&cancelled=eq.false&ends_at=is.null&limit=1'))[0];
 if(!event)event=(await db('mv_events','POST',{game:'Test complet Multix',description:'🧪 Soirée de test visible sur le panel · une seule place · participante : Heavenna. Test du vocal, du rôle temporaire et de la liste des inscrits.',image_url:'https://cgasmj-blip.github.io/le-multivers/assets/multivers.webp',starts_at:new Date(Date.now()+60000).toISOString(),capacity:1,published:true,sort_order:-100,is_test:true}))[0];
 await ensureResources(event.id);const announcement=await safeAnnouncement(event.id);
 await db('rpc/mv_register','POST',{p_event:event.id,p_user:profile.user_id,p_registered:true});
 const sync=await syncRoles();const roster=await safeNotify(event.id);
 const current=(await db(`mv_events?id=eq.${event.id}`))[0];
 const registered=(await db(`mv_registrations?event_id=eq.${event.id}&user_id=eq.${profile.user_id}`))[0];
 const confirmation=await discord(`/guilds/${GUILD}/members/${target}`);
 let logTest;try{const message=await discord(`/channels/${LOG_CHANNEL}/messages`,'POST',{content:'🧪 **TEST DU CANAL LOGS**\nLes programmations, annulations et fins de soirée seront journalisées avec leur auteur, la date prévue et la date et l’heure de l’action.\n*Aucune soirée n’a été annulée par ce test.*',allowed_mentions:{parse:[]}});logTest={ok:true,message_id:message.id};}catch(e){logTest={ok:false,error:e.message};}
 return new Response(JSON.stringify({event_id:event.id,starts_at:event.starts_at,participant:target,role_id:current.role_id,channel_id:current.channel_id,role_present:confirmation.roles.includes(current.role_id),registered:registered.registered,announcement,roster,sync,logTest}),{headers:cors});
 }
 if(action==='check-category')return new Response(JSON.stringify({category_id:await eventCategory()}),{headers:cors});
 if(action==='test-messages'){
 const settings=(await db('mv_settings?id=eq.true'))[0];
 const when=Math.floor(Date.now()/1000)+3600;
 const results=[];
 const samples=[{channel:settings.announcement_channel_id,payload:{content:'🧪 **TEST DE PROGRAMMATION — aucune notification envoyée**\n@everyone',allowed_mentions:{parse:[]},embeds:[{title:'Nouvelle soirée · Soirée jeux du Multivers',description:'On se retrouve pour jouer ensemble, découvrir un jeu et partager de bons moments !\n\n*Message de démonstration : aucune inscription réelle.*',color:9854207,fields:[{name:'Début',value:`<t:${when}:F>`,inline:true},{name:'Places proposées',value:'3',inline:true},{name:'Inscriptions',value:'[S’inscrire sur Le Multivers](https://cgasmj-blip.github.io/le-multivers/)'}],image:{url:'https://cgasmj-blip.github.io/le-multivers/assets/multivers.webp'},footer:{text:'Multix · Le Multivers · TEST'}}]}},
 {channel:settings.roster_channel_id,payload:{content:`## 🎮 INSCRITS · Soirée jeux du Multivers\n\n🧪 **TEST — joueurs fictifs, aucune notification envoyée**\n\n📅 **Début** · <t:${when}:F>\n👥 **Participation** · 3 / 3 places\n\n### Les joueurs\n1. **Exemple · Alex**\n2. **Exemple · Sam**\n3. **Exemple · Camille**\n\n— **Multix** · Le Multivers`,allowed_mentions:{parse:[]},embeds:[{image:{url:'https://cgasmj-blip.github.io/le-multivers/assets/multivers.webp'}}]}}];
 for(const sample of samples){try{const previous=sample.channel==='1564005454961578114'?'1566934021269749811':'1566934022461071475';const message=await discord(`/channels/${sample.channel}/messages`+(b.update_existing?'/'+previous:''),b.update_existing?'PATCH':'POST',sample.payload);results.push({channel_id:sample.channel,message_id:message.id,ok:true})}catch(e){results.push({channel_id:sample.channel,ok:false,error:e.message})}}
 return new Response(JSON.stringify({tests:results}),{headers:cors});
 }
 if(action==='check-discord'){
 const token=Deno.env.get('DISCORD_BOT_TOKEN')?.trim();
 if(!token)return new Response(JSON.stringify({configured:false}),{headers:cors});
 const headers={Authorization:`Bot ${token}`};
 const botResponse=await fetch('https://discord.com/api/v10/users/@me',{headers});
 const info={configured:true,bot_status:botResponse.status};
 if(botResponse.ok){const bot=await botResponse.json();info.bot_id=bot.id;info.expected_bot=bot.id==='1566913973687812286';
 const guildResponse=await fetch(`https://discord.com/api/v10/guilds/${GUILD}`,{headers});info.guild_status=guildResponse.status;}
 return new Response(JSON.stringify(info),{headers:cors});
 }
 return new Response(JSON.stringify(await syncRoles()),{headers:cors});
 }
 const me=await identity(req);
 if(action==='me')return new Response(JSON.stringify(me),{headers:cors});
 let result={ok:true};
 if(action==='mine')result={registrations:await db(`mv_registrations?user_id=eq.${me.user_id}`),votes:await db(`mv_votes?user_id=eq.${me.user_id}`)};
 else if(action==='register'){
 await db('rpc/mv_register','POST',{p_event:uuid(b.event_id),p_user:me.user_id,p_registered:b.registered===true});
 result={ok:true,sync:await syncRoles(),notification:await safeNotify(uuid(b.event_id))};
 }else if(action==='vote')await db('rpc/mv_vote','POST',{p_poll:uuid(b.poll_id),p_user:me.user_id,p_option:uuid(b.option_id)});
 else if(action!=='mine'){
 if(!me.manager)throw new HttpError('Ce rôle ne permet pas la gestion des événements.',403);
 if(action==='delete-stat')result=await deleteStat(b,me);
 else if(action==='admin')result={events:await db('mv_events?order=starts_at.asc'),polls:await db('mv_polls?select=*,mv_options(*)&order=opens_at.desc'),votes:await db('mv_votes?select=*,mv_profiles(display_name,discord_id),mv_options(game)'),registrations:await db('mv_registrations?select=*,mv_profiles(display_name,discord_id)'),settings:(await db('mv_settings?id=eq.true'))[0],profiles:await db('mv_profiles?select=user_id,blocked_until'),feedback:await db('mv_feedback?select=*,mv_events(game)&order=created_at.desc')};
 else if(action==='attendance'){
 await db('rpc/mv_attendance','POST',{p_event:uuid(b.event_id),p_user:uuid(b.user_id),p_mark:b.mark});
 result={ok:true,notification:await safeNotify(uuid(b.event_id))};
 }else if(action==='roster-channel'){
 if(typeof b.channel_id!=='string'||!/^\d{17,20}$/.test(b.channel_id))throw new HttpError('ID de canal invalide');
 const channel=await discord(`/channels/${b.channel_id}`);
 if(channel.guild_id!==GUILD||![0,5].includes(channel.type))throw new HttpError('Choisis un canal texte de ce serveur');
 await db('mv_settings?id=eq.true','PATCH',{roster_channel_id:b.channel_id});
 }else if(action==='send-roster')result=await notifyRoster(uuid(b.event_id));
 else if(action==='finish-event'){
 await db('rpc/mv_finish_event','POST',{p_event:uuid(b.event_id)});await db('rpc/mv_queue_event_log','POST',{p_event:uuid(b.event_id),p_actor:me.discord_id,p_name:me.display_name,p_action:'fin'});result={ok:true,sync:await syncRoles(),notification:await safeNotify(uuid(b.event_id)),announcement:await safeAnnouncement(uuid(b.event_id))};
 }else if(action==='save-event'){
 const start=new Date(b.starts_at);if(!Number.isFinite(+start))throw new HttpError('Date de début invalide');const capacity=Number(b.capacity);if(!Number.isInteger(capacity)||capacity<1||capacity>100)throw new HttpError('Nombre de places invalide');
 const data={game:text(b.game),description:typeof b.description==='string'?b.description.slice(0,2000):'',image_url:image(b.image_url),starts_at:start.toISOString(),capacity,published:b.published===true,cancelled:b.cancelled===true,sort_order:Number.isInteger(Number(b.sort_order))?Number(b.sort_order):0};
 let e;if(b.id){e=(await db(`mv_events?id=eq.${uuid(b.id)}`))[0];if(!e)throw new HttpError('Soirée introuvable',404);const count=await db(`mv_registrations?event_id=eq.${e.id}&registered=eq.true`);if(count.length>capacity)throw new HttpError('La capacité est inférieure au nombre d’inscrits');}

 const requestedCancellation=data.cancelled;if(e)delete data.cancelled;
 if(e)result=(await db(`mv_events?id=eq.${e.id}`,'PATCH',data))[0];else result=(await db('mv_events','POST',data))[0];
 if(e){await db('rpc/mv_cancel_event','POST',{p_event:e.id,p_cancelled:requestedCancellation,p_actor:me.discord_id,p_name:me.display_name});result=(await db(`mv_events?id=eq.${e.id}`))[0];}
 if(result.published&&!result.cancelled&&(!e||!e.published))await db('rpc/mv_queue_event_log','POST',{p_event:result.id,p_actor:me.discord_id,p_name:me.display_name,p_action:'programmation'});
 if(result.published)await ensureResources(result.id);
 await syncRoles();
 result={...result,notification:await safeNotify(result.id),announcement:await safeAnnouncement(result.id)};
 }else if(action==='save-poll'){
 const [start,end]=dates(b.opens_at,b.closes_at);const data={title:text(b.title),opens_at:start,closes_at:end,published:b.published===true};
 if(!Array.isArray(b.options)||b.options.length<2||b.options.length>10)throw new HttpError('Choisis entre 2 et 10 jeux');
 const options=b.options.map((o,i)=>({game:text(o.game),image_url:image(o.image_url),sort_order:i}));
 // Atomic RPC locks the poll and refuses rewriting options once voting has started.
 result=await db('rpc/mv_save_poll','POST',{p_id:b.id?uuid(b.id):null,p_title:data.title,p_opens:start,p_closes:end,p_published:data.published,p_options:options});
 }else if(action==='poll-status'){
 const id=uuid(b.id);result=await db(`mv_polls?id=eq.${id}`,'PATCH',{published:b.published===true});
 }else if(action==='upload'){
 if(!['image/png','image/jpeg','image/webp'].includes(b.type)||typeof b.data!=='string'||b.data.length>4200000)throw new HttpError('Image PNG, JPEG ou WebP, 3 Mo maximum');
 const bytes=Uint8Array.from(atob(b.data),c=>c.charCodeAt(0));if(bytes.length>3145728)throw new HttpError('Image trop volumineuse');
 const png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71;
 const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 const webp=String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
 if(!(b.type==='image/png'&&png||b.type==='image/jpeg'&&jpg||b.type==='image/webp'&&webp))throw new HttpError('Le contenu ne correspond pas à une image autorisée');
 const name=crypto.randomUUID()+'.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[b.type]);
 const r=await fetch(`${URL}/storage/v1/object/multivers-images/${name}`,{method:'POST',headers:{Authorization:`Bearer ${KEY}`,apikey:KEY,'Content-Type':b.type},body:bytes});if(!r.ok)throw new HttpError('Impossible d’enregistrer l’image',502);
 result={url:`${URL}/storage/v1/object/public/multivers-images/${name}`};
 }else throw new HttpError('Action inconnue');
 }
 return new Response(JSON.stringify(result),{headers:cors});
 }catch(e){console.error('multivers-api',e.status||500,e.message);return new Response(JSON.stringify({error:e instanceof HttpError?e.message:'Erreur du serveur. Réessaie dans quelques instants.'}),{status:e.status||500,headers:cors});}
});

