import { generateText, Output } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { z } from 'zod';
import { db } from './db';
import { appUrl, configuredAI } from './config';
import { AppError } from './security';
import type { Context } from './store';

/**
 * Every model call goes through OpenRouter. Two roles:
 *  - fast: quick classifications and yes/no decisions (triage lanes, "is a reply expected?").
 *  - agent: multi-step tool work (drafting replies, the assistant, briefs).
 */
export const fastModelName=()=>process.env.AI_FAST_MODEL||'typesafe/jev-router';
export const agentModelName=()=>process.env.AI_AGENT_MODEL||'z-ai/glm-5.3-flash';

function provider() {
  if(!configuredAI())throw new AppError('not_configured','Add an OpenRouter API key to use the agent.',503);
  // OPENROUTER_DATA_COLLECTION=deny keeps requests on upstream providers that do not retain or train on prompts.
  const policy=process.env.OPENROUTER_DATA_COLLECTION;
  return createOpenRouter({apiKey:process.env.OPENROUTER_API_KEY,baseURL:process.env.OPENROUTER_BASE_URL||undefined,compatibility:'strict',appName:'Orbitdesk',appUrl:appUrl(),extraBody:policy?{provider:{data_collection:policy}}:undefined});
}
// Jev Router chooses its own reasoning effort per request, so none is forced here.
export const fastModel=()=>provider().chat(fastModelName(),{usage:{include:true}});
export const agentModel=()=>provider().chat(agentModelName(),{usage:{include:true}});

/** Counts `amount` against a daily per-workspace cap inside one serialised transaction. */
export async function reserve(ctx:Context,kind:string,cap:number,amount=1,label='agent runs') {
  const since=new Date();since.setUTCHours(0,0,0,0);
  return db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ctx.workspace.id}))`;
    const used=await tx.usage.aggregate({where:{workspaceId:ctx.workspace.id,kind,createdAt:{gte:since}},_sum:{count:true}});
    if((used._sum.count||0)+amount>cap)throw new AppError('rate_limited',`This workspace has reached today’s limit of ${cap} ${label}.`,429);
    return tx.usage.create({data:{workspaceId:ctx.workspace.id,kind,count:amount}});
  });
}
export async function recordTokens(usageId:string,usage:{inputTokens?:number;outputTokens?:number}) {
  await db.usage.update({where:{id:usageId},data:{inputTokens:usage.inputTokens||0,outputTokens:usage.outputTokens||0}});
}

/**
 * A typed answer from the fast model: the "smart if". The schema is enforced,
 * so callers branch on real enums and booleans instead of parsing prose.
 */
export async function classify<S extends z.ZodType>(schema:S,system:string,prompt:string,maxOutputTokens=4000):Promise<{value:z.infer<S>;usage:{inputTokens?:number;outputTokens?:number}}> {
  const result=await generateText({model:fastModel(),output:Output.object({schema}),system,prompt,maxOutputTokens,abortSignal:AbortSignal.timeout(60000)});
  return {value:result.output as z.infer<S>,usage:result.usage};
}
