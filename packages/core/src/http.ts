import { z, ZodError } from 'zod';
import { db, json, object } from './db';
import { configuredAI, configuredGoogle, allowDemo } from './config';
import { AppError } from './security';
import { context, enforceOrigin, createSession, logout } from './session';
import { createDemo } from './seed';
import { beginOAuth, finishOAuth } from './oauth';
import { type Context, connection, connections, resource, resources, activity } from './store';
import * as view from './views';
import * as W from './workspace';
import * as V from './validation';
import * as A from './actions';
import { agentMessages, runAgent, modelName } from './agent';
import { enqueueSync, nextRun } from './jobs';
import { api, enc, oauthClient } from './google';
import type * as T from './types';

export const response=(data:unknown,status=200,headers:Record<string,string>={})=>Response.json({data},{status,headers:{'Cache-Control':'no-store',...headers}});
async function body(req:Request) {if(Number(req.headers.get('content-length')||0)>16_000_000)throw new AppError('too_large','Request is too large.',413);const raw=await req.text();if(Buffer.byteLength(raw)>16_000_000)throw new AppError('too_large','Request is too large.',413);if(!raw)return {};try{return JSON.parse(raw);}catch{throw new AppError('validation_failed','Send valid JSON.',422);}}
function select(ctx:Context,u:URL) {const ids=u.searchParams.getAll('accountId').flatMap(x=>x.split(',')).filter(Boolean);return ids.length?{...ctx,connectionIds:ids}:ctx;}
function paginate<T>(value:T.ListResult<any>,u:URL){const limit=Math.min(100,Math.max(1,Number(u.searchParams.get('limit')||40)));let offset=0;if(u.searchParams.get('cursor')){offset=Number(Buffer.from(u.searchParams.get('cursor')!,'base64url').toString());if(!Number.isInteger(offset)||offset<0)throw new AppError('validation_failed','Invalid list cursor.',422);}return {...value,items:value.items.slice(offset,offset+limit),nextCursor:offset+limit<value.items.length?Buffer.from(String(offset+limit)).toString('base64url'):null};}
export async function health():Promise<T.Health> {let database:'ok'|'down'='ok',worker:'ok'|'stale'|'unknown'='unknown';try{await db.$queryRaw`SELECT 1`;const h=await db.workerHeartbeat.findUnique({where:{id:'main'}});worker=h?Date.now()-h.lastSeenAt.getTime()<45000?'ok':'stale':'unknown';}catch{database='down';}return {status:database==='down'?'down':worker==='ok'?'ok':'degraded',version:'0.1.0',time:new Date().toISOString(),checks:{database,worker,googleOAuth:configuredGoogle()?'configured':'missing',model:configuredAI()?'configured':'missing'}};}
export async function bootstrap(ctx:Context):Promise<T.Bootstrap> {const cs=await connections(ctx),calendars=(await resources(ctx,'calendar')).map(view.calendarView),tasks=await resources(ctx,'task'),taskLists=(await resources(ctx,'taskList')).map(r=>view.taskListView(r,tasks)),threads=(await resources(ctx,'thread')).map(view.threadView),drafts=await resources(ctx,'draft'),actions=await db.action.findMany({where:{workspaceId:ctx.workspace.id}}),settings=view.settingsView(ctx),today=new Intl.DateTimeFormat('en-CA',{timeZone:settings.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),h=await health();const cap=(available:boolean,reason:string|null=null)=>({available,reason:available?null:reason});const area=(name:string)=>cap(cs.some(c=>W.scopeAvailable(c,name,ctx)),`Connect an account with ${name} permission.`);
  return {session:view.sessionView(ctx),connections:cs.map(c=>view.connectionView(c,ctx)),calendars,taskLists,labels:(await resources(ctx,'label')).map(r=>({id:r.providerId,accountId:r.connectionId,name:String(object(r.data).name),kind:object(r.data).kind as 'system'|'user',color:object(r.data).color as string||null})),settings,counts:{inboxUnread:threads.filter(t=>t.inInbox&&t.unread&&!t.trashed).length,drafts:drafts.length,pendingActions:actions.filter(a=>['proposed','needs_review'].includes(a.status)).length,scheduledActions:actions.filter(a=>['approved','queued','running'].includes(a.status)).length,tasksDue:tasks.filter(r=>{const t=view.taskView(r);return !t.completed&&!!t.due&&t.due<=today;}).length,eventsToday:(await resources(ctx,'event')).filter(r=>view.eventView(r).start.startsWith(today)).length,unreadByAccount:Object.fromEntries(cs.map(c=>[c.id,threads.filter(t=>t.accountId===c.id&&t.unread&&t.inInbox&&!t.trashed).length]))},capabilities:{googleConnect:cap(configuredGoogle()&&!ctx.workspace.demo,ctx.workspace.demo?'Sign out of the sandbox and sign in to connect real accounts.':'Google OAuth client has not been configured.'),agent:cap(configuredAI(),'The model API key has not been configured.'),agentModel:configuredAI()?modelName():null,mail:area('mail'),calendar:area('calendar'),tasks:area('tasks'),contacts:area('contacts'),files:area('files'),automations:cap(h.checks.worker==='ok','The worker is not currently connected.'),scheduledSend:cap(h.checks.worker==='ok','The worker is not currently connected.'),limits:{attachmentBytesPerMessage:10_000_000,maxAccounts:30,mailCacheDays:30}}};
}
async function brief(ctx:Context,refresh=false):Promise<T.Brief> {const settings=view.settingsView(ctx);const {formatInTimeZone,fromZonedTime}=await import('date-fns-tz');const today=formatInTimeZone(new Date(),settings.timezone,'yyyy-MM-dd'),next=new Date(today+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);const min=fromZonedTime(today+'T00:00:00',settings.timezone).toISOString(),max=fromZonedTime(next.toISOString().slice(0,10)+'T00:00:00',settings.timezone).toISOString(),events=await W.getEvents(ctx,min,max),threads=await W.getThreads(ctx,'','inbox'),tasks=(await resources(ctx,'task')).map(view.taskView).filter(t=>!t.completed&&t.due&&t.due<=today);
  const needsReply=[];for(const t of threads.items.filter(t=>t.unread).slice(0,8)){const r=await resource(ctx,t.id,'thread'),ms=object(r.data).messages as any[]||[];if(!ms.at(-1)?.outgoing)needsReply.push({thread:t,reason:'Unread incoming conversation; review whether it needs a reply.'});}
  const allowed=(await connections(ctx)).filter(c=>view.connectionView(c,ctx).assistantAccess&&c.status!=='paused').map(c=>c.id);let modelBrief:T.AgentMessage|undefined;
  if(refresh&&configuredAI()&&allowed.length){modelBrief=(await runAgent(ctx,{text:'Write a concise morning brief of no more than 100 words. Read today’s meetings, open tasks due today or overdue, and inbox conversations needing a reply. State priorities and account gaps. Read only; do not prepare changes.',accountIds:allowed},undefined,{readOnly:true,briefDate:today})).reply;}
  else{const candidates=await db.agentMessage.findMany({where:{workspaceId:ctx.workspace.id,role:'assistant',metadata:{path:['briefDate'],equals:today}},orderBy:{createdAt:'desc'},take:20});const cached=candidates.find(m=>{const ids=object(m.metadata).accountIds as string[]||[];return ids.length===allowed.length&&ids.every(id=>allowed.includes(id));});if(cached)modelBrief=view.messageRecordView(cached);}
  const sent=await W.getThreads(ctx,'','sent'),waitingOn=[];for(const thread of sent.items){const messages=object((await resource(ctx,thread.id,'thread')).data).messages as any[]||[];if(messages.at(-1)?.outgoing&&Date.parse(thread.lastMessageAt)<Date.now()-3*86400000)waitingOn.push({thread,reason:'Last message was sent by you at least 3 days ago; no reply appears in the synced conversation.'});}
  return {date:today,timezone:settings.timezone,generatedAt:modelBrief?.createdAt||new Date().toISOString(),generatedBy:modelBrief?'model':'rules',headline:`${events.items.length} meetings · ${tasks.length} tasks due · ${needsReply.length} conversations to review`,summary:modelBrief?.text||null,meetings:events.items,tasks,needsReply,waitingOn,gaps:[...events.gaps,...threads.gaps,...sent.gaps]};
}
async function settings(ctx:Context,input:unknown) {const v=V.settingsUpdate.parse(input);if(v.defaultAccountId)await connection(ctx,v.defaultAccountId);if(v.defaultCalendarId)await resource(ctx,v.defaultCalendarId,'calendar');if(v.defaultTaskListId)await resource(ctx,v.defaultTaskListId,'taskList');if(v.workingHours&&v.workingHours.start>=v.workingHours.end)throw new AppError('validation_failed','Working hours must end after they start.',422);for(const p of v.calendars||[]){const r=await resource(ctx,p.calendarId,'calendar');const {calendarId,...prefs}=p;await db.resource.update({where:{id:r.id},data:{data:json({...object(r.data),...prefs})}});}const {calendars,...prefs}=v;ctx.workspace=await db.workspace.update({where:{id:ctx.workspace.id},data:{settings:json({...view.settingsView(ctx),...prefs})}});return {settings:view.settingsView(ctx),calendars:(await resources(ctx,'calendar')).map(view.calendarView)};}
export async function handle(req:Request) {try{return await dispatch(req);}catch(e){if(e instanceof ZodError)return Response.json({error:{code:'validation_failed',message:e.issues[0]?.message||'Check the fields and try again.',details:{fields:Object.fromEntries(e.issues.map(i=>[i.path.join('.'),i.message]))} }},{status:422});if(e instanceof AppError)return Response.json({error:{code:e.code.toLowerCase(),message:e.message}},{status:e.status});console.error('Request failed:',e instanceof Error?e.name:'UnknownError');return Response.json({error:{code:'internal',message:'The request could not be completed. Try again.'}},{status:500});}}
async function dispatch(req:Request):Promise<Response> {
  enforceOrigin(req);const u=new URL(req.url),p=u.pathname.replace(/^\/api\/?/,'').split('/').map(decodeURIComponent),method=req.method;
  if(method==='GET'&&p[0]==='health'){const h=await health();return response(h,h.checks.database==='down'?503:200);}
  if(method==='GET'&&p[0]==='session'){const ctx=await context(req,false);return response({session:ctx?view.sessionView(ctx):null,auth:{google:{available:configuredGoogle(),reason:configuredGoogle()?null:'Google sign-in is not configured yet. You can explore the isolated sandbox.'},demo:{available:allowDemo(),reason:allowDemo()?null:'The sandbox is disabled.'},inviteOnly:!!process.env.BETA_EMAILS}});}
  if(p[0]==='auth') {
    if(method==='GET'&&p[1]==='google')return beginOAuth(req);
    if(method==='GET'&&p[1]==='callback')return finishOAuth(req);
    if(method==='POST'&&p[1]==='demo'){const old=await context(req,false);if(old?.workspace.demo)return response(view.sessionView(old));if(old)throw new AppError('conflict','Sign out before entering a sandbox.',409);const demo=await createDemo();return response(view.sessionView(demo),201,{'Set-Cookie':await createSession(demo.user.id,true)});}
    if(method==='POST'&&p[1]==='logout')return response({ok:true},200,{'Set-Cookie':await logout(req)});
  }
  const ctx=(await context(req,true))!,selected=select(ctx,u);if(selected.connectionIds)for(const id of selected.connectionIds)await connection(ctx,id);
  const input=['POST','PATCH','PUT'].includes(method)?await body(req):{};
  if(p[0]==='bootstrap'&&method==='GET')return response(await bootstrap(ctx));
  if(p[0]==='brief'&&method==='GET')return response(await brief(selected,u.searchParams.get('refresh')==='1'));
  if(p[0]==='threads') {
    if(!p[1]&&method==='GET')return response(paginate(await W.getThreads(selected,u.searchParams.get('q')||'',u.searchParams.get('folder')||'inbox',u.searchParams.get('labelId')||undefined),u));
    if(p[1]&&method==='GET')return response(await W.getThread(ctx,p[1]));
    if(p[2]==='actions'&&method==='POST')return response(await W.modifyThread(ctx,p[1],input));
  }
  if(p[0]==='drafts') {
    if(!p[1]&&method==='GET'){let rows=await resources(selected,'draft');if(u.searchParams.get('threadId'))rows=rows.filter(r=>r.parentId===u.searchParams.get('threadId'));return response(paginate(W.list(rows.map(view.draftView),await W.gapList(selected,'mail')),u));}
    if(!p[1]&&method==='POST')return response(await W.createDraft(ctx,input),201);
    if(p[1]&&p[2]==='send'&&method==='POST')return response(await A.prepareSend(ctx,p[1],input));
    if(p[1]&&method==='PATCH')return response(await W.updateDraft(ctx,p[1],input));
    if(p[1]&&method==='DELETE')return response(await W.deleteDraft(ctx,p[1]));
  }
  if(p[0]==='events') {
    if(!p[1]&&method==='GET')return response(await W.getEvents(selected,u.searchParams.get('timeMin')||'',u.searchParams.get('timeMax')||'',u.searchParams.getAll('calendarId').flatMap(x=>x.split(',')),u.searchParams.get('q')||undefined));
    if(!p[1]&&method==='POST')return response(await W.createEvent(ctx,input),201);
    if(p[2]==='rsvp'&&method==='POST')return response(await W.rsvpEvent(ctx,p[1],input));
    if(p[1]&&method==='PATCH')return response(await W.updateEvent(ctx,p[1],input));
    if(p[1]&&method==='DELETE')return response(await W.deleteEvent(ctx,p[1],u.searchParams.get('scope')||'this',u.searchParams.get('notify')!=='false'));
  }
  if(p[0]==='availability'&&method==='POST')return response(await W.availability(selected,input));
  if(p[0]==='tasks') {
    if(!p[1]&&method==='GET'){let rows=(await resources(selected,'task')).map(view.taskView);const status=u.searchParams.get('status')||'open';rows=rows.filter(t=>status==='all'||status==='completed'?status==='all'||t.completed:!t.completed);if(u.searchParams.get('taskListId')){await resource(ctx,u.searchParams.get('taskListId')!,'taskList');rows=rows.filter(t=>t.taskListId===u.searchParams.get('taskListId'));}if(u.searchParams.get('q'))rows=rows.filter(t=>(t.title+' '+t.notes).toLowerCase().includes(u.searchParams.get('q')!.toLowerCase()));if(u.searchParams.get('dueBefore'))rows=rows.filter(t=>t.due&&t.due<=u.searchParams.get('dueBefore')!);rows.sort((a,b)=>a.taskListId.localeCompare(b.taskListId)||a.position.localeCompare(b.position));return response(paginate(W.list(rows,await W.gapList(selected,'tasks')),u));}
    if(!p[1]&&method==='POST')return response(await W.createTask(ctx,input),201);
    if(p[1]&&method==='PATCH')return response(await W.updateTask(ctx,p[1],input));
    if(p[1]&&method==='DELETE')return response(await W.deleteTask(ctx,p[1]));
  }
  if(p[0]==='task-lists') {
    if(!p[1]&&method==='GET')return response(W.list((await resources(selected,'taskList')).map(r=>view.taskListView(r))));
    if(!p[1]&&method==='POST')return response(await W.taskListWrite(ctx,input),201);
    if(p[1]&&method==='PATCH')return response(await W.taskListWrite(ctx,input,p[1]));
    if(p[1]&&method==='DELETE')return response(await W.taskListWrite(ctx,{},p[1],true));
  }
  if(p[0]==='agent'&&p[1]==='messages') {if(method==='GET')return response(await agentMessages(ctx,u.searchParams.get('conversationId')||undefined));if(method==='POST')return response(await runAgent(ctx,input));}
  if(p[0]==='actions') {
    if(!p[1]&&method==='GET'){const status=u.searchParams.get('status'),states=status==='pending'?['proposed','needs_review']:status==='scheduled'?['approved','queued','running']:status==='done'?['succeeded','failed','canceled','rejected']:undefined;const rows=await db.action.findMany({where:{workspaceId:ctx.workspace.id,...(selected.connectionIds?{connectionId:{in:selected.connectionIds}}:{}),...(states?{status:{in:states}}:{})},orderBy:{createdAt:'desc'}});return response(paginate(W.list(rows.map(view.actionView)),u));}
    if(p[1]&&method==='POST'){if(p[2]==='approve')return response(await A.approve(ctx,p[1],V.id.parse(input.contentHash)));if(p[2]==='reject'||p[2]==='cancel')return response(await A.decide(ctx,p[1],p[2]));}
  }
  if(p[0]==='connections') {
    if(!p[1]&&method==='GET')return response(W.list((await connections(ctx)).map(c=>view.connectionView(c,ctx))));
    if(p[1]){const c=await connection(ctx,p[1]);if(method==='PATCH'){const v=z.object({label:z.string().min(1).max(100).optional(),group:z.enum(['personal','company','client','other']).optional(),color:z.string().regex(/^#[0-9a-f]{6}$/i).optional(),assistantAccess:z.boolean().optional(),signature:z.string().max(5000).nullish(),writingPreferences:z.string().max(2000).nullish()}).parse(input);const {label,color,...prefs}=v;const updated=await db.connection.update({where:{id:c.id},data:{label,color,settings:json({...object(c.settings),...prefs})}});return response(view.connectionView(updated,ctx));}
      if(method==='POST'&&p[2]==='sync'){await enqueueSync(c.id);return response(view.connectionView(c,ctx));}
      if(method==='DELETE'){const count=await db.action.updateMany({where:{workspaceId:ctx.workspace.id,connectionId:c.id,status:{in:['proposed','approved','queued','needs_review']}},data:{status:'canceled',error:'The account was disconnected.'}});if(c.credentials){try{const {decrypt}=await import('./security');const credentials=decrypt<any>(c.credentials);await oauthClient().revokeToken(credentials.refresh_token||credentials.access_token);}catch{}}await db.connection.delete({where:{id:c.id}});return response({id:c.id,canceledActions:count.count});}
    }
  }
  if(p[0]==='automations') {
    if(method==='GET')return response(W.list((await db.automation.findMany({where:{workspaceId:ctx.workspace.id},orderBy:{createdAt:'desc'}})).map(view.automationView)));
    if(method==='POST'||method==='PATCH'){const existing=p[1]?await db.automation.findFirst({where:{id:p[1],workspaceId:ctx.workspace.id}}):null;if(p[1]&&!existing)throw new AppError('not_found','Automation not found.',404);const v=(method==='POST'?V.automationCreate:V.automationCreate.omit({template:true}).partial()).parse(input);const prior=existing?view.automationView(existing):null;if(v.accountIds)for(const id of v.accountIds)await connection(ctx,id);const template=('template'in v?v.template:prior!.template) as T.AutomationTemplate;if(!existing&&await db.automation.findFirst({where:{workspaceId:ctx.workspace.id,type:template}}))throw new AppError('conflict','An automation with this template already exists.',409);const schedule=v.schedule||prior!.schedule,config={accountIds:v.accountIds||prior?.accountIds||[],schedule,config:v.config||prior?.config||{}};const data={name:v.name||prior?.name||template!.replaceAll('_',' '),enabled:v.enabled??prior?.enabled??true,config:json(config),nextRunAt:nextRun(schedule)};const a=existing?await db.automation.update({where:{id:existing.id},data}):await db.automation.create({data:{workspaceId:ctx.workspace.id,type:template!,...data}});return response(view.automationView(a),existing?200:201);}
  }
  if(p[0]==='files') {if(method==='GET'){let r=await W.getFiles(selected,u.searchParams.get('q')||'');if(u.searchParams.get('kind'))r.items=r.items.filter(f=>f.kind===u.searchParams.get('kind'));return response(paginate(r,u));}if(p[1]==='actions'&&method==='POST')return response(await W.fileOperation(ctx,input));}
  if(p[0]==='contacts'&&method==='GET')return response(await W.contacts(selected,u.searchParams.get('q')||''));
  if(p[0]==='documents'&&p[1]==='read'&&method==='POST')return response(await (await import('./documents')).readDocument(ctx,input));
  if(p[0]==='documents'&&p[1]==='propose'&&method==='POST')return response(view.actionView(await A.propose(ctx,'other',input,{origin:'user'})));
  if(p[0]==='settings'&&method==='PATCH')return response(await settings(ctx,input));
  if(p[0]==='activity'&&method==='GET'){const rows=await db.activity.findMany({where:{workspaceId:ctx.workspace.id,...(selected.connectionIds?{connectionId:{in:selected.connectionIds}}:{})},orderBy:{createdAt:'desc'},take:500});return response(paginate(W.list(rows.map(a=>({id:a.id,at:a.createdAt.toISOString(),actor:['agent','automation','system'].includes(a.actor)?a.actor:'user',kind:a.type,title:a.title,detail:object(a.detail).message||null,outcome:a.type.includes('failed')?'failed':a.type.includes('proposed')?'pending':'ok',accountId:a.connectionId,actionId:object(a.detail).actionId||null}))),u));}
  if(p[0]==='account'&&p[1]==='delete'&&method==='POST'){if(input.confirmEmail!==ctx.user.email)throw new AppError('validation_failed','Enter your account email to confirm deletion.',422);for(const c of await connections(ctx))if(c.credentials){try{const {decrypt}=await import('./security');await oauthClient().revokeToken(decrypt<any>(c.credentials).refresh_token);}catch{}}await db.user.delete({where:{id:ctx.user.id}});return response({deleted:true},200,{'Set-Cookie':await logout(req)});}
  if(p[0]==='attachments'&&method==='GET'){const r=await resource(ctx,p[1]),c=await connection(ctx,r.connectionId);W.assertScope(c,'mail',ctx);const d=object(r.data),m=p[2]==='draft'?d:((d.messages||[]) as any[]).find(m=>m.id===p[2]);const a=m?.attachments?.find((x:any)=>x.id===p[3]);if(!a)throw new AppError('not_found','Attachment not found.',404);let bytes=a.dataBase64;if(!bytes&&!ctx.workspace.demo&&a.attachmentId)bytes=(await api(c,`gmail/messages/${enc(m.id)}/attachments/${enc(a.attachmentId)}`)).data;if(!bytes)throw new AppError('not_found','Attachment bytes are unavailable.',404);return new Response(Buffer.from(bytes,'base64url'),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${enc(a.filename)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
  throw new AppError('not_found','Endpoint not found.',404);
}
