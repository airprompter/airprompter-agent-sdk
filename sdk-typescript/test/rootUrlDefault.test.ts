/**
 * Where an agent reads its root document when `sync.rootUrl` is not set. A pinned AirPrompter root (`HOSTED_ROOTS`)
 * reads its own environment's `root.json`; any other pinned root refuses to start a syncing runtime, saying what to
 * add, unless a vendored bundle or the datastore carries the keys; a runtime that never syncs needs none; an explicit
 * `rootUrl` wins. The default moves where the document is fetched from, never what is trusted: a document that does
 * not verify against the pin is refused exactly as before, and one that is not a root document at all does not stop
 * the pass.
 *
 * The fake cannot sign as AirPrompter, so a test that needs a hosted root has the fake's key recognised as one for its
 * duration (`withHostedRootsForTests`). The real table is checked on its own, against the ceremonies' documents.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentStartError, AirPrompterAgent, type StartOptions } from "../packages/sdk/src/agent.js";
import { HOSTED_ROOTS, createPlaintextBundle, hostedEnvironmentOfRoot, keyThumbprint, publicJwkOf, trustedRootFromPinnedKey, verifyRootMetadata } from "../packages/sdk/src/core/index.js";
import type { FetchLike, HostedEnvironment, P256PublicJwk, RootMetadata } from "../packages/sdk/src/core/index.js";
import { withHostedRootsForTests } from "../packages/sdk/src/core/protocol/hostedRoots.js";
import { HOSTED_ROOTS as STEPS_HOSTED_ROOTS } from "../packages/sdk/src/frameworks/steps/index.js";
import { FakeControlPlane, rootDocument } from "./helpers/controlPlane.js";

const scope: { organizationId: string; agentId: string; target: string } = { organizationId: "org_1", agentId: "agt_1", target: "prod" };
const PROD_URL = "https://api.airprompter.com/roots/prod/root.json";
const DEV_URL = "https://api.airprompter.dev/roots/dev/root.json";
const REAL = { dev: HOSTED_ROOTS.dev!, prod: HOSTED_ROOTS.prod! };

const asHosted = <T>(environment: HostedEnvironment, key: P256PublicJwk, run: () => Promise<T>) => withHostedRootsForTests({ ...HOSTED_ROOTS, [environment]: key }, run);

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

async function refusal(opts: StartOptions): Promise<string> {
  try {
    const ap = await AirPrompterAgent.start(opts);
    await ap.stop();
  } catch (error) {
    assert.ok(error instanceof AgentStartError);
    assert.equal(error.code, "invalid_options");
    return error.message;
  } finally {
    rmSync(opts.stateDir!, { recursive: true, force: true });
  }
  throw new Error("start did not refuse");
}

test("the hosted table: prod and dev, frozen, the ceremonies' keys, one table shared with the Steps client", () => {
  assert.deepEqual(Object.keys(HOSTED_ROOTS).sort(), ["dev", "prod"]);
  assert.ok(Object.isFrozen(HOSTED_ROOTS) && Object.isFrozen(HOSTED_ROOTS.prod) && Object.isFrozen(HOSTED_ROOTS.dev));
  assert.throws(() => {
    (HOSTED_ROOTS as Record<string, P256PublicJwk>).prod = publicJwkOf(new FakeControlPlane(scope).rootKey);
  }, TypeError);
  assert.equal(STEPS_HOSTED_ROOTS, HOSTED_ROOTS, "the Steps client reads the same table");
  assert.equal(keyThumbprint(REAL.prod), "044af6e83353a2ea3758cc3feb3b1b7031c82bda5d6cd9287ba7730363e11793");
  assert.equal(keyThumbprint(REAL.dev), "86267aa3dc49005a0c1474d5c9c06bd7e1d0e835da715a864c1eca706545df91");
  assert.equal(hostedEnvironmentOfRoot(REAL.prod), "prod");
  assert.equal(hostedEnvironmentOfRoot(REAL.dev), "dev");
  assert.equal(hostedEnvironmentOfRoot(publicJwkOf(new FakeControlPlane(scope).rootKey)), null);
  assert.equal(hostedEnvironmentOfRoot({ kty: "EC", crv: "P-256", x: "not", y: "a key" }), null);
  // The real documents each ceremony signed verify under the key their URL is chosen for, and not under the other.
  const doc = (name: string) => JSON.parse(readFileSync(new URL(`./frameworks/steps/fixtures/hosted-${name}-root.json`, import.meta.url), "utf8")) as RootMetadata;
  const under = (key: P256PublicJwk, environment: HostedEnvironment) => trustedRootFromPinnedKey({ purpose: "platform", environment, pinnedRoot: key });
  assert.deepEqual(verifyRootMetadata({ candidate: doc("prod"), trusted: under(REAL.prod, "prod"), now: "2026-11-28T00:00:00.000Z" }), { ok: true });
  assert.deepEqual(verifyRootMetadata({ candidate: doc("dev"), trusted: under(REAL.dev, "dev"), now: "2026-11-16T00:00:00.000Z" }), { ok: true });
  assert.equal(verifyRootMetadata({ candidate: doc("dev"), trusted: under(REAL.prod, "prod"), now: "2026-11-16T00:00:00.000Z" }).ok, false);
  assert.equal(verifyRootMetadata({ candidate: doc("prod"), trusted: under(REAL.dev, "dev"), now: "2026-11-28T00:00:00.000Z" }).ok, false);
});

test("a custom pinned root with no rootUrl fails fast at start, before the store opens, saying exactly what to add", async () => {
  const plane = promoted();
  const opts = options(plane);
  const stateDir = opts.stateDir!;
  await assert.rejects(AirPrompterAgent.start(opts), (error: unknown) => {
    assert.ok(error instanceof AgentStartError);
    assert.equal(error.code, "invalid_options");
    assert.equal(error.message, 'root.pinned is not one of AirPrompter\'s hosted roots, so the SDK cannot know where its root document is, and without it this runtime cannot learn the keys that sign your releases. Add sync: { rootUrl: "https://<your service>/roots/prod/root.json" }, the root document of the service that signs them.');
    return true;
  });
  assert.deepEqual(readdirSync(stateDir), [], "nothing was opened or written");
  assert.deepEqual(plane.requests, [], "nothing was fetched");
  rmSync(stateDir, { recursive: true, force: true });
  // The environment named is the one in the path; a baseUrl is named back as the likely answer.
  assert.match(await refusal(options(plane, { root: { pinned: publicJwkOf(plane.rootKey), hostedEnvironment: "staging" } })), /Add sync: \{ rootUrl: "https:\/\/<your service>\/roots\/staging\/root\.json" \}/);
  assert.match(await refusal(options(plane, { baseUrl: "http://127.0.0.1:4180/" })), /For the service at http:\/\/127\.0\.0\.1:4180\/ that is usually http:\/\/127\.0\.0\.1:4180\/roots\/prod\/root\.json\.$/);
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

test("a custom pin with a vendored bundle still starts and serves, and says that a key rotation will be refused", async () => {
  const plane = promoted();
  const now = new Date().toISOString();
  const bundle = createPlaintextBundle({ createdAt: now, notAfter: "2027-12-01T00:00:00.000Z", manifest: plane.manifest!, keySet: plane.root, payloads: [...plane.payloads].map(([contentHash, bytes]) => ({ contentHash: contentHash as `sha256:${string}`, byteLength: bytes.length, bytes: bytes.toString("base64url") })) });
  const events: Array<Record<string, unknown>> = [];
  assert.equal(await served(await AirPrompterAgent.start(options(plane, { vendoredBundle: { bundle } }, events))), "ver_reply_1");
  const missing = events.find((e) => e.event === "root_url_missing");
  assert.ok(missing, JSON.stringify(events.map((e) => e.event)));
  assert.match(String(missing.hint), /Add sync: \{ rootUrl: .* a release signed after a key rotation is refused\.$/);
});

test("a hosted prod pin with no rootUrl reads prod's root.json and serves the release", async () => {
  const plane = promoted();
  const events: Array<Record<string, unknown>> = [];
  const version = await asHosted("prod", publicJwkOf(plane.rootKey), async () => served(await AirPrompterAgent.start(options(plane, {}, events))));
  assert.equal(version, "ver_reply_1");
  assert.deepEqual(rootUrls(plane.requests), [PROD_URL]);
  assert.ok(events.some((e) => e.event === "root_url_default" && e.environment === "prod" && e.rootUrl === PROD_URL));
});

test("a hosted dev pin with hostedEnvironment dev reads dev's root.json and serves the release", async () => {
  const plane = promoted({ ...scope, target: "staging" }, "dev");
  const version = await asHosted("dev", publicJwkOf(plane.rootKey), async () => served(await AirPrompterAgent.start(options(plane, { root: { pinned: publicJwkOf(plane.rootKey), hostedEnvironment: "dev" } }))));
  assert.equal(version, "ver_reply_1");
  assert.deepEqual(rootUrls(plane.requests), [DEV_URL]);
});

test("a dev pin left on the prod default, or a prod pin named dev, fails fast instead of reading the other environment", async () => {
  const plane = promoted();
  assert.equal(await refusal(options(plane, { root: { pinned: REAL.dev } })), 'root.pinned is AirPrompter\'s dev root, but root.hostedEnvironment is "prod" (the default). Add hostedEnvironment: "dev" to root, or pin the prod root.');
  assert.equal(await refusal(options(plane, { root: { pinned: REAL.prod, hostedEnvironment: "dev" } })), 'root.pinned is AirPrompter\'s prod root, but root.hostedEnvironment is "dev". Add hostedEnvironment: "prod" to root, or pin the dev root.');
  assert.match(await refusal(options(plane, { root: { pinned: REAL.prod, hostedEnvironment: "staging" } })), /AirPrompter's prod root, but root\.hostedEnvironment is "staging"/);
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

/** The default URL answered by someone else: `serve` decides what comes back for it; everything else is the plane. */
function hijacked(plane: FakeControlPlane, serve: () => unknown, seen: Array<Record<string, string>> = []): FetchLike {
  const base = plane.fetch();
  return async (url, init) => {
    if (url === PROD_URL) {
      plane.requests.push(url);
      seen.push({ ...(init?.headers as Record<string, string>) });
      const reply = serve();
      if (reply === 304) return { status: 304, headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
      const body = typeof reply === "string" ? reply : JSON.stringify(reply);
      return { status: 200, headers: { get: (name: string) => (name.toLowerCase() === "etag" ? '"root-1"' : null) }, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer };
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

test("a root URL that answers something other than a root document is refused, and the pass still takes a new release", async () => {
  const plane = promoted();
  let serving: unknown = plane.root;
  const events: Array<Record<string, unknown>> = [];
  await asHosted("prod", publicJwkOf(plane.rootKey), async () => {
    const ap = await AirPrompterAgent.start(options(plane, { fetch: hijacked(plane, () => serving) }, events));
    try {
      assert.equal(ap.prompt("support.reply").render({}).versionId, "ver_reply_1");
      for (const [i, junk] of [{ hello: 1 }, [1], "null", "\"text\"", { signed: {} }].entries()) {
        serving = junk;
        plane.promote([plane.slot({ tag: "support.reply", text: `Reply ${i}.`, versionId: `ver_reply_${i + 2}` })]);
        await ap.syncNow();
        assert.equal(ap.prompt("support.reply").render({}).versionId, `ver_reply_${i + 2}`, `the pass went on to the manifest after ${JSON.stringify(junk)}`);
      }
      assert.ok(events.some((e) => e.event === "sync_refused" && e.reason === "root_signature_invalid"));
    } finally {
      await ap.stop();
    }
  });
});

test("the root document is read conditionally: the ETag goes back, and a 304 keeps the trusted root", async () => {
  const plane = promoted();
  const seen: Array<Record<string, string>> = [];
  let answer: unknown = plane.root;
  await asHosted("prod", publicJwkOf(plane.rootKey), async () => {
    const ap = await AirPrompterAgent.start(options(plane, { fetch: hijacked(plane, () => answer, seen) }));
    try {
      answer = 304;
      await ap.syncNow();
      assert.equal(seen[0]!["if-none-match"], undefined, "the first read is unconditional");
      assert.equal(seen.at(-1)!["if-none-match"], '"root-1"');
      assert.equal(ap.prompt("support.reply").render({}).versionId, "ver_reply_1");
    } finally {
      await ap.stop();
    }
  });
});
