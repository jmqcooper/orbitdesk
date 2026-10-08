import { db } from './db';

/** Keep working drafts and pending approvals usable while purging expired mail bodies. */
export async function retainCache(now=new Date()) {
  const cutoff=new Date(now.getTime()-30*86400000).toISOString();
  await db.$executeRaw`
    DELETE FROM "Resource" r USING "Workspace" w
    WHERE r."workspaceId" = w.id AND w.demo = false AND r.kind = 'thread'
      AND r.data->>'lastMessageAt' < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "Resource" d WHERE d."workspaceId" = r."workspaceId" AND d.kind = 'draft' AND d."parentId" = r.id)
      AND NOT EXISTS (
        SELECT 1 FROM "Action" a WHERE a."workspaceId" = r."workspaceId"
          AND a.status IN ('proposed', 'approved', 'queued', 'running', 'needs_review')
          AND (a.payload->'input'->>'threadId' = r.id OR a.payload->'input'->'source'->>'id' = r.id OR a.payload->'input'->'threadIds' ? r.id)
      )
  `;
  // A verdict is only meaningful next to the conversation it describes.
  await db.$executeRaw`DELETE FROM "Resource" t WHERE t.kind = 'triage' AND NOT EXISTS (SELECT 1 FROM "Resource" r WHERE r.id = t."parentId" AND r.kind = 'thread')`;
  await db.activity.deleteMany({where:{createdAt:{lt:new Date(now.getTime()-90*86400000)}}});
  await db.resource.deleteMany({where:{kind:'event',updatedAt:{lt:new Date(now.getTime()-90*86400000)}}});
}
