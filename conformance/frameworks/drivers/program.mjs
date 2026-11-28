// The developer's program a direct-client fixture describes, run the same way
// for every client: inside `ap.run(fixture.input, …)` (or with no run), each
// step calls a client until the model stops asking for tools, running the
// tools itself in between, as an application's own loop does. The framework
// driver supplies the one call. Nothing here knows a provider's wire.
//
//   const refs = await runProgram({ ap, fixture, call: (step, history, run) => client.chat.completions.create(…) });
//
// fixture.agent: { clients: [{ slot, modelFor? }], scope?: "run" | "none", baseline?: true,
//                  steps: [{ client, model, system?, user?, tools?: [name], stream?, includeUsage?, api?, params?, setTags? }],
//                  feedback?: { signals } }
// `call` answers the tool names the model asked for (an empty list ends the step).

export const MAX_TURNS_PER_STEP = 12;

/** Runs every step; answers the run references read after each step (the latest value, read late). */
export async function runProgram({ ap, fixture, call }) {
  const refs = [];
  const body = async (run) => {
    for (const step of fixture.agent.steps) {
      const history = [];
      for (let turn = 0; turn < MAX_TURNS_PER_STEP; turn += 1) {
        const tools = await call(step, history, run);
        if (!tools.length) break;
      }
      if (step.setTags && run) run.setTags(step.setTags);
      if (run) refs.push(run.runRef);
    }
  };
  if ((fixture.agent.scope ?? "run") === "run") await ap.run(fixture.input ?? {}, body);
  else await body(null);
  return refs;
}

/** `modelFor` from a fixture's map: the release's id to the id this client sends; `null` (or a missing id) declines. */
export const modelForOf = (map) => (map ? (releaseModelId) => map[releaseModelId] ?? undefined : undefined);

/** What the provider saw, with `untouched` when a baseline run of the same program on the bare client sent the same request (URL, method, headers, body). */
export function seenWithBaseline(provider, baseline) {
  return provider.seen().map((call, i) => (baseline ? { ...call, untouched: baseline.calls[i] !== undefined && baseline.calls[i].request === provider.calls[i].request } : call));
}

/** `agent.feedback`: signals filed on the run's last reference after the program, as an application's thumbs-up does. */
export const feedbackOf = (ap, fixture, refs) => (fixture.agent.feedback && refs.length ? { feedback: ap.feedback(refs[refs.length - 1], fixture.agent.feedback) } : undefined);
