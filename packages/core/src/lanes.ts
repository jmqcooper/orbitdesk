import type { Resource } from '@prisma/client';
import { db, json, object } from './db';
import { type Context, resources } from './store';
import type * as T from './types';

/**
 * Triage lives in its own `triage` resource per thread (providerId = the thread's
 * providerId, parentId = the thread's id), because every Gmail sync rewrites the
 * thread row. Nothing here calls a model; see triage.ts for that.
 */
export interface TriageRow {
  lane: T.MailLane;
  summary: string;
  urgent: boolean;
  meeting: boolean;
  task: { title: string; due: string | null } | null;
  taskDone: boolean;
  draft: { state: T.TriageDraftState; draftId: string | null; note: string | null; claimedAt?: string | null };
  manual: boolean;
  /** The message state this was decided for; a new message makes the row stale. */
  basis: string;
  triagedAt: string;
  model: string | null;
}

const messagesOf=(thread:Resource)=>(object(thread.data).messages||[]) as any[];
export const basisOf=(thread:Resource)=>{const d=object(thread.data);return `${d.lastMessageAt||''}#${d.messageCount||messagesOf(thread).length}`;};
export const lastOutgoing=(thread:Resource)=>!!messagesOf(thread).at(-1)?.outgoing;
export const rowOf=(row:Resource|null|undefined)=>row?object(row.data) as unknown as TriageRow:null;
const NO_DRAFT={state:'none' as const,draftId:null,note:null};

/** The triage to show for a thread: a fresh stored row, else "waiting" when the owner wrote last, else nothing. */
export function triageOf(thread:Resource,row?:Resource|null):T.ThreadTriage|null {
  const v=rowOf(row);
  if(v&&v.basis===basisOf(thread))return {lane:v.lane,summary:v.summary||'',urgent:!!v.urgent,meeting:!!v.meeting,task:v.task||null,taskDone:!!v.taskDone,draft:{state:v.draft?.state||'none',draftId:v.draft?.draftId||null,note:v.draft?.note||null},manual:!!v.manual,triagedAt:v.triagedAt};
  if(lastOutgoing(thread)){const to=messagesOf(thread).at(-1)?.to?.[0];return {lane:'waiting',summary:to?`Waiting on ${to.name||to.email}`:'Waiting for a reply',urgent:false,meeting:false,task:null,taskDone:false,draft:NO_DRAFT,manual:false,triagedAt:String(object(thread.data).lastMessageAt||thread.updatedAt.toISOString())};}
  return null;
}
export interface TriageIndex { rows: Map<string,Resource>; drafted: Set<string> }
export async function triageIndex(ctx:Context):Promise<TriageIndex> {
  const [rows,drafts]=await Promise.all([resources(ctx,'triage'),db.resource.findMany({where:{workspaceId:ctx.workspace.id,kind:'draft',parentId:{not:null},...(ctx.connectionIds?{connectionId:{in:ctx.connectionIds}}:{})},select:{parentId:true}})]);
  return {rows:new Map(rows.map(r=>[r.parentId!,r])),drafted:new Set(drafts.map(d=>d.parentId!))};
}
/** Adds triage and the draft marker to a summary built by `views.threadView`. */
export function decorate<X extends T.ThreadSummary>(summary:X,thread:Resource,index:TriageIndex):X {
  summary.triage=triageOf(thread,index.rows.get(thread.id));summary.hasDraft=index.drafted.has(thread.id);return summary;
}
export async function decorateOne<X extends T.ThreadSummary>(summary:X,thread:Resource):Promise<X> {
  const [row,draft]=await Promise.all([db.resource.findFirst({where:{workspaceId:thread.workspaceId,kind:'triage',parentId:thread.id}}),db.resource.findFirst({where:{workspaceId:thread.workspaceId,kind:'draft',parentId:thread.id},select:{id:true}})]);
  summary.triage=triageOf(thread,row);summary.hasDraft=!!draft;return summary;
}
/** Which lane tab a decorated summary belongs to. Waiting spans every folder; the rest are inbox-only. */
export function laneOf(t:T.ThreadSummary):T.MailLane|'unsorted'|null {
  if(t.trashed)return null;
  if(t.triage?.lane==='waiting')return 'waiting';
  if(!t.inInbox)return null;
  return t.triage?.lane||'unsorted';
}
export async function saveTriage(thread:Resource,patch:Partial<TriageRow>,prior?:Resource|null) {
  const before=rowOf(prior),fresh=before&&before.basis===basisOf(thread)?before:null;
  const data:TriageRow={lane:'fyi',summary:'',urgent:false,meeting:false,task:null,taskDone:false,draft:NO_DRAFT,manual:false,model:null,...(fresh||{}),...patch,basis:basisOf(thread),triagedAt:patch.triagedAt||fresh?.triagedAt||new Date().toISOString()};
  return db.resource.upsert({where:{connectionId_kind_providerId:{connectionId:thread.connectionId,kind:'triage',providerId:thread.providerId}},create:{workspaceId:thread.workspaceId,connectionId:thread.connectionId,kind:'triage',providerId:thread.providerId,parentId:thread.id,data:json(data),version:crypto.randomUUID()},update:{parentId:thread.id,data:json(data),version:crypto.randomUUID()}});
}
/** Takes a row for drafting only if nobody else changed it since it was read. */
export async function claimDraft(row:Resource) {
  const v=rowOf(row)!;
  const claimed=await db.resource.updateMany({where:{id:row.id,version:row.version},data:{version:crypto.randomUUID(),data:json({...v,draft:{...v.draft,state:'drafting',claimedAt:new Date().toISOString()}})}});
  return claimed.count===1;
}
