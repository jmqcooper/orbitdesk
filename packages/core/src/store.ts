import { db, json, object } from './db';
import { AppError } from './security';
import type { Connection, Resource, Workspace, User } from '@prisma/client';
export interface Context { user: User; workspace: Workspace; connectionIds?: string[] }
export async function connection(ctx: Context, id: string) {
  if (ctx.connectionIds && !ctx.connectionIds.includes(id)) throw new AppError('ACCOUNT_SCOPE','This account is outside the selected assistant context.',403);
  const item=await db.connection.findFirst({where:{id,workspaceId:ctx.workspace.id}});
  if (!item) throw new AppError('NOT_FOUND','Account not found.',404);
  return item;
}
export async function connections(ctx: Context) {
  return db.connection.findMany({where:{workspaceId:ctx.workspace.id,...(ctx.connectionIds?{id:{in:ctx.connectionIds}}:{})},orderBy:{createdAt:'asc'}});
}
export async function resource(ctx: Context, id: string, kind?: string) {
  const item=await db.resource.findFirst({where:{id,workspaceId:ctx.workspace.id,...(kind?{kind}:{}),...(ctx.connectionIds?{connectionId:{in:ctx.connectionIds}}:{})}});
  if (!item) throw new AppError('NOT_FOUND','Item not found.',404);
  return item;
}
export async function resources(ctx: Context, kind: string, accountId?: string, parentId?: string) {
  if(accountId) await connection(ctx,accountId);
  return db.resource.findMany({where:{workspaceId:ctx.workspace.id,kind,...(accountId?{connectionId:accountId}:ctx.connectionIds?{connectionId:{in:ctx.connectionIds}}:{}),...(parentId?{parentId}:{})},orderBy:{updatedAt:'desc'}});
}
export async function put(conn: Connection, kind: string, providerId: string, data: unknown, parentId?: string, version?: string) {
  return db.resource.upsert({where:{connectionId_kind_providerId:{connectionId:conn.id,kind,providerId}},create:{workspaceId:conn.workspaceId,connectionId:conn.id,kind,providerId,data:json(data),parentId,version},update:{data:json(data),parentId,version}});
}
export const dto = (item: Resource) => ({...object(item.data),id:item.id,connectionId:item.connectionId,accountId:item.connectionId,providerId:item.providerId,updatedAt:item.updatedAt.toISOString()});
export const connectionDto = (item: Connection) => ({id:item.id,email:item.email,name:item.name,label:item.label,color:item.color,status:item.status,scopes:item.scopes,lastSyncAt:item.lastSyncAt?.toISOString() || null,error:item.error,settings:object(item.settings)});
export async function activity(ctx: Context, type: string, title: string, detail: unknown={}, connectionId?:string, resourceId?:string) {
  return db.activity.create({data:{workspaceId:ctx.workspace.id,actor:ctx.user.id,type,title,detail:json(detail),connectionId,resourceId}});
}

