import '../packages/core/src/config';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { handle, bootstrap } from '../packages/core/src/http';
import { db, object } from '../packages/core/src/db';
import { createDemo } from '../packages/core/src/seed';
import { createSession } from '../packages/core/src/session';
import { connections, resources, type Context } from '../packages/core/src/store';
import { getThreads } from '../packages/core/src/workspace';
import { draftReply, runTriage } from '../packages/core/src/triage';
import { stopQueue } from '../packages/core/src/jobs';
import { rowOf } from '../packages/core/src/lanes';
import { ownText, replyFields } from '../packages/core/src/compose';
import { connectionView, threadDetailView } from '../packages/core/src/views';

let ctx: Context, cookie: string;
const calls: any[] = [];
const hadKey = process.env.OPENROUTER_API_KEY, hadBase = process.env.OPENROUTER_BASE_URL;

/** OpenRouter's chat-completions endpoint, answering as each of the two models would. */
function mockOpenRouter(reply = 'Thursday at 14:00 works for me.\n\nMike', cutOff = 0) {
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body);
    calls.push(body);
    const usage = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 };
    if (body.model === 'typesafe/jev-router') {
      const { threads } = JSON.parse(body.messages.at(-1).content);
      const verdicts = threads.map((t: any) => ({
        ref: t.ref,
        // Deliberately wrong for sent mail: the server must not let a sent thread land in "reply".
        lane: t.last === 'SENT' ? 'reply' : /newsletter|receipt|usage|CI passed|reading/i.test(t.subject + t.text) ? 'other' : /invoice|notes/i.test(t.subject) ? 'fyi' : 'reply',
        summary: `About ${t.subject}`.slice(0, 80),
        urgent: /Thursday/.test(t.subject),
        meeting: /Thursday/.test(t.subject),
        task: /checklist/i.test(t.subject) ? { title: 'Finish the reconnect checks', due: 'next friday' } : null,
      }));
      // A route that thought for too long: the answer stops mid-JSON at the output cap.
      if (cutOff-- > 0) return Response.json({ id: 'gen-0', model: body.model, choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: JSON.stringify({ threads: verdicts }).slice(0, 90) } }], usage });
      return Response.json({ id: 'gen-1', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ threads: verdicts }) } }], usage });
    }
    return Response.json({
      id: 'gen-2',
      model: body.model,
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'submit_reply', arguments: JSON.stringify({ body: reply, note: 'No calendar check needed' }) } }] } }],
      usage,
    });
  }));
}
async function call(path: string, method = 'GET', data?: unknown) {
  const r = await handle(new Request('http://localhost:3100/api/' + path, { method, headers: { cookie, origin: 'http://localhost:3100', 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }));
  return { status: r.status, json: await r.json() };
}
/** Puts the sandbox back to "nothing sorted, nothing drafted". */
async function unsort() {
  await db.resource.deleteMany({ where: { workspaceId: ctx.workspace.id, kind: { in: ['triage', 'draft'] } } });
}

beforeAll(async () => {
  // Whatever the local .env says, these checks talk to the mocked public endpoint.
  process.env.OPENROUTER_API_KEY = 'test-key';
  delete process.env.OPENROUTER_BASE_URL;
  ctx = await createDemo();
  cookie = (await createSession(ctx.user.id, true)).split(';')[0];
});
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});
afterAll(async () => {
  if (hadKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = hadKey;
  if (hadBase !== undefined) process.env.OPENROUTER_BASE_URL = hadBase;
  await stopQueue();
  await db.user.delete({ where: { id: ctx.user.id } });
  await db.$disconnect();
});

describe('sandbox triage', () => {
  it('opens with every conversation sorted and drafts waiting where a reply is due', async () => {
    const b = await bootstrap(ctx);
    expect(b.counts.lanes).toEqual({ reply: 5, fyi: 2, other: 5, waiting: 0, unsorted: 0 });
    expect(b.counts.draftsReady).toBe(4);
    expect(b.settings.onboardedAt).toBeTruthy();
    const reply = await call('threads?lane=reply');
    expect(reply.json.data.items).toHaveLength(5);
    // The urgent conversation leads the lane.
    expect(reply.json.data.items[0].triage).toMatchObject({ lane: 'reply', urgent: true, meeting: true });
    expect(reply.json.data.items.filter((t: any) => t.hasDraft)).toHaveLength(4);
    expect((await call('threads?lane=nonsense')).status).toBe(422);
  });

  it('builds reply recipients from the message headers and keeps the quote below the text', async () => {
    const thread = (await resources(ctx, 'thread')).find((r) => object(r.data).subject === 'Beta launch checklist')!;
    const c = (await connections(ctx)).find((x) => x.id === thread.connectionId)!;
    const fields = replyFields(threadDetailView(thread).messages.at(-1)!, connectionView(c, ctx), 'Europe/Amsterdam');
    expect(fields.to).toEqual([{ name: 'Sarah Chen', email: 'sarah@northstar.example' }]);
    expect(fields.cc).toEqual([]);
    expect(fields.subject).toBe('Re: Beta launch checklist');
    expect(fields.tail).toMatch(/^On .+ wrote:\n> We need to finish/);
    const draft = (await resources(ctx, 'draft', c.id, thread.id))[0];
    expect(ownText(String(object(draft.data).bodyText))).toMatch(/^Yes, I’ll take the reconnect checks/);
    expect(ownText(String(object(draft.data).bodyText))).not.toContain('>');
  });
});

describe('the sorting pass', () => {
  it('sorts with the fast model, drafts with the agent model, and never trusts a lane the direction rules out', async () => {
    await unsort();
    expect((await bootstrap(ctx)).counts.lanes.unsorted).toBe(12);
    // One conversation where the owner wrote last.
    const sent = (await resources(ctx, 'thread')).find((r) => object(r.data).subject === 'Dinner on Saturday')!, data = object(sent.data), messages = data.messages as any[];
    await db.resource.update({ where: { id: sent.id }, data: { data: { ...data, messages: [...messages, { ...messages[0], id: 'mine', outgoing: true, bodyText: 'We are in. See you there.', from: { name: 'Mike Cooper', email: 'mike@cooper.example' }, to: [{ name: 'Oliver Reed', email: 'oliver@friends.example' }] }], lastMessageAt: new Date().toISOString(), messageCount: 2 } as any } });
    mockOpenRouter();
    const result = await runTriage(ctx, { maxSort: 20, maxDrafts: 2 });
    expect(result.sorted).toBe(12);
    expect(result.drafted).toBe(2);
    expect(result.remaining).toBeGreaterThan(0);

    const sorting = calls.filter((c) => c.model === 'typesafe/jev-router'), drafting = calls.filter((c) => c.model === 'z-ai/glm-5.3-flash');
    expect(sorting).toHaveLength(2);
    expect(drafting).toHaveLength(2);
    expect(sorting[0].response_format.type).toBe('json_schema');
    // A background draft may check free/busy but cannot be steered into reading other mail or event titles.
    expect(drafting[0].tools.map((t: any) => t.function.name)).toEqual(['find_free_time', 'submit_reply']);
    // The reply can only come back through submit_reply, never as loose prose, and evenings can be checked.
    expect(drafting[0].tool_choice).toBe('required');
    expect(Object.keys(drafting[0].tools[0].function.parameters.properties)).toContain('outsideWorkingHours');
    // The persona from onboarding reaches the drafting prompt.
    expect(drafting[0].messages[0].role).toBe('system');
    expect(JSON.stringify(drafting[0].messages[0].content)).toContain('Sign off with “Mike”');

    const b = await bootstrap(ctx);
    expect(b.counts.lanes.unsorted).toBe(0);
    expect(b.counts.lanes.waiting).toBe(1);
    expect(b.counts.draftsReady).toBe(2);
    const waiting = await getThreads(ctx, '', 'inbox', undefined, 100, 'waiting');
    expect(waiting.items.map((t) => t.subject)).toEqual(['Dinner on Saturday']);
    const checklist = (await getThreads(ctx, '', 'inbox', undefined, 100, 'reply')).items.find((t) => t.subject === 'Beta launch checklist')!;
    // An unparseable due date is dropped rather than stored.
    expect(checklist.triage!.task).toEqual({ title: 'Finish the reconnect checks', due: null });

    // A second pass has nothing left to sort and only drafts what is still pending.
    calls.length = 0;
    const again = await runTriage(ctx, { maxSort: 20, maxDrafts: 10 });
    expect(again.sorted).toBe(0);
    expect(calls.every((c) => c.model === 'z-ai/glm-5.3-flash')).toBe(true);
    expect((await bootstrap(ctx)).counts.draftsReady).toBe(again.drafted + 2);
  });

  it('writes a threaded draft to the sender only, with the model supplying nothing but the text', async () => {
    const thread = (await getThreads(ctx, '', 'inbox', undefined, 100, 'reply')).items.find((t) => t.subject.startsWith('Product review'))!;
    const stored = (await resources(ctx, 'draft')).find((d) => d.parentId === thread.id)!, draft = object(stored.data);
    expect(draft.to).toEqual([{ name: 'Lena Fischer', email: 'lena@northstar.example' }]);
    expect(draft.subject).toBe('Re: Product review · Thursday?');
    expect(String(draft.bodyText)).toMatch(/^Thursday at 14:00 works for me\.\n\nMike\n\nOn .+ wrote:\n> Hey Mike/);
    expect(Buffer.from(String(draft._raw), 'base64url').toString()).toMatch(/In-Reply-To: <demo-0@orbitdesk\.example>/);
    expect(thread.triage!.draft).toMatchObject({ state: 'ready', draftId: stored.id, note: 'No calendar check needed' });
    expect(await db.action.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
  });

  it('rewrites the draft on request, and leaves a draft somebody else started alone in the background', async () => {
    const thread = (await getThreads(ctx, '', 'inbox', undefined, 100, 'reply')).items.find((t) => t.subject.startsWith('Product review'))!;
    mockOpenRouter('Can we do 10:00 instead?\n\nMike');
    const out = await call(`threads/${thread.id}/triage`, 'POST', { redraft: true, instruction: 'Ask for 10:00 instead' });
    expect(out.status).toBe(200);
    expect(out.json.data.draft.bodyText).toMatch(/^Can we do 10:00 instead\?/);
    expect(out.json.data.draft.id).toBe(thread.triage!.draft.draftId);
    expect(calls[0].tools.map((t: any) => t.function.name)).toEqual(['find_free_time', 'list_events', 'search_mail', 'read_thread', 'submit_reply']);
    const prompt = calls[0].messages.at(-1).content;
    expect(prompt).toContain('The user\'s instruction for this reply: Ask for 10:00 instead');
    expect(prompt).toContain('<current_draft>\nThursday at 14:00 works for me.');
    expect((await resources(ctx, 'draft')).filter((d) => d.parentId === thread.id)).toHaveLength(1);

    calls.length = 0;
    expect(await draftReply(ctx, thread.id, { auto: true })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('lets the user move a conversation and settle a suggested task, and re-sorts only when new mail arrives', async () => {
    const thread = (await getThreads(ctx, '', 'inbox', undefined, 100, 'reply')).items.find((t) => t.subject === 'Beta launch checklist')!;
    const moved = await call(`threads/${thread.id}/triage`, 'POST', { lane: 'fyi', taskDone: true });
    expect(moved.json.data.thread.triage).toMatchObject({ lane: 'fyi', manual: true, taskDone: true });
    mockOpenRouter();
    expect((await runTriage(ctx)).sorted).toBe(0);
    const row = (await resources(ctx, 'thread')).find((r) => r.id === thread.id)!, data = object(row.data);
    await db.resource.update({ where: { id: row.id }, data: { data: { ...data, lastMessageAt: new Date().toISOString() } as any } });
    expect((await bootstrap(ctx)).counts.lanes.unsorted).toBe(1);
    expect((await runTriage(ctx, { maxDrafts: 0 })).sorted).toBe(1);
    expect((await call(`threads/${thread.id}`)).json.data.triage).toMatchObject({ lane: 'reply', manual: false });
  });

  it('does not show the agent an account it may not read, and stays idle when switched off', async () => {
    await unsort();
    const studio = (await connections(ctx)).find((c) => c.label === 'Studio')!;
    await call(`connections/${studio.id}`, 'PATCH', { assistantAccess: false });
    mockOpenRouter();
    await runTriage(ctx, { maxSort: 20, maxDrafts: 0 });
    const seen = calls.flatMap((c) => JSON.parse(c.messages.at(-1).content).threads.map((t: any) => t.account));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain('Studio');
    expect((await resources(ctx, 'triage')).some((r) => r.connectionId === studio.id)).toBe(false);

    await unsort();
    await call('settings', 'PATCH', { autoTriage: false });
    ctx.workspace = (await db.workspace.findUnique({ where: { id: ctx.workspace.id } }))!;
    calls.length = 0;
    expect(await runTriage(ctx)).toEqual({ sorted: 0, drafted: 0, remaining: 0, error: null });
    expect(calls).toHaveLength(0);
    expect(rowOf(null)).toBeNull();
  });
});

describe('when the model fails', () => {
  it('changes nothing, says why, and leaves the conversations for the next pass', async () => {
    await call('settings', 'PATCH', { autoTriage: true });
    ctx.workspace = (await db.workspace.findUnique({ where: { id: ctx.workspace.id } }))!;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'upstream unavailable', code: 503 } }, { status: 503 })));
    const out = await runTriage(ctx, { maxSort: 10 });
    expect(out.sorted).toBe(0);
    expect(out.remaining).toBeGreaterThan(0);
    expect(out.error).toMatch(/usable answer/);
    expect(await resources(ctx, 'triage')).toHaveLength(0);
  });

  it('asks the fast model once more when its answer is cut off, and gives up after a second one', async () => {
    // Its own sandbox: the one above has used up its runs for the day.
    const fresh = await createDemo(), clear = () => db.resource.deleteMany({ where: { workspaceId: fresh.workspace.id, kind: { in: ['triage', 'draft'] } } });
    try {
      await clear();
      mockOpenRouter(undefined, 1);
      const retried = await runTriage(fresh, { maxSort: 10, maxDrafts: 0 });
      expect(retried).toMatchObject({ sorted: 10, error: null });
      // The same batch, asked twice.
      expect(calls).toHaveLength(2);
      expect(calls[1].messages.at(-1).content).toBe(calls[0].messages.at(-1).content);
      expect(await resources(fresh, 'triage')).toHaveLength(10);

      await clear();
      calls.length = 0;
      vi.unstubAllGlobals();
      mockOpenRouter(undefined, 2);
      const failed = await runTriage(fresh, { maxSort: 10, maxDrafts: 0 });
      expect(failed).toMatchObject({ sorted: 0, error: 'The model did not return a usable answer. Nothing was changed.' });
      expect(calls).toHaveLength(2);
      expect(await resources(fresh, 'triage')).toHaveLength(0);
    } finally {
      await db.user.delete({ where: { id: fresh.user.id } });
    }
  });
});

