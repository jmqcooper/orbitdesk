import '../packages/core/src/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, json, object } from '../packages/core/src/db';
import { createDemo } from '../packages/core/src/seed';
import { connections, type Context } from '../packages/core/src/store';
import { createDraft, gapList } from '../packages/core/src/workspace';
import { propose, approve, execute, prepareSend } from '../packages/core/src/actions';
import { encrypt } from '../packages/core/src/security';
import { stopQueue } from '../packages/core/src/jobs';
import { beginOAuth, finishOAuth } from '../packages/core/src/oauth';
import { createSession } from '../packages/core/src/session';
import { api, mailMessage } from '../packages/core/src/google';
import { connectionView } from '../packages/core/src/views';

let ctx:Context,accountId:string,raw='',changedRaw:string|null=null,sendCount=0,uncertain=false;
beforeAll(async()=>{ctx=await createDemo();ctx.workspace=await db.workspace.update({where:{id:ctx.workspace.id},data:{demo:false}});const c=(await connections(ctx))[0];accountId=c.id;await db.connection.update({where:{id:c.id},data:{credentials:encrypt({access_token:'unit-test-token',expiry_date:Date.now()+3600000}),scopes:['https://www.googleapis.com/auth/gmail.modify']}});});
afterAll(async()=>{vi.unstubAllGlobals();await stopQueue();await db.user.delete({where:{id:ctx.user.id}});await db.$disconnect();});
function mockGoogle() {vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{const path=String(url);if(path.endsWith('/drafts')&&init.method==='POST'){raw=JSON.parse(init.body).message.raw;return Response.json({id:crypto.randomUUID()});}if(path.includes('/drafts/')&&path.includes('format=raw'))return Response.json({id:path.split('/drafts/')[1].split('?')[0],message:{raw:changedRaw||raw,threadId:'mock-thread'}});if(path.endsWith('/drafts/send')){sendCount++;const b=JSON.parse(init.body);expect(b.message.raw).toBe(raw);expect(b.id).toBeTruthy();if(uncertain)throw new Error('Response lost after request reached provider');return Response.json({id:'sent-message',threadId:'sent-thread'});}throw new Error('Unexpected provider request');}));}
describe('real-provider execution boundaries',()=>{
  it('sends approved MIME, consumes a Gmail draft and never replays the action',async()=>{mockGoogle();const d=await createDraft(ctx,{accountId,mode:'new',to:[{email:'recipient@example.com'}],bcc:[{email:'copy@example.com'}],subject:'Provider contract',bodyText:'Exact approved body'});const a=await propose(ctx,'send_email',{draftId:d.id,version:d.version});const result=await approve(ctx,a.id,a.payloadHash);expect(result.state).toBe('succeeded');expect(result.result?.url).toContain('sent-thread');expect(sendCount).toBe(1);await execute(a.id);expect(sendCount).toBe(1);expect(await db.resource.findUnique({where:{id:d.id}})).toBeNull();vi.unstubAllGlobals();});
  it('refuses to send a draft changed outside the application',async()=>{mockGoogle();const d=await createDraft(ctx,{accountId,mode:'new',to:[{email:'recipient@example.com'}],subject:'Changed draft',bodyText:'Approved content'});const a=await propose(ctx,'send_email',{draftId:d.id});changedRaw=Buffer.from(Buffer.from(raw,'base64url').toString().replace('Approved content','External Gmail edit')).toString('base64url');const before=sendCount;const result=await approve(ctx,a.id,a.payloadHash);expect(result.state).toBe('failed');expect(result.error?.message).toContain('changed');expect(sendCount).toBe(before);changedRaw=null;vi.unstubAllGlobals();});
  it('marks a lost send response uncertain and never retries it automatically',async()=>{mockGoogle();uncertain=true;const d=await createDraft(ctx,{accountId,mode:'new',to:[{email:'recipient@example.com'}],subject:'Uncertain send',bodyText:'Uncertain response'});const a=await propose(ctx,'send_email',{draftId:d.id});const before=sendCount;const result=await approve(ctx,a.id,a.payloadHash);expect(result.state).toBe('needs_review');await execute(a.id);expect(sendCount).toBe(before+1);expect(object((await db.resource.findUnique({where:{id:d.id}}))!.data).status).toBe('failed');await expect(prepareSend(ctx,d.id,{version:d.version,intent:'send'})).rejects.toMatchObject({status:409});await expect(approve(ctx,a.id,a.payloadHash)).rejects.toMatchObject({status:409});uncertain=false;vi.unstubAllGlobals();});
  it('decodes non-UTF8 MIME bodies and records correct incoming identities',async()=>{const c=(await connections(ctx))[0];const m=await mailMessage(c,{id:'encoded',internalDate:String(Date.now()),labelIds:['INBOX','UNREAD'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'Sender <sender@example.com>'},{name:'Subject',value:'=?ISO-8859-1?Q?Caf=E9?='},{name:'Content-Type',value:'text/plain; charset=ISO-8859-1'}],body:{data:Buffer.from([67,97,102,233]).toString('base64url')}}});expect(m.subject).toBe('Café');expect(m.bodyText?.trim()).toBe('Café');expect(m.from.email).toBe('sender@example.com');expect(m.outgoing).toBe(false);});
});
describe('OAuth state and PKCE',()=>{
  it('uses minimal login scopes and a proper base64url PKCE challenge',async()=>{const oldId=process.env.GOOGLE_CLIENT_ID,oldSecret=process.env.GOOGLE_CLIENT_SECRET;process.env.GOOGLE_CLIENT_ID='test-client.apps.googleusercontent.com';process.env.GOOGLE_CLIENT_SECRET='test-secret';try{const start=await beginOAuth(new Request('http://localhost:3100/api/auth/google?mode=login'));const url=new URL(start.headers.get('location')!);expect(url.searchParams.get('scope')).toBe('openid email profile');expect(url.searchParams.get('code_challenge')).toMatch(/^[a-zA-Z0-9_-]{43}$/);expect(url.searchParams.get('code_challenge_method')).toBe('S256');expect(url.searchParams.get('nonce')).toBeTruthy();const state=url.searchParams.get('state')!,bad=await finishOAuth(new Request('http://localhost:3100/api/auth/callback?state='+state+'&code=fake',{headers:{cookie:'orbitdesk_oauth=forged'}}));expect(bad.headers.get('location')).toContain('state_mismatch');const cancel=await finishOAuth(new Request('http://localhost:3100/api/auth/callback?state='+state+'&error=access_denied',{headers:{cookie:'orbitdesk_oauth='+state}}));expect(cancel.headers.get('location')).toContain('access_denied');const replay=await finishOAuth(new Request('http://localhost:3100/api/auth/callback?state='+state+'&error=access_denied',{headers:{cookie:'orbitdesk_oauth='+state}}));expect(replay.headers.get('location')).toContain('state_mismatch');}finally{if(oldId)process.env.GOOGLE_CLIENT_ID=oldId;else delete process.env.GOOGLE_CLIENT_ID;if(oldSecret)process.env.GOOGLE_CLIENT_SECRET=oldSecret;else delete process.env.GOOGLE_CLIENT_SECRET;}});
});

