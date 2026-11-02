const GUILD='1187492291892486195', MANAGER='1564000010247475270';
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
 const labels={present:'Présent',absent:'Absent',excused:'Excusé',unmarked:'Inscrit'};
 const description=rows.length?rows.map((r,i)=>`${i+1}. <@${r.mv_profiles.discord_id}> · ${labels[r.attendance]||'Inscrit'}`).join('\n'):'Aucune personne inscrite pour le moment.';
 const data={content:rows.slice(0,75).map(r=>`<@${r.mv_profiles.discord_id}>`).join(' '),allowed_mentions:{parse:[],users:rows.slice(0,75).map(r=>r.mv_profiles.discord_id)},embeds:[{title:(e.cancelled?'Annulée · ':'Inscrits · ')+e.game,description:description.slice(0,4096),color:9854207,fields:[{name:'Début',value:`<t:${Math.floor(Date.parse(e.starts_at)/1000)}:F>`},{name:'Participation',value:`${rows.length} / ${e.capacity} places`}],footer:{text:'Le Multivers · liste mise à jour automatiquement'},...(e.image_url?{image:{url:e.image_url}}:{})}]};
 const channel=settings.roster_channel_id;
 if(e.roster_message_id&&e.roster_channel_id===channel){
 try{await discord(`/channels/${channel}/messages/${e.roster_message_id}`,'PATCH',{...data,allowed_mentions:{parse:[]}});return {ok:true};}catch(err){if(err.status!==403)throw err;}
 }
 const message=await discord(`/channels/${channel}/messages`,'POST',data);
 if(rows.length>75){const rest=rows.slice(75);await discord(`/channels/${channel}/messages`,'POST',{content:rest.map(r=>`<@${r.mv_profiles.discord_id}>`).join(' '),allowed_mentions:{parse:[],users:rest.map(r=>r.mv_profiles.discord_id)}});}
 await db(`mv_events?id=eq.${eventId}`,'PATCH',{roster_message_id:message.id,roster_channel_id:channel});return {ok:true};
}
async function notifyAnnouncement(eventId){
 const e=(await db(`mv_events?id=eq.${eventId}`))[0];
 if(!e.published&&!e.announcement_message_id)return {skipped:true};
 const settings=(await db('mv_settings?id=eq.true'))[0];
 const channel=settings?.announcement_channel_id;if(!channel)return {configured:false};
 const data={content:'@everyone',allowed_mentions:{parse:['everyone']},embeds:[{title:(e.cancelled?'Soirée annulée · ':!e.published?'Soirée retirée · ':'Nouvelle soirée · ')+e.game,description:e.description||'Rejoins-nous pour une nouvelle soirée jeux !',color:e.cancelled?13848932:9854207,fields:[{name:'Début',value:`<t:${Math.floor(Date.parse(e.starts_at)/1000)}:F>`,inline:true},{name:'Fin',value:`<t:${Math.floor(Date.parse(e.ends_at)/1000)}:t>`,inline:true},{name:'Places proposées',value:String(e.capacity),inline:true},{name:'Inscriptions',value:'[S’inscrire sur Le Multivers](https://cgasmj-blip.github.io/le-multivers/)'}],...(e.image_url?{image:{url:e.image_url}}:{}),footer:{text:'Multix · Le Multivers'}}]};
 if(e.announcement_message_id&&e.announcement_channel_id===channel){await discord(`/channels/${channel}/messages/${e.announcement_message_id}`,'PATCH',{...data,allowed_mentions:{parse:[]}});return {ok:true};}
 if(e.cancelled||!e.published)return {skipped:true};
 const message=await discord(`/channels/${channel}/messages`,'POST',data);
 await db(`mv_events?id=eq.${eventId}`,'PATCH',{announcement_message_id:message.id,announcement_channel_id:channel});return {ok:true};
}
async function safeAnnouncement(id){try{return await notifyAnnouncement(id)}catch(e){console.error('event-announcement',e.message);return {error:e.message}}}
async function safeNotify(eventId){try{return await notifyRoster(eventId)}catch(e){console.error('roster-notification',e.message);return {error:e.message}}}
async function syncRoles(){
 // A database lease avoids overlapping cron runs; expires automatically after 90 seconds.
 const leased=await db('rpc/mv_acquire_sync','POST',{});if(!leased)return {busy:true};
 let changed=0,failed=0;
 try{
 const rows=await db('rpc/mv_due_roles','POST',{});
 for(const row of rows){const e=row.mv_events;const desired=row.registered&&e.published&&!e.cancelled&&Date.now()>=Date.parse(e.starts_at)&&Date.now()<Date.parse(e.ends_at);
 if(desired===row.role_granted)continue;
 try{if(!e.role_id)throw new Error('Le rôle de la soirée manque');
 await discord(`/guilds/${GUILD}/members/${row.mv_profiles.discord_id}/roles/${e.role_id}`,desired?'PUT':'DELETE');
 await db(`mv_registrations?event_id=eq.${row.event_id}&user_id=eq.${row.user_id}`,'PATCH',{role_granted:desired,sync_error:null});changed++;
 }catch(err){failed++;await db(`mv_registrations?event_id=eq.${row.event_id}&user_id=eq.${row.user_id}`,'PATCH',{sync_error:String(err.message).slice(0,300)});}
 }
 return {changed,failed};
 }finally{await db('rpc/mv_release_sync','POST',{});}
}
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{headers:cors});
 try{
 if(req.method!=='POST')throw new HttpError('Méthode non autorisée',405);
 if(Number(req.headers.get('content-length'))>4600000)throw new HttpError('Fichier trop volumineux',413);
 const raw=await req.text();if(raw.length>4600000)throw new HttpError('Fichier trop volumineux',413);
 let b;try{b=JSON.parse(raw)}catch{throw new HttpError('Requête invalide')}
 const action=b.action;
 if(action==='sync'||action==='check-discord'){
 const secret=req.headers.get('x-cron-secret');if(!secret||!await db('rpc/mv_verify_cron','POST',{p_secret:secret}))throw new HttpError('Accès interdit',403);
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
 if(action==='admin')result={events:await db('mv_events?order=starts_at.asc'),polls:await db('mv_polls?select=*,mv_options(*)&order=opens_at.desc'),votes:await db('mv_votes?select=*,mv_profiles(display_name,discord_id),mv_options(game)'),registrations:await db('mv_registrations?select=*,mv_profiles(display_name,discord_id)'),settings:(await db('mv_settings?id=eq.true'))[0]};
 else if(action==='attendance'){
 await db('rpc/mv_attendance','POST',{p_event:uuid(b.event_id),p_user:uuid(b.user_id),p_mark:b.mark});
 result={ok:true,notification:await safeNotify(uuid(b.event_id))};
 }else if(action==='roster-channel'){
 if(typeof b.channel_id!=='string'||!/^\d{17,20}$/.test(b.channel_id))throw new HttpError('ID de canal invalide');
 const channel=await discord(`/channels/${b.channel_id}`);
 if(channel.guild_id!==GUILD||![0,5].includes(channel.type))throw new HttpError('Choisis un canal texte de ce serveur');
 await db('mv_settings?id=eq.true','PATCH',{roster_channel_id:b.channel_id});
 }else if(action==='send-roster')result=await notifyRoster(uuid(b.event_id));
 else if(action==='save-event'){
 const [start,end]=dates(b.starts_at,b.ends_at);const capacity=Number(b.capacity);if(!Number.isInteger(capacity)||capacity<1||capacity>100)throw new HttpError('Nombre de places invalide');
 const data={game:text(b.game),description:typeof b.description==='string'?b.description.slice(0,2000):'',image_url:image(b.image_url),starts_at:start,ends_at:end,capacity,published:b.published===true,cancelled:b.cancelled===true,sort_order:Number.isInteger(Number(b.sort_order))?Number(b.sort_order):0};
 let e;if(b.id){e=(await db(`mv_events?id=eq.${uuid(b.id)}`))[0];if(!e)throw new HttpError('Soirée introuvable',404);const count=await db(`mv_registrations?event_id=eq.${e.id}&registered=eq.true`);if(count.length>capacity)throw new HttpError('La capacité est inférieure au nombre d’inscrits');}
 // Roles/channels are bot-created, never arbitrary permission-bearing roles supplied by a client.
 if(data.published&&!e?.role_id){
 const role=await discord(`/guilds/${GUILD}/roles`,'POST',{name:'Soirée · '+data.game,permissions:'0',mentionable:false});
 let ch;try{const bot=await discord('/users/@me');ch=await discord(`/guilds/${GUILD}/channels`,'POST',{name:'Soirée · '+data.game,type:2,permission_overwrites:[{id:GUILD,type:0,deny:'1049600',allow:'0'},{id:role.id,type:0,allow:'1049600',deny:'0'},{id:bot.id,type:1,allow:'1049600',deny:'0'}]});}catch(err){await discord(`/guilds/${GUILD}/roles/${role.id}`,'DELETE');throw err;}
 Object.assign(data,{role_id:role.id,channel_id:ch.id});
 }
 if(e)result=(await db(`mv_events?id=eq.${e.id}`,'PATCH',data))[0];else result=(await db('mv_events','POST',data))[0];
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