describe('onboarding state', () => {
  it('stores voice and about, stamps onboarding once, and reports both models', async () => {
    const fresh = await createDemo();
    try {
      await db.workspace.update({ where: { id: fresh.workspace.id }, data: { settings: {} } });
      const auth = (await createSession(fresh.user.id, true)).split(';')[0];
      const send = async (path: string, method = 'GET', data?: unknown) => (await (await handle(new Request('http://localhost:3100/api/' + path, { method, headers: { cookie: auth, origin: 'http://localhost:3100', 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }))).json()).data;
      const before = await send('bootstrap');
      expect(before.settings).toMatchObject({ onboardedAt: null, voice: null, about: null, autoTriage: true, autoDraft: true });
      expect(before.capabilities).toMatchObject({ fastModel: 'typesafe/jev-router', agentModel: 'z-ai/glm-5.3-flash' });
      const done = await send('settings', 'PATCH', { voice: 'Dry and brief.', about: 'I run a studio.', onboarded: true });
      expect(done.settings).toMatchObject({ voice: 'Dry and brief.', about: 'I run a studio.' });
      const stamp = done.settings.onboardedAt;
      expect(stamp).toBeTruthy();
      expect((await send('settings', 'PATCH', { voice: '', onboarded: true })).settings).toMatchObject({ voice: null, onboardedAt: stamp });
    } finally {
      await db.user.delete({ where: { id: fresh.user.id } });
    }
  });
});
