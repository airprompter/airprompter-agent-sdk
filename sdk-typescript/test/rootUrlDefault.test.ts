/**
 * Where an agent reads its root document when `sync.rootUrl` is not set. A pinned AirPrompter root (`HOSTED_ROOTS`)
 * reads its own environment's `root.json`; any other pinned root refuses to start a syncing runtime, saying what to
 * add; a runtime that never syncs needs none; an explicit `rootUrl` wins. The default moves where the document is
 * fetched from, never what is trusted: a document that does not verify against the pin is refused exactly as before.
 *
 * The fake cannot sign as AirPrompter, so a test that needs a hosted root puts the fake's key in `HOSTED_ROOTS` for its
 * duration (`asHosted`). The real table is checked on its own, against the ceremonies' documents.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentStartError, AirPrompterAgent, type StartOptions } from "../packages/sdk/src/agent.js";
import { HOSTED_ROOTS, HOSTED_ROOT_URLS, hostedEnvironmentOfRoot, keyThumbprint, publicJwkOf, rootUrlFor, trustedRootFromPinnedKey, verifyRootMetadata } from "../packages/sdk/src/core/index.js";
import type { FetchLike, HostedEnvironment, P256PublicJwk, RootMetadata } from "../packages/sdk/src/core/index.js";
import { HOSTED_ROOTS as STEPS_HOSTED_ROOTS } from "../packages/sdk/src/frameworks/steps/index.js";
import { FakeControlPlane, rootDocument } from "./helpers/controlPlane.js";

const scope: { organizationId: string; agentId: string; target: string } = { organizationId: "org_1", agentId: "agt_1", target: "prod" };
const PROD_URL = "https://api.airprompter.com/roots/prod/root.json";
const DEV_URL = "https://api.airprompter.dev/roots/dev/root.json";
const REAL = { dev: HOSTED_ROOTS.dev!, prod: HOSTED_ROOTS.prod! };

async function asHosted<T>(environment: HostedEnvironment, key: P256PublicJwk, run: () => Promise<T>): Promise<T> {
  const before = HOSTED_ROOTS[environment];
  HOSTED_ROOTS[environment] = key;
  try {
    return await run();
  } finally {
    if (before) HOSTED_ROOTS[environment] = before;
    else delete HOSTED_ROOTS[environment];
  }
}

function options(plane: FakeControlPlane, extra: Partial<StartOptions> = {}, events: Array<Record<string, unknown>> = []): StartOptions {
  return {
    ...plane.scope,
    apiKey: plane.apiKey,
    stateDir: mkdtempSync(join(tmpdir(), "ap-root-url-")),
    root: { pinned: publicJwkOf(plane.rootKey) },
    sync: { mode: "resident", pollSeconds: 3600 },
    fetch: plane.fetch(),
    telemetry: { sink: "memory" },
    logger: (event) => void events.push(event),
    ...extra,
  };
}

function promoted(planeScope = scope, hostedEnvironment?: HostedEnvironment): FakeControlPlane {
  const plane = new FakeControlPlane(planeScope, undefined, {}, hostedEnvironment ? { hostedEnvironment } : {});
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply politely.", versionId: "ver_reply_1" })]);
  return plane;
}

const rootUrls = (requests: string[]) => [...new Set(requests.filter((url) => url.endsWith("/root.json")))];

async function served(ap: AirPrompterAgent): Promise<string | null> {
  try {
    return ap.prompt("support.reply").render({}).versionId;
  } catch {
    return null;
  } finally {
    await ap.stop();
  }
}

test("the hosted tables: prod and dev only, https on AirPrompter's API hosts, one table shared with the Steps client", () => {
  assert.deepEqual({ ...HOSTED_ROOT_URLS }, { dev: DEV_URL, prod: PROD_URL });
  assert.ok(Object.isFrozen(HOSTED_ROOT_URLS));
  assert.equal(STEPS_HOSTED_ROOTS, HOSTED_ROOTS, "the Steps client reads the same table");
  assert.equal(keyThumbprint(REAL.prod), "044af6e83353a2ea3758cc3feb3b1b7031c82bda5d6cd9287ba7730363e11793");
  assert.equal(keyThumbprint(REAL.dev), "86267aa3dc49005a0c1474d5c9c06bd7e1d0e835da715a864c1eca706545df91");
  assert.equal(hostedEnvironmentOfRoot(REAL.prod), "prod");
  assert.equal(hostedEnvironmentOfRoot(REAL.dev), "dev");
  assert.equal(hostedEnvironmentOfRoot(publicJwkOf(new FakeControlPlane(scope).rootKey)), null);
  assert.equal(hostedEnvironmentOfRoot({ kty: "EC", crv: "P-256", x: "not", y: "a key" }), null);
  // The real documents each ceremony signed verify under the key the URL is chosen for, and not under the other.
  const doc = (name: string) => JSON.parse(readFileSync(new URL(`./frameworks/steps/fixtures/hosted-${name}-root.json`, import.meta.url), "utf8")) as RootMetadata;
  const under = (key: P256PublicJwk, environment: HostedEnvironment) => trustedRootFromPinnedKey({ purpose: "platform", environment, pinnedRoot: key });
  assert.deepEqual(verifyRootMetadata({ candidate: doc("prod"), trusted: under(REAL.prod, "prod"), now: "2026-11-28T00:00:00.000Z" }), { ok: true });
  assert.deepEqual(verifyRootMetadata({ candidate: doc("dev"), trusted: under(REAL.dev, "dev"), now: "2026-11-16T00:00:00.000Z" }), { ok: true });
  assert.equal(verifyRootMetadata({ candidate: doc("dev"), trusted: under(REAL.prod, "prod"), now: "2026-11-16T00:00:00.000Z" }).ok, false);
  assert.equal(verifyRootMetadata({ candidate: doc("prod"), trusted: under(REAL.dev, "dev"), now: "2026-11-28T00:00:00.000Z" }).ok, false);
});

test("the rule: explicit wins; no URL without a pin or without sync; a hosted pin gets its own environment's URL; anything else is refused", () => {
  const stranger = publicJwkOf(new FakeControlPlane(scope).rootKey);
  assert.deepEqual(rootUrlFor({ rootUrl: "https://mirror.test/r.json", pinned: REAL.prod, syncs: true }), { url: "https://mirror.test/r.json", defaultFor: null });
  assert.deepEqual(rootUrlFor({ pinned: REAL.prod, syncs: true }), { url: PROD_URL, defaultFor: "prod" });
  assert.deepEqual(rootUrlFor({ pinned: REAL.dev, hostedEnvironment: "dev", syncs: true }), { url: DEV_URL, defaultFor: "dev" });
  assert.deepEqual(rootUrlFor({ pinned: REAL.prod, syncs: false }), { url: null, defaultFor: null });
  assert.deepEqual(rootUrlFor({ pinned: stranger, syncs: false }), { url: null, defaultFor: null });
  assert.deepEqual(rootUrlFor({ pinned: null, syncs: true }), { url: null, defaultFor: null });
  // A dev pin never reads prod's URL, nor a prod pin dev's: the environment named must be the pin's own.
  assert.deepEqual(rootUrlFor({ pinned: REAL.dev, syncs: true }), { refused: 'root.pinned is AirPrompter\'s dev root, but root.hostedEnvironment is "prod" (the default). Add hostedEnvironment: "dev" to root, or pin the prod root.' });
  assert.deepEqual(rootUrlFor({ pinned: REAL.prod, hostedEnvironment: "dev", syncs: true }), { refused: 'root.pinned is AirPrompter\'s prod root, but root.hostedEnvironment is "dev". Add hostedEnvironment: "prod" to root, or pin the dev root.' });
  assert.deepEqual(rootUrlFor({ pinned: stranger, syncs: true }), { refused: 'root.pinned is not one of AirPrompter\'s hosted roots, so the SDK cannot know where its root document is, and without it no release verifies. Add sync: { rootUrl: "https://<your service>/roots/prod/root.json" }, the root document of the service that signs your releases.' });
  assert.match((rootUrlFor({ pinned: stranger, hostedEnvironment: "staging", syncs: true }) as { refused: string }).refused, /sync: \{ rootUrl: "https:\/\/<your service>\/roots\/staging\/root\.json" \}/);
});

test("a custom pinned root with no rootUrl fails fast at start, before the store opens, saying exactly what to add", async () => {
  const plane = promoted();
  const opts = options(plane);
  await assert.rejects(AirPrompterAgent.start(opts), (error: unknown) => {
    assert.ok(error instanceof AgentStartError);
    assert.equal(error.code, "invalid_options");
    assert.ok(error.message.includes('Add sync: { rootUrl: "https://<your service>/roots/prod/root.json" }'), error.message);
    return true;
  });
  assert.deepEqual(readdirSync(opts.stateDir!), [], "nothing was opened or written");
  assert.deepEqual(plane.requests, [], "nothing was fetched");
  rmSync(opts.stateDir!, { recursive: true, force: true });
});

test("a runtime that never syncs needs no rootUrl: no apiKey, sync.mode offline, or a full root document", async () => {
  const plane = promoted();
  const { apiKey: _apiKey, ...keyless } = options(plane);
  for (const opts of [keyless, options(plane, { sync: { mode: "offline" } })]) {
    const ap = await AirPrompterAgent.start(opts);
    assert.equal(ap.status().generation, 0);
    await ap.stop();
    rmSync(opts.stateDir!, { recursive: true, force: true });
  }
  assert.deepEqual(plane.requests, [], "offline: nothing was fetched");
  // A full root document already names the signing keys: it starts and serves, as before.
  const ap = await AirPrompterAgent.start(options(plane, { root: plane.root }));
  assert.equal(await served(ap), "ver_reply_1");
  assert.deepEqual(rootUrls(plane.requests), []);
});

test("a hosted prod pin with no rootUrl reads prod's root.json and serves the release", async () => {
  const plane = promoted();
  const events: Array<Record<string, unknown>> = [];
  const version = await asHosted("prod", publicJwkOf(plane.rootKey), async () => served(await AirPrompterAgent.start(options(plane, {}, events))));
  assert.equal(version, "ver_reply_1");
  assert.deepEqual(rootUrls(plane.requests), [PROD_URL]);
  assert.ok(events.some((e) => e.event === "root_url_default" && e.environment === "prod"));
});

test("a hosted dev pin with hostedEnvironment dev reads dev's root.json and serves the release", async () => {
  const plane = promoted({ ...scope, target: "staging" }, "dev");
  const version = await asHosted("dev", publicJwkOf(plane.rootKey), async () => served(await AirPrompterAgent.start(options(plane, { root: { pinned: publicJwkOf(plane.rootKey), hostedEnvironment: "dev" } }))));
  assert.equal(version, "ver_reply_1");
  assert.deepEqual(rootUrls(plane.requests), [DEV_URL]);
});

test("a dev pin left on the prod default, or a prod pin named dev, fails fast instead of reading the other environment", async () => {
  const plane = promoted();
  const key = publicJwkOf(plane.rootKey);
  await asHosted("dev", key, async () => {
    await assert.rejects(AirPrompterAgent.start(options(plane)), (error: unknown) => error instanceof AgentStartError && error.code === "invalid_options" && error.message.includes('Add hostedEnvironment: "dev" to root'));
  });
  await asHosted("prod", key, async () => {
    await assert.rejects(AirPrompterAgent.start(options(plane, { root: { pinned: key, hostedEnvironment: "dev" } })), (error: unknown) => error instanceof AgentStartError && error.message.includes('Add hostedEnvironment: "prod" to root'));
  });
  assert.deepEqual(plane.requests, []);
});

test("an explicit rootUrl wins over the hosted default", async () => {
  const plane = promoted();
  const events: Array<Record<string, unknown>> = [];
  const version = await asHosted("prod", publicJwkOf(plane.rootKey), async () => served(await AirPrompterAgent.start(options(plane, { sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://mirror.test/roots/prod/root.json" } }, events))));
  assert.equal(version, "ver_reply_1");
  assert.deepEqual(rootUrls(plane.requests), ["https://mirror.test/roots/prod/root.json"]);
  assert.ok(!events.some((e) => e.event === "root_url_default"));
});

/** The default URL answered by someone else: `serve` decides what comes back for root.json; everything else is the plane. */
function hijacked(plane: FakeControlPlane, serve: () => RootMetadata): FetchLike {
  const base = plane.fetch();
  return async (url, init) => {
    if (url === PROD_URL) {
      plane.requests.push(url);
      const body = JSON.stringify(serve());
      return { status: 200, headers: { get: () => null }, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer };
    }
    return base(url, init);
  };
}