describe('Google quota handling',()=>{
  const quota=()=>Response.json({error:{code:403,errors:[{reason:'rateLimitExceeded'}],details:[{reason:'RATE_LIMIT_EXCEEDED'}]}},{status:403});
  it('backs off and retries a Gmail read rejected by the per-minute quota',async()=>{
    const c=(await connections(ctx))[0];
    const mock=vi.fn().mockResolvedValueOnce(quota()).mockResolvedValueOnce(Response.json({historyId:'123'}));
    vi.stubGlobal('fetch',mock);vi.useFakeTimers();
    try{
      const pending=api(c,'gmail/profile');
      // Attach both handlers before advancing timers, including on the failing implementation.
      const outcome=pending.then(value=>({value,error:null}),error=>({value:null,error}));
      await vi.waitFor(()=>expect(mock).toHaveBeenCalledTimes(1));
      await vi.runAllTimersAsync();
      const result=await outcome;
      expect(result.error).toBeNull();expect(result.value).toEqual({historyId:'123'});expect(mock).toHaveBeenCalledTimes(2);
    }finally{vi.useRealTimers();vi.unstubAllGlobals();}
  });
  it('reports quota exhaustion accurately without retrying a send',async()=>{
    const c=(await connections(ctx))[0],mock=vi.fn().mockResolvedValue(quota());vi.stubGlobal('fetch',mock);
    try{await expect(api(c,'gmail/drafts/send',{method:'POST',body:'{}'})).rejects.toMatchObject({code:'rate_limited',status:429});expect(mock).toHaveBeenCalledTimes(1);}
    finally{vi.unstubAllGlobals();}
  });
  it('stops retrying a persistently rate-limited read',async()=>{
    const c=(await connections(ctx))[0],mock=vi.fn().mockImplementation(async()=>quota());vi.stubGlobal('fetch',mock);vi.useFakeTimers();
    try{
      const outcome=api(c,'gmail/profile').then(()=>null,error=>error);
      await vi.waitFor(()=>expect(mock).toHaveBeenCalledTimes(1));await vi.runAllTimersAsync();
      expect(await outcome).toMatchObject({code:'rate_limited',status:429});expect(mock).toHaveBeenCalledTimes(7);
    }finally{vi.useRealTimers();vi.unstubAllGlobals();}
  });
  it('keeps real permission denials distinct and does not retry them',async()=>{
    const c=(await connections(ctx))[0],mock=vi.fn().mockResolvedValue(Response.json({error:{errors:[{reason:'domainPolicy'}]}},{status:403}));vi.stubGlobal('fetch',mock);
    try{await expect(api(c,'gmail/profile')).rejects.toMatchObject({code:'permission_missing',status:403});expect(mock).toHaveBeenCalledTimes(1);}
    finally{vi.unstubAllGlobals();}
  });
  it('shows successful Calendar and Tasks sync independently of a Gmail failure',async()=>{
    const c=(await connections(ctx))[0],at='2026-10-06T18:00:00.000Z';
    const v=connectionView({...c,status:'error',lastSyncAt:null,syncState:json({mail:{error:'Rate limit'},calendar:{lastSuccessAt:at,error:null},tasks:{lastSuccessAt:at,error:null}})},ctx);
    expect(v.sync.map(s=>[s.resource,s.status])).toEqual([['mail','error'],['calendar','ok'],['tasks','ok']]);
  });
  it('does not hide synced Tasks because the same account hit a Gmail quota',async()=>{
    const c=(await connections(ctx))[0],at='2026-10-06T18:00:00.000Z';
    try{
      await db.connection.update({where:{id:c.id},data:{status:'error',error:'Google temporarily limited this account.',scopes:[...c.scopes,'https://www.googleapis.com/auth/tasks'],syncState:json({mail:{error:'Google temporarily limited this account.'},tasks:{lastSuccessAt:at,error:null}})}});
      const scoped={...ctx,connectionIds:[c.id]};
      expect(await gapList(scoped,'tasks')).toEqual([]);expect(await gapList(scoped,'mail')).toHaveLength(1);
    }finally{await db.connection.update({where:{id:c.id},data:{status:c.status,error:c.error,scopes:c.scopes,syncState:json(c.syncState)}});}
  });
});
