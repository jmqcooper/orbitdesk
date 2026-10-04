import { db, object } from './db';
import { appUrl, requireSecret } from './config';
import { AppError, randomToken, sha256 } from './security';
import type { Context } from './store';
const COOKIE = 'orbitdesk_session';
export function readCookie(req: Request, name: string) {
  return (req.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1) || '';
}
export function cookie(name:string,value:string,maxAge:number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${appUrl().startsWith('https:')?'; Secure':''}`;
}
export async function createSession(userId:string,demo=false) {
  requireSecret('SESSION_SECRET');
  const token=randomToken();
  const ttl=demo?86400:86400*14;
  await db.session.create({data:{userId,tokenHash:sha256(token),expiresAt:new Date(Date.now()+ttl*1000)}});
  return cookie(COOKIE,token,ttl);
}
export async function context(req:Request,required=true):Promise<Context|null> {
  const token=readCookie(req,COOKIE);
  if(!token){if(required)throw new AppError('UNAUTHENTICATED','Sign in to continue.',401);return null;}
  const session=await db.session.findUnique({where:{tokenHash:sha256(token)},include:{user:{include:{workspaces:true}}}});
  if(!session || session.expiresAt.getTime()<Date.now()){if(required)throw new AppError('UNAUTHENTICATED','Your session expired. Sign in again.',401);return null;}
  const workspace=session.user.workspaces[0];
  if(!workspace){if(required)throw new AppError('UNAUTHENTICATED','Workspace not found.',401);return null;}
  const {workspaces:_,...user}=session.user;
  return {user,workspace};
}
export async function logout(req:Request) {
  const token=readCookie(req,COOKIE);
  if(token)await db.session.deleteMany({where:{tokenHash:sha256(token)}});
  return cookie(COOKIE,'',0);
}
export function enforceOrigin(req:Request) {
  if(['GET','HEAD','OPTIONS'].includes(req.method))return;
  const origin=req.headers.get('origin');
  const allowed=new Set([new URL(appUrl()).origin,new URL(req.url).origin]);
  if(req.headers.get('sec-fetch-site')==='cross-site' || (origin&&!allowed.has(origin)))throw new AppError('INVALID_ORIGIN','This request came from another site.',403);
}
export function sessionDto(ctx:Context) {
  return {user:{id:ctx.user.id,name:ctx.user.name,email:ctx.user.email,avatarUrl:ctx.user.avatarUrl},workspace:{id:ctx.workspace.id,name:ctx.workspace.name,isDemo:ctx.workspace.demo},isDemo:ctx.workspace.demo,settings:object(ctx.workspace.settings)};
}