test("what the default URL serves is trusted only if it verifies against the pin: another root, another environment, a rollback", async () => {
  const plane = promoted();
  const key = publicJwkOf(plane.rootKey);
  // A stranger's root naming its own signing key, and a manifest signed by that key: neither is trusted.
  const stranger = new FakeControlPlane(scope);
  stranger.promote([stranger.slot({ tag: "support.reply", text: "Say what I say.", versionId: "ver_forged" })]);
  const events: Array<Record<string, unknown>> = [];
  const forged = await asHosted("prod", key, async () => served(await AirPrompterAgent.start(options(stranger, { root: { pinned: key }, fetch: hijacked(stranger, () => stranger.root) }, events))));
  assert.equal(forged, null, "nothing served");
  assert.ok(events.some((e) => e.reason === "root_signature_invalid"), JSON.stringify(events.map((e) => [e.event, e.reason])));
  assert.ok(events.some((e) => e.reason === "unknown_signing_key"));

  // The pinned root's own key, signing a document for the dev deployment, served at prod's URL: wrong scope.
  const devScoped = rootDocument({ rootKey: plane.rootKey, signingKeys: [plane.signingKey], environment: "dev" });
  const scoped: Array<Record<string, unknown>> = [];
  const wrongEnvironment = await asHosted("prod", key, async () => served(await AirPrompterAgent.start(options(plane, { fetch: hijacked(plane, () => devScoped) }, scoped))));
  assert.equal(wrongEnvironment, null);
  assert.ok(scoped.some((e) => e.reason === "root_scope_mismatch"));

  // A rollback: once version 2 is accepted, version 1 from the same URL is refused and version 2 stays trusted.
  const v2 = rootDocument({ rootKey: plane.rootKey, signingKeys: [plane.signingKey], environment: "prod", version: 2 });
  const v1 = rootDocument({ rootKey: plane.rootKey, signingKeys: [new FakeControlPlane(scope).signingKey], environment: "prod", version: 1 });
  let serving = v2;
  const rolled: Array<Record<string, unknown>> = [];
  await asHosted("prod", key, async () => {
    const ap = await AirPrompterAgent.start(options(plane, { fetch: hijacked(plane, () => serving) }, rolled));
    try {
      assert.equal(ap.prompt("support.reply").render({}).versionId, "ver_reply_1");
      serving = v1;
      await ap.syncNow();
      assert.ok(rolled.some((e) => e.reason === "root_rollback"), JSON.stringify(rolled.map((e) => [e.event, e.reason])));
      assert.equal(ap.prompt("support.reply").render({}).versionId, "ver_reply_1", "still serving under version 2");
    } finally {
      await ap.stop();
    }
  });
});
