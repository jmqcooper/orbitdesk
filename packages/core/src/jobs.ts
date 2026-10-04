import { PgBoss } from 'pg-boss';
import { db, json, object } from './db';
import { execute } from './actions';
import { syncConnection } from './google';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { runAgent } from './agent';
import { connections, type Context } from './store';
import { automationView, connectionView } from './views';
import { retainCache } from './retention';

let boss:PgBoss|undefined,starting:Promise<PgBoss>|undefined;
export async function queue() {if(boss)return boss;if(starting)return starting;starting=(async()=>{const q=new PgBoss({connectionString:process.env.DATABASE_URL!,schema:'pgboss'});q.on('error',()=>console.error('Queue operation failed; durable actions remain in Postgres.'));await q.start();await q.createQueue('sync-account',{retryLimit:2,retryDelay:30});await q.createQueue('execute-action',{retryLimit:0});boss=q;return q;})();try{return await starting;}finally{starting=undefined;}}
export async function enqueueSync(connectionId:string) {try{return await (await queue()).send('sync-account',{connectionId},{singletonKey:connectionId});}catch{/* Worker scans accounts as a durable fallback. */return null;}}
export async function enqueueAction(actionId:string,startAfter?:Date) {try{return await (await queue()).send('execute-action',{actionId},{singletonKey:actionId,startAfter});}catch{/* The approved Action row is the durable outbox. */return null;}}
export async function stopQueue(){if(boss){await boss.stop({graceful:true});boss=undefined;}}
export function nextRun(schedule:{time:string;days:number[];timezone:string},after=new Date()) {
  const base=formatInTimeZone(after,schedule.timezone,'yyyy-MM-dd');for(let i=0;i<9;i++){const date=new Date(base+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+i);const day=date.getUTCDay();if(!schedule.days.includes(day))continue;const local=date.toISOString().slice(0,10)+'T'+schedule.time+':00';const candidate=fromZonedTime(local,schedule.timezone);if(candidate>after)return candidate;}return new Date(after.getTime()+7*86400000);
}
export async function tick() {
  const now=new Date();await db.workerHeartbeat.upsert({where:{id:'main'},create:{id:'main',detail:json({version:'0.1.0'})},update:{lastSeenAt:now}});
  await db.action.updateMany({where:{status:'running',leaseUntil:{lt:now}},data:{status:'needs_review',leaseUntil:null,error:'The worker stopped before confirming this operation. Check Google before preparing another action.'}});
  const pending=await db.action.findMany({where:{status:{in:['approved','queued']},OR:[{scheduledAt:null},{scheduledAt:{lte:now}}]},take:10,orderBy:{createdAt:'asc'}});for(const a of pending)await execute(a.id);
  const autos=await db.automation.findMany({where:{enabled:true,nextRunAt:{lte:now},OR:[{leaseUntil:null},{leaseUntil:{lt:now}}]},take:5});for(const a of autos){const claim=await db.automation.updateMany({where:{id:a.id,enabled:true,OR:[{leaseUntil:null},{leaseUntil:{lt:now}}]},data:{leaseUntil:new Date(Date.now()+120000)}});if(!claim.count)continue;const w=await db.workspace.findUnique({where:{id:a.workspaceId},include:{owner:true}});if(!w)continue;const {owner,...workspace}=w,ctx:Context={user:owner,workspace},v=automationView(a);const accounts=(await connections(ctx)).filter(c=>connectionView(c,ctx).assistantAccess&&(!v.accountIds.length||v.accountIds.includes(c.id))).map(c=>c.id);const prompt=v.template==='daily_brief'?'Give me a useful morning brief: meetings today, urgent email that needs a reply, open tasks due today or overdue, and concrete next steps. Read tools and report account gaps.':v.template==='follow_up'?`Find sent conversations with no reply after ${v.config.followUpAfterDays||3} days. Suggest follow-up drafts for the most useful ones. Do not send them.`:`Review unread inboxes and suggest changes using this triage rule: ${v.config.triageInstruction||'Archive obvious newsletters, surface messages that need a reply.'} All changes must be proposed for human approval.`;
    try{await runAgent(ctx,{text:prompt,accountIds:accounts},a.id);await db.automation.update({where:{id:a.id},data:{lastRunAt:new Date(),lastError:null,leaseUntil:null,nextRunAt:nextRun(v.schedule),config:json({...object(a.config),lastRunDetail:'Completed. Results are in Assistant and approvals.'})}});}catch(e){await db.automation.update({where:{id:a.id},data:{lastRunAt:new Date(),lastError:(e as Error).message,leaseUntil:null,nextRunAt:nextRun(v.schedule)}});}
  }
}
export async function startWorker() {
  const q=await queue();await q.work('execute-action',{batchSize:1},async jobs=>{for(const j of jobs)await execute((j.data as any).actionId);});await q.work('sync-account',{batchSize:1},async jobs=>{for(const j of jobs){const c=await db.connection.findUnique({where:{id:(j.data as any).connectionId}});if(c&&c.status!=='paused')await syncConnection(c);}});
  let stopped=false,lastSync=0,lastCleanup=0;
  const loop=async()=>{if(stopped)return;try{await tick();if(Date.now()-lastSync>Number(process.env.SYNC_INTERVAL_SECONDS||120)*1000){lastSync=Date.now();const cs=await db.connection.findMany({where:{credentials:{not:null},status:{not:'paused'}}});for(const c of cs)await enqueueSync(c.id);}if(Date.now()-lastCleanup>3600000){lastCleanup=Date.now();await retainCache();await db.oAuthState.deleteMany({where:{expiresAt:{lt:new Date()}}});await db.session.deleteMany({where:{expiresAt:{lt:new Date()}}});const old=await db.user.findMany({where:{googleSub:null,createdAt:{lt:new Date(Date.now()-86400000)},workspaces:{every:{demo:true}}},select:{id:true}});await db.user.deleteMany({where:{id:{in:old.map(u=>u.id)}}});}}catch{console.error('Worker tick failed; it will retry on the next tick.');}if(!stopped)setTimeout(loop,1000);};void loop();
  return async()=>{stopped=true;await q.stop({graceful:true});await db.$disconnect();};
}
