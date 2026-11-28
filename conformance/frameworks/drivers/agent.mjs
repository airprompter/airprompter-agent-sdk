// The agent driver (TypeScript): the SDK's own run API with no framework, for
// the kinds that are about where a run lives, not how a framework calls it.
//
// - `two-store`: a run on agent A; `ap.feedback` on agent B over another
//   store sharing A's run-reference secret, on C after a rotation (the old
//   secret among its previous ones), and on D with another secret (false).
//   B, C and D hold no release: feedback reads the reference alone.
// - `split-invocation`: A renders the prompt (`ap.prompt(slot, { subject })`),
//   and only the run reference crosses to B, which holds no release and reports
//   the model step with `ap.reportRun`: one run row, on the version and arm the
//   reference names, usage attached once.
//
//   const { calls, runRefs, results } = await driveRun({ ap, fixture, clock, load, host });

export async function driveRun({ ap, fixture, clock, host }) {
  const { slot } = fixture.agent;
  const [turn] = fixture.recorded.turns;
  const latencyMs = turn.latencyMs ?? 100;
  if (fixture.kind === "two-store") {
    const usage = { input: turn.usage?.input ?? 0, cachedInput: turn.usage?.cachedInput ?? 0, output: turn.usage?.output ?? 0, source: "reported" };
    const { runRef } = await ap.run(fixture.input ?? {}, async (run) => {
      const placed = await run.place(slot);
      clock.ms += latencyMs;
      run.recordModelCall(slot, { model: placed.kind === "approved" ? placed.model : "none", latencyMs, usage });
      return { runRef: run.runRef };
    });
    const shared = await host.startAgent({ release: false });
    const rotated = await host.startAgent({ release: false, runRefSecret: fixture.agent.rotatedSecret, runRefPreviousSecrets: [fixture.agent.sharedSecret] });
    const stranger = await host.startAgent({ release: false, runRefSecret: fixture.agent.otherSecret });
    const results = {
      feedback: [shared.feedback(runRef, { thumbs: "up" }), rotated.feedback(runRef, { rating: 4 }), stranger.feedback(runRef, { rating: 1 })],
      explained: [shared.explain(runRef)?.length ?? null, stranger.explain(runRef)],
    };
    return { calls: [], runRefs: [runRef], results };
  }
  if (fixture.kind === "split-invocation") {
    const rendered = ap.prompt(slot, fixture.input?.subject ? { subject: fixture.input.subject } : {}).render(fixture.input?.variables ?? {});
    clock.ms += latencyMs;
    const reporter = await host.startAgent({ release: false });
    const reported = reporter.reportRun(rendered.runRef, { inputTokens: turn.usage?.input ?? 0, cachedInputTokens: turn.usage?.cachedInput ?? 0, outputTokens: turn.usage?.output ?? 0, latencyMs });
    return { calls: [], runRefs: [rendered.runRef], results: { reported, servedVersion: rendered.versionId, servedArm: rendered.arm } };
  }
  throw new Error(`the agent driver has no ${fixture.kind} case`);
}
