import { OAuth2Client, type Credentials } from 'google-auth-library';
import { simpleParser } from 'mailparser';
import type { Connection } from '@prisma/client';
import { db, json, object } from './db';
import { appUrl } from './config';
import { AppError, encrypt, decrypt, safeHtml, safeProviderError } from './security';
import { put } from './store';

export const GOOGLE_SCOPES: Record<string,string[]> = {
  mail:['https://www.googleapis.com/auth/gmail.modify'],
  calendar:['https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/calendar.calendarlist.readonly','https://www.googleapis.com/auth/calendar.freebusy'],
  tasks:['https://www.googleapis.com/auth/tasks'],
  contacts:['https://www.googleapis.com/auth/contacts.readonly'],
  files:['https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/drive.readonly','https://www.googleapis.com/auth/documents','https://www.googleapis.com/auth/spreadsheets','https://www.googleapis.com/auth/presentations'],
};
export function oauthClient() {return new OAuth2Client(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET,`${appUrl()}/api/auth/callback`);}
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export async function api(conn:Connection,path:string,init:RequestInit={},extraHeaders:Record<string,string>={}) {
  if(!conn.credentials)throw new AppError('reconnect_required','Reconnect this Google account.',409);
  const client=oauthClient();const saved=decrypt<Credentials>(conn.credentials);client.setCredentials(saved);
  let token:string|null|undefined;
  try {token=(await client.getAccessToken()).token;}catch(e){throw safeProviderError(e);}
  if(!token)throw new AppError('reconnect_required','Reconnect this Google account.',409);
  if(client.credentials.access_token!==saved.access_token)await db.connection.update({where:{id:conn.id},data:{credentials:encrypt({...saved,...client.credentials})}});
  const bases:Record<string,string>={gmail:'https://gmail.googleapis.com/gmail/v1/users/me',calendar:'https://www.googleapis.com/calendar/v3',tasks:'https://tasks.googleapis.com/tasks/v1',people:'https://people.googleapis.com/v1',drive:'https://www.googleapis.com/drive/v3',docs:'https://docs.googleapis.com/v1',sheets:'https://sheets.googleapis.com/v4',slides:'https://slides.googleapis.com/v1'};
  const area=path.slice(0,path.indexOf('/'));const base=bases[area];if(!base)throw new AppError('validation_failed','Unknown Google service.',422);
  let res:Response;
  for(let attempt=0;;attempt++){
    res=await fetch(base+path.slice(area.length),{...init,headers:{Authorization:`Bearer ${token}`,...(init.body?{'Content-Type':'application/json'}:{}),...extraHeaders},signal:AbortSignal.timeout(25000)});
    if(res.ok)break;
    const err:any=await res.json().catch(()=>({}));
    const reasons=[...(err.error?.errors||[]),...(err.error?.details||[])].map((e:any)=>e.reason);
    const limited=res.status===429||res.status===403&&reasons.some((r:string)=>['rateLimitExceeded','userRateLimitExceeded','RATE_LIMIT_EXCEEDED'].includes(r));
    const mapped=safeProviderError({code:limited?429:res.status});
    // Only reads can be replayed. A failed send or mutation may have reached Google.
    if(limited&&['GET','HEAD'].includes((init.method||'GET').toUpperCase())&&attempt<6){
      const retryAfter=res.headers.get('retry-after');
      const suggested=retryAfter?(Number.isFinite(Number(retryAfter))?Number(retryAfter)*1000:Date.parse(retryAfter)-Date.now()):0;
      const backoff=Math.min(32000,1000*2**attempt+Math.floor(Math.random()*1000));
      await pause(Math.min(60000,Math.max(backoff,Number.isFinite(suggested)?suggested:0)));
      continue;
    }
    if(res.status===401)await db.connection.update({where:{id:conn.id},data:{status:'reconnect_required',error:mapped.message}});
    throw mapped;
  }
  if(res.status===204)return null;
  if(res.headers.get('content-type')?.includes('application/json'))return res.json();
  return res.text();
}
export async function pages(conn:Connection,path:string,key:string) {
  const items:any[]=[];let next='';do{const data=await api(conn,path+(next?`${path.includes('?')?'&':'?'}pageToken=${encodeURIComponent(next)}`:''));items.push(...(data[key]||[]));next=data.nextPageToken||'';}while(next);return items;
}
export const enc=(v:string)=>encodeURIComponent(v);
const addresses=(v:any)=>v?.value?.map((a:any)=>({name:a.name||null,email:a.address||''})).filter((a:any)=>a.email)||[];
export async function mailMessage(conn:Connection,msg:any) {
  const h=(msg.payload?.headers||[]).map((x:any)=>`${x.name}: ${x.value}`).join('\r\n');
  const parsed=await simpleParser(h+'\r\n\r\n');
  let text='',html='';const attachments:any[]=[];
  const walk=async(p:any)=>{if(!p)return;
    if(p.filename){attachments.push({id:p.body?.attachmentId||p.partId,filename:p.filename,mimeType:p.mimeType,size:p.body?.size||0,inline:p.headers?.some((h:any)=>h.name.toLowerCase()==='content-disposition'&&h.value.startsWith('inline'))||false,providerMessageId:msg.id,attachmentId:p.body?.attachmentId||null,dataBase64:p.body?.data||null});}
    else if(p.body?.data&&['text/plain','text/html'].includes(p.mimeType)){const headers=(p.headers||[]).filter((h:any)=>h.name.toLowerCase()!=='content-transfer-encoding').map((h:any)=>`${h.name}: ${h.value}`).join('\r\n');const body=await simpleParser(headers+'\r\nContent-Transfer-Encoding: base64\r\n\r\n'+Buffer.from(p.body.data,'base64url').toString('base64'));if(p.mimeType==='text/plain')text+=body.text||'';else html+=body.html||'';}for(const child of p.parts||[])await walk(child);};await walk(msg.payload);
  const from=addresses(parsed.from)[0]||{name:null,email:''};const own=from.email.toLowerCase()===conn.email.toLowerCase() || ((object(conn.settings).sendAs as any[])||[]).some(a=>a.email===from.email);
  return {id:msg.id,providerId:msg.id,from,to:addresses(parsed.to),cc:addresses(parsed.cc),bcc:own?addresses(parsed.bcc):[],replyTo:addresses(parsed.replyTo),subject:parsed.subject||'(No subject)',sentAt:new Date(Number(msg.internalDate)||Date.now()).toISOString(),snippet:msg.snippet||'',bodyText:text||null,bodyHtml:html?safeHtml(html):null,attachments,unread:(msg.labelIds||[]).includes('UNREAD'),starred:(msg.labelIds||[]).includes('STARRED'),outgoing:own,_messageId:parsed.messageId||null,_references:Array.isArray(parsed.references)?parsed.references:parsed.references?[parsed.references]:[]};
}
export async function hydrateThread(conn:Connection,id:string) {
  const t=await api(conn,`gmail/threads/${enc(id)}?format=full`);const messages=await Promise.all((t.messages||[]).map((m:any)=>mailMessage(conn,m)));messages.sort((a,b)=>a.sentAt.localeCompare(b.sentAt));
  const labels=[...new Set<string>((t.messages||[]).flatMap((m:any)=>m.labelIds||[]))];
  const participants=[...new Map(messages.flatMap(m=>[m.from,...m.to]).filter(a=>a.email!==conn.email).map(a=>[a.email,a])).values()];
  return put(conn,'thread',t.id,{subject:messages[0]?.subject||'(No subject)',snippet:t.snippet||messages.at(-1)?.snippet||'',messages,participants,messageCount:messages.length,unread:labels.includes('UNREAD'),starred:labels.includes('STARRED'),inInbox:labels.includes('INBOX'),trashed:labels.includes('TRASH'),hasAttachments:messages.some(m=>m.attachments.length),labels,lastMessageAt:messages.at(-1)?.sentAt||new Date().toISOString(),url:`https://mail.google.com/mail/u/${enc(conn.email)}/#all/${t.id}`},undefined,t.historyId);
}
export async function syncMail(conn:Connection) {
  const state=object(conn.syncState);let cursor=state.mailHistoryId as string|undefined;const profile=await api(conn,'gmail/profile');let ids:string[]=[];let nextCursor=profile.historyId;
  if(cursor){try{let page='';const touched=new Set<string>();do{const h=await api(conn,`gmail/history?startHistoryId=${enc(cursor)}&maxResults=500${page?'&pageToken='+enc(page):''}`);for(const change of h.history||[])for(const m of [...(change.messages||[]),...(change.messagesAdded||[]).map((x:any)=>x.message),...(change.messagesDeleted||[]).map((x:any)=>x.message),...(change.labelsAdded||[]).map((x:any)=>x.message),...(change.labelsRemoved||[]).map((x:any)=>x.message)])if(m?.threadId)touched.add(m.threadId);page=h.nextPageToken||'';nextCursor=h.historyId||nextCursor;}while(page);ids=[...touched];}catch(e){if((e as AppError).status===404)cursor=undefined;else throw e;}}
  if(!cursor){ids=(await pages(conn,'gmail/threads?q=newer_than%3A30d&maxResults=100','threads')).map(t=>t.id);}
  // threads.get costs 40 units under Gmail's 6,000-unit per-user minute quota.
  // Reserve capacity for interactive reads instead of bursting through the initial cache.
  for(const id of ids){await pause(600);try{await hydrateThread(conn,id);}catch(e){if((e as AppError).status===404)await db.resource.deleteMany({where:{connectionId:conn.id,kind:'thread',providerId:id}});else throw e;}}
  const labels=await api(conn,'gmail/labels');for(const l of labels.labels||[])await put(conn,'label',l.id,{name:l.name,kind:l.type==='user'?'user':'system',color:l.color?.backgroundColor||null});
  const drafts=await pages(conn,'gmail/drafts?maxResults=100','drafts');for(const d of drafts){await pause(600);await hydrateDraft(conn,d.id);}
  await db.resource.deleteMany({where:{connectionId:conn.id,kind:'draft',providerId:{notIn:drafts.map(d=>d.id)}}});
  try{const identities=await api(conn,'gmail/settings/sendAs');await db.connection.update({where:{id:conn.id},data:{settings:json({...object(conn.settings),sendAs:(identities.sendAs||[]).filter((a:any)=>a.isPrimary||a.verificationStatus==='accepted').map((a:any)=>({email:a.sendAsEmail,name:a.displayName||null,isDefault:!!a.isDefault}))})}});}catch{/* Keep the verified primary identity if Google cannot list aliases. */}
  return {mailHistoryId:String(nextCursor)};
}
export async function hydrateDraft(conn:Connection,id:string) {
  const d=await api(conn,`gmail/drafts/${enc(id)}?format=raw`);const raw=d.message.raw;const p=await simpleParser(Buffer.from(raw,'base64url'));const existing=await db.resource.findUnique({where:{connectionId_kind_providerId:{connectionId:conn.id,kind:'draft',providerId:id}}});const prior=object(existing?.data);
  const thread=await db.resource.findFirst({where:{connectionId:conn.id,kind:'thread',providerId:d.message.threadId}});
  const data={...prior,from:addresses(p.from)[0]||{email:conn.email,name:conn.name},to:addresses(p.to),cc:addresses(p.cc),bcc:addresses(p.bcc),subject:p.subject||'',bodyText:p.text||'',bodyHtml:p.html?safeHtml(p.html):null,attachments:p.attachments.map(a=>({id:a.checksum,filename:a.filename||'attachment',mimeType:a.contentType,size:a.size,inline:a.contentDisposition==='inline',dataBase64:a.content.toString('base64')})),threadId:thread?.id||null,mode:prior.mode||(thread?'reply':'new'),status:prior.status||'draft',actionId:prior.actionId||null,scheduledAt:prior.scheduledAt||null,_raw:raw,_providerThreadId:d.message.threadId,_messageId:p.messageId,_references:p.references};
  const {sha256}=await import('./security');return put(conn,'draft',id,data,thread?.id,sha256(raw));
}
export function eventData(conn:Connection,cal:any,e:any) {
  const attendees=(e.attendees||[]).map((a:any)=>({email:a.email,name:a.displayName||null,responseStatus:a.responseStatus||'needsAction',optional:!!a.optional,organizer:!!a.organizer,self:!!a.self}));
  return {title:e.summary||'(Untitled event)',description:e.description||null,location:e.location||null,allDay:!!e.start?.date,start:e.start?.date||e.start?.dateTime,end:e.end?.date||e.end?.dateTime,timezone:e.start?.timeZone||cal.timezone||'UTC',status:e.status||'confirmed',busy:e.transparency!=='transparent',organizer:e.organizer?{email:e.organizer.email,name:e.organizer.displayName||null}:null,attendees,myResponse:attendees.find((a:any)=>a.self)?.responseStatus||null,canEdit:['owner','writer'].includes(cal.accessRole)&&(!e.organizer||e.organizer.self||!!e.guestsCanModify),canRsvp:attendees.some((a:any)=>a.self),recurrence:e.recurrence||null,recurringEventId:e.recurringEventId||null,meetUrl:e.hangoutLink||e.conferenceData?.entryPoints?.find((x:any)=>x.entryPointType==='video')?.uri||null,url:e.htmlLink||null,reminderMinutes:(e.reminders?.overrides||[]).map((x:any)=>x.minutes),_providerCalendarId:cal.providerId,_providerSeriesId:e.recurringEventId||null,calendarId:cal.id};
}
export async function syncCalendars(conn:Connection) {
  const cals=await pages(conn,'calendar/users/me/calendarList?maxResults=250','items');
  for(const c of cals){const existing=await db.resource.findUnique({where:{connectionId_kind_providerId:{connectionId:conn.id,kind:'calendar',providerId:c.id}}});const prior=object(existing?.data);await put(conn,'calendar',c.id,{name:c.summaryOverride||c.summary||c.id,color:c.backgroundColor||conn.color,timezone:c.timeZone||'UTC',accessRole:c.accessRole,primary:!!c.primary,visible:prior.visible??!c.hidden,includeInAvailability:prior.includeInAvailability??!c.hidden,error:null});}
  const removed=await db.resource.findMany({where:{connectionId:conn.id,kind:'calendar',providerId:{notIn:cals.map(c=>c.id)}},select:{id:true}});await db.resource.deleteMany({where:{connectionId:conn.id,kind:'event',parentId:{in:removed.map(r=>r.id)}}});await db.resource.deleteMany({where:{connectionId:conn.id,kind:'calendar',providerId:{notIn:cals.map(c=>c.id)}}});
}
export async function fetchEvents(conn:Connection,cal:any,timeMin:string,timeMax:string,q?:string) {
  const es=await pages(conn,`calendar/calendars/${enc(cal.providerId)}/events?singleEvents=true&orderBy=startTime&maxResults=2500&timeMin=${enc(timeMin)}&timeMax=${enc(timeMax)}${q?'&q='+enc(q):''}`,'items');const out=[];
  for(const e of es){if(e.status==='cancelled')continue;out.push(await put(conn,'event',e.id,eventData(conn,{...object(cal.data),id:cal.id,providerId:cal.providerId},e),cal.id,e.etag));}return out;
}
export async function syncTasks(conn:Connection) {
  const lists=await pages(conn,'tasks/users/@me/lists?maxResults=100','items');for(let i=0;i<lists.length;i++){const l=lists[i];const list=await put(conn,'taskList',l.id,{title:l.title,isDefault:i===0},undefined,l.etag);const tasks=await pages(conn,`tasks/lists/${enc(l.id)}/tasks?maxResults=100&showCompleted=true&showHidden=true&showAssigned=true`,'items');
    for(const t of tasks){if(t.deleted){await db.resource.deleteMany({where:{connectionId:conn.id,kind:'task',providerId:t.id}});continue;}const prior=await db.resource.findUnique({where:{connectionId_kind_providerId:{connectionId:conn.id,kind:'task',providerId:t.id}}});await put(conn,'task',t.id,{...object(prior?.data),title:t.title||'',notes:t.notes||null,due:t.due?.slice(0,10)||null,completed:t.status==='completed',completedAt:t.completed||null,parentProviderId:t.parent||null,position:t.position||'',assigned:!!t.assignmentInfo,url:t.webViewLink||null,taskListId:list.id},list.id,t.etag);}
    await db.resource.deleteMany({where:{connectionId:conn.id,kind:'task',parentId:list.id,providerId:{notIn:tasks.filter(t=>!t.deleted).map(t=>t.id)}}});
  }const removed=await db.resource.findMany({where:{connectionId:conn.id,kind:'taskList',providerId:{notIn:lists.map(l=>l.id)}},select:{id:true}});await db.resource.deleteMany({where:{connectionId:conn.id,kind:'task',parentId:{in:removed.map(r=>r.id)}}});await db.resource.deleteMany({where:{connectionId:conn.id,kind:'taskList',providerId:{notIn:lists.map(l=>l.id)}}});
  const all=await db.resource.findMany({where:{connectionId:conn.id,kind:'task'}});for(const t of all){const d=object(t.data);const parent=d.parentProviderId?all.find(x=>x.providerId===d.parentProviderId)?.id||null:null;if(d.parentId!==parent)await db.resource.update({where:{id:t.id},data:{data:json({...d,parentId:parent})}});}
}
export async function syncConnection(conn:Connection) {
  if(!conn.credentials){await db.connection.update({where:{id:conn.id},data:{lastSyncAt:new Date(),status:'connected',error:null}});return;}
  await db.connection.update({where:{id:conn.id},data:{status:'syncing'}});let state=object(conn.syncState);const errors:string[]=[];
  for(const [area,fn] of [['mail',syncMail],['calendar',syncCalendars],['tasks',syncTasks]] as const){if(!conn.scopes.includes(GOOGLE_SCOPES[area][0]))continue;try{const delta=await fn(conn);if(delta)state={...state,...delta};state[area]={lastSuccessAt:new Date().toISOString(),error:null};}catch(e){const error=e instanceof AppError?e:safeProviderError(e);errors.push(error.message);state[area]={...object(state[area]),error:error.message};}}
  await db.connection.update({where:{id:conn.id},data:{status:errors.length?'error':'connected',error:errors.join(' ')||null,syncState:json(state),lastSyncAt:errors.length?conn.lastSyncAt:new Date()}});
}
