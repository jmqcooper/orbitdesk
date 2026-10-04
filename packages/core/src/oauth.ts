import { db, json, object } from './db';
import { configuredGoogle, appUrl } from './config';
import { oauthClient, GOOGLE_SCOPES } from './google';
import { context, readCookie, cookie, createSession } from './session';
import { randomToken, sha256, encrypt, constantEqual, AppError } from './security';
import { connection } from './store';
import { createHash } from 'node:crypto';

export async function beginOAuth(req:Request) {
  const u=new URL(req.url);const mode=u.searchParams.get('mode')==='connect'?'connect':'login';
  if(!configuredGoogle())return Response.redirect(`${appUrl()}/?auth_error=not_configured`,302);
  const ctx=await context(req,mode==='connect');if(ctx?.workspace.demo)throw new AppError('demo_restricted','Sign out of the sandbox before connecting real accounts.',403);
  const conn=u.searchParams.get('accountId')&&ctx?await connection(ctx,u.searchParams.get('accountId')!):null;
  const verifier=randomToken(64),state=randomToken(),nonce=randomToken();
  const requested=(u.searchParams.get('features')||'mail,calendar,tasks').split(',').filter(x=>GOOGLE_SCOPES[x]);
  const scopes=['openid','email','profile',...(mode==='connect'?requested.flatMap(x=>GOOGLE_SCOPES[x]):[])];
  await db.oAuthState.create({data:{id:sha256(state),userId:ctx?.user.id,workspaceId:ctx?.workspace.id,mode,verifier,nonce:JSON.stringify({nonce,accountId:conn?.id||null,googleSub:conn?.googleSub||null}),expiresAt:new Date(Date.now()+600000)}});
  const url=oauthClient().generateAuthUrl({access_type:'offline',prompt:mode==='connect'?'consent select_account':'select_account',scope:scopes,state,include_granted_scopes:true,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256' as any,login_hint:conn?.email,...{nonce}});
  return new Response(null,{status:302,headers:{Location:url,'Set-Cookie':cookie('orbitdesk_oauth',state,600),'Cache-Control':'no-store'}});
}
export async function finishOAuth(req:Request) {
  const u=new URL(req.url);const state=u.searchParams.get('state')||'';const clear=cookie('orbitdesk_oauth','',0);
  const redirect=(q:string)=>new Response(null,{status:302,headers:{Location:appUrl()+'/?'+q,'Set-Cookie':clear}});
  if(!state||!constantEqual(state,readCookie(req,'orbitdesk_oauth')))return redirect('auth_error=state_mismatch');
  const record=await db.oAuthState.findUnique({where:{id:sha256(state)}});if(!record||record.expiresAt.getTime()<Date.now())return redirect('auth_error=state_mismatch');
  const consumed=await db.oAuthState.deleteMany({where:{id:record.id}});if(!consumed.count)return redirect('auth_error=state_mismatch');
  if(u.searchParams.has('error'))return redirect('auth_error=access_denied');
  const meta=JSON.parse(record.nonce);const client=oauthClient();
  try{
    const {tokens}=await client.getToken({code:u.searchParams.get('code')||'',codeVerifier:record.verifier});
    if(!tokens.id_token)return redirect('auth_error=server_error');
    const ticket=await client.verifyIdToken({idToken:tokens.id_token,audience:process.env.GOOGLE_CLIENT_ID});const p=ticket.getPayload();
    if(!p?.sub||!p.email||!p.email_verified||(p as any).nonce!==meta.nonce)return redirect('auth_error=state_mismatch');
    if(record.mode==='login'){
      const beta=(process.env.BETA_EMAILS||'').split(',').map(e=>e.trim().toLowerCase()).filter(Boolean);if(beta.length&&!beta.includes(p.email.toLowerCase()))return redirect('auth_error=not_invited');
      let user=await db.user.findUnique({where:{googleSub:p.sub}});
      if(!user){const existing=await db.user.findUnique({where:{email:p.email}});if(existing&&!existing.googleSub)return redirect('auth_error=server_error');user=await db.user.create({data:{googleSub:p.sub,email:p.email,name:p.name||p.email,avatarUrl:p.picture,workspaces:{create:{name:`${p.given_name||'My'} workspace`}}}});}
      return new Response(null,{status:302,headers:{Location:appUrl()+'/?auth=signed_in','Set-Cookie':await createSession(user.id)}});
    }
    const ctx=await context(req,true);if(!ctx||ctx.user.id!==record.userId||ctx.workspace.id!==record.workspaceId)return redirect('auth_error=session_required');
    if(meta.googleSub&&meta.googleSub!==p.sub)return redirect('auth_error=account_mismatch');
    const existing=await db.connection.findUnique({where:{workspaceId_googleSub:{workspaceId:ctx.workspace.id,googleSub:p.sub}}});
    if(!existing&&await db.connection.count({where:{workspaceId:ctx.workspace.id}})>=30)return redirect('auth_error=account_limit');
    const prior=existing?.credentials?(await import('./security')).decrypt<any>(existing.credentials):{};
    if(!tokens.refresh_token&&!prior.refresh_token)return redirect('auth_error=scope_denied');
    const scopes=(tokens.scope||'').split(' ');const conn=await db.connection.upsert({where:{workspaceId_googleSub:{workspaceId:ctx.workspace.id,googleSub:p.sub}},create:{workspaceId:ctx.workspace.id,googleSub:p.sub,email:p.email,name:p.name||p.email,label:p.email.split('@')[0]!,color:['#c17b43','#6c8a77','#7287ad','#a27594'][await db.connection.count({where:{workspaceId:ctx.workspace.id}})%4]!,status:'connected',scopes,credentials:encrypt({...prior,...tokens}),settings:json({avatarUrl:p.picture,assistantAccess:true})},update:{credentials:encrypt({...prior,...tokens}),scopes,status:'connected',error:null}});
    const {enqueueSync}=await import('./jobs');await enqueueSync(conn.id);return redirect('auth=connected&accountId='+conn.id);
  }catch{return redirect('auth_error=server_error');}
}
