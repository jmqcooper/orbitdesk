import { z } from 'zod';
import { db, json, object } from './db';
import { resource, connection, type Context } from './store';
import { api, enc } from './google';
import { assertScope } from './workspace';
import { fileView } from './views';
import { AppError } from './security';
import * as V from './validation';

export const documentOperation=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('doc_append'),fileId:V.id,text:z.string().min(1).max(100000)}),
  z.object({operation:z.literal('sheet_write'),fileId:V.id,range:z.string().min(1).max(200),values:z.array(z.array(z.union([z.string().max(10000),z.number(),z.boolean()])).max(100)).min(1).max(500)}),
  z.object({operation:z.literal('slide_add'),fileId:V.id,title:z.string().max(1000),body:z.string().max(10000)}),
]);
export async function readDocument(ctx:Context,input:unknown) {
  const v=z.object({fileId:V.id,range:z.string().max(200).optional()}).parse(input),r=await resource(ctx,v.fileId,'file'),c=await connection(ctx,r.connectionId),f=fileView(r);assertScope(c,'files',ctx);
  if(ctx.workspace.demo)return {file:f,content:object(r.data).content||'',revision:r.version||r.updatedAt.toISOString(),values:object(r.data).values||[],slides:object(r.data).slides||[]};
  if(f.kind==='doc'){const d=await api(c,`docs/documents/${enc(r.providerId)}?includeTabsContent=true`);const collect=(content:any[]):string=>content.map(x=>x.paragraph?.elements?.map((e:any)=>e.textRun?.content||'').join('')||x.table?.tableRows?.map((row:any)=>row.tableCells?.map((cell:any)=>collect(cell.content||[])).join('\t')).join('\n')||'').join('');const tabs=(d.tabs||[]).flatMap((tab:any)=>[tab,...(tab.childTabs||[])]);const text=d.body?collect(d.body.content||[]):tabs.map((t:any)=>collect(t.documentTab?.body?.content||[])).join('\n');return {file:f,content:text.slice(0,100000),revision:d.revisionId};}
  if(f.kind==='sheet'){const s=await api(c,`sheets/spreadsheets/${enc(r.providerId)}?fields=spreadsheetId,properties,sheets(properties)`);const range=v.range||s.sheets?.[0]?.properties?.title+'!A1:Z100';const cells=await api(c,`sheets/spreadsheets/${enc(r.providerId)}/values/${enc(range)}?valueRenderOption=FORMATTED_VALUE`);return {file:f,range:cells.range,values:cells.values||[],sheets:s.sheets?.map((x:any)=>x.properties)||[]};}
  if(f.kind==='slides'){const s=await api(c,`slides/presentations/${enc(r.providerId)}`);return {file:f,revision:s.revisionId,slides:(s.slides||[]).map((slide:any)=>({id:slide.objectId,text:(slide.pageElements||[]).map((e:any)=>e.shape?.text?.textElements?.map((t:any)=>t.textRun?.content||'').join('')||'').join('\n')}))};}
  throw new AppError('validation_failed','Choose a Google Doc, Sheet or Slides presentation.',422);
}
export async function validateDocumentOperation(ctx:Context,input:unknown) {const v=documentOperation.parse(input),r=await resource(ctx,v.fileId,'file'),c=await connection(ctx,r.connectionId),f=fileView(r);assertScope(c,'files',ctx);const kind=v.operation==='doc_append'?'doc':v.operation==='sheet_write'?'sheet':'slides';if(f.kind!==kind)throw new AppError('validation_failed',`This operation requires a Google ${kind} file.`,422);return {v,r,c,f};}
export async function writeDocument(ctx:Context,input:unknown,executionId:string) {
  const {v,r,c,f}=await validateDocumentOperation(ctx,input);let result:any={message:'Updated '+f.name,url:f.url};
  if(ctx.workspace.demo){const d=object(r.data);await db.resource.update({where:{id:r.id},data:{data:json({...d,...(v.operation==='doc_append'?{content:String(d.content||'')+'\n'+v.text}:v.operation==='sheet_write'?{values:v.values,range:v.range}:{slides:[...((d.slides||[]) as any[]),{title:v.title,body:v.body}]}),modifiedTime:new Date().toISOString()}),version:crypto.randomUUID()}});return result;}
  if(v.operation==='doc_append') {const current=await api(c,`docs/documents/${enc(r.providerId)}`);await api(c,`docs/documents/${enc(r.providerId)}:batchUpdate`,{method:'POST',body:JSON.stringify({writeControl:{requiredRevisionId:current.revisionId},requests:[{insertText:{endOfSegmentLocation:{},text:'\n'+v.text}}]})});}
  else if(v.operation==='sheet_write')await api(c,`sheets/spreadsheets/${enc(r.providerId)}/values/${enc(v.range)}?valueInputOption=RAW`,{method:'PUT',body:JSON.stringify({range:v.range,majorDimension:'ROWS',values:v.values})});
  else {const slideId='orbit_'+executionId.replaceAll(/[^a-zA-Z0-9_]/g,'').slice(0,35),titleId=slideId+'_title',bodyId=slideId+'_body';await api(c,`slides/presentations/${enc(r.providerId)}:batchUpdate`,{method:'POST',body:JSON.stringify({requests:[{createSlide:{objectId:slideId,slideLayoutReference:{predefinedLayout:'TITLE_AND_BODY'},placeholderIdMappings:[{layoutPlaceholder:{type:'TITLE',index:0},objectId:titleId},{layoutPlaceholder:{type:'BODY',index:0},objectId:bodyId}]}},{insertText:{objectId:titleId,text:v.title}},{insertText:{objectId:bodyId,text:v.body}}]})});}
  return result;
}
