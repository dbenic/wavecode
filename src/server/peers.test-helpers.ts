/** A tiny fake peer WaveCode at the fetch boundary: agents, send, event log, messages. Test-only. */
export function fakePeer() {
  const state = { sends: [] as Array<{ agentId: string; text: string }>, events: [] as Array<Record<string, unknown>>, messages: [] as Array<Record<string, unknown>>, nextEvent: 100 };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (auth !== 'Bearer peer-token-0123456789') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    if (url.pathname === '/api/agents') {
      return Response.json([{ id: 'r-fable', name: 'fable', alias: 'fable', runtime: 'claude-code', status: 'idle' }, { id: 'r-other', name: 'deployer', alias: null, runtime: 'codex', status: 'idle' }]);
    }
    const send = /^\/api\/agents\/([^/]+)\/send$/.exec(url.pathname);
    if (send && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { text: string };
      state.sends.push({ agentId: send[1], text: body.text });
      return Response.json({ ok: true, prompt_event_id: state.nextEvent++ });
    }
    if (url.pathname === '/api/events/log') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const events = state.events.filter((e) => (e.id as number) > since);
      return Response.json({ events, last_id: events.length ? events[events.length - 1].id : since });
    }
    if (url.pathname === '/api/messages') return Response.json(state.messages);
    return new Response(JSON.stringify({ error: `no route ${url.pathname}` }), { status: 404 });
  };
  const answer = (promptEventId: number, text: string) => {
    const id = `m-${promptEventId}`;
    state.messages.push({ id, message: text, from_agent_id: 'r-fable', ref_prompt_event_id: promptEventId });
    state.events.push({ id: state.nextEvent++, type: 'message.created', entity_type: 'agent_message', entity_id: id, payload: { message_type: 'reply', ref_prompt_event_id: promptEventId, from_agent_id: 'r-fable' } });
  };
  return { state, fetchImpl, answer };
}
