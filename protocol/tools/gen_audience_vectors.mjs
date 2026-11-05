/** Deterministic review-owned audience vectors. Every expected answer is written here by hand, never computed by an
 * implementation under test; manifests are signed with the published test keys.
 *
 * Usage:
 *   $ node protocol/tools/gen_audience_vectors.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson, releaseDigest, sha256Prefixed } from "../../conformance/reference.mjs";
import { jwkThumbprint, publicJwkOf, signBytes } from "../../conformance/trust.mjs";

const PROTOCOL = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
// This published test key is deliberately public test material, reused from
// the trust-vector generator so refusal cases can carry a valid signature.
const signer = { kty: "EC", crv: "P-256", x: "2MDfMOVEz8pM_m7u_O9zMlr4T2GHN_tlpj9pfVMGdyo", y: "ym9DiH-4GitdO8-tBC3sZePPU-bEV9Hc0kYOen_IYho", d: "suiXAnwPf-Gk1JvX1m2PHRVKuL0iSXfIakwiFef6b5g" };
const rootSigner = { kty: "EC", crv: "P-256", x: "kHE8TI-jnQoL1Gb2fyooDgcvVUJGUQQwPXzfX1MGiK4", y: "-7-BQROtrrTIaS5tnbfiS72az-XDBzbph57mB8MT1jU", d: "hUxny0ocprVEGy2YVbwSFp3-SDNGSaZ2CEtyPISSNx8" };
const signerId = jwkThumbprint(signer);
const rootSignerId = jwkThumbprint(rootSigner);

const when = (condition) => ({ mode: "when", when: condition });
const is = (key, value) => ({ key, is: value });
const contains = (key, value) => ({ key, contains: value });
const oneOf = (key, ...values) => ({ key, in: values });
const range = (key, bounds) => ({ key, range: bounds });
const all = (...items) => ({ all: items });
const any = (...items) => ({ any: items });
const not = (item) => ({ not: item });
const smile = "😀";
const pad = (count, unit = smile) => unit.repeat(count);
const leaves = (count) => Array.from({ length: count }, (_, i) => is(`k${i}`, "v"));
const c = (name, selector, tags, valid, matches) => ({ name, selector, tags, valid, matches });

const cases = [
  // The two modes.
  c("all devices without tags", { mode: "all" }, {}, true, true),
  c("unknown all fields refused", { mode: "all", when: is("a", "b") }, {}, false, false),
  c("unknown mode refused", { mode: "tags", conditions: [] }, {}, false, false),
  c("when without a condition refused", { mode: "when" }, {}, false, false),
  // An operator this reader lacks: nothing in the tree matches, whatever sits around it.
  c("an unknown operator alone", when({ key: "a", later: "b" }), { a: "b" }, false, false),
  c("an unknown operator under not matches nothing", when(not({ key: "a", later: "b" })), { a: "b" }, false, false),
  c("an unknown operator under any matches nothing", when(any(is("a", "b"), { key: "c", later: "d" })), { a: "b" }, false, false),
  // is.
  c("one device exact", when(is("device_id", "device-042")), { device_id: "device-042" }, true, true),
  c("different device", when(is("device_id", "device-042")), { device_id: "device-043" }, true, false),
  c("missing is not empty", when(is("device_id", "")), {}, true, false),
  c("empty is exact", when(is("device_id", "")), { device_id: "" }, true, true),
  c("case sensitive", when(is("region", "West")), { region: "west" }, true, false),
  c("no whitespace normalization", when(is("device_id", " d42 ")), { device_id: "d42" }, true, false),
  c("unicode exact", when(is("機器", "café")), { 機器: "café" }, true, true),
  c("unicode not normalized", when(is("name", "café")), { name: "café" }, true, false),
  c("literal reserved key", when(is("__proto__", "field")), JSON.parse('{"__proto__":"field"}'), true, true),
  c("non string value refused", when(is("id", 42)), {}, false, false),
  // contains.
  c("device prefix contains", when(contains("device_id", "device-")), { device_id: "device-042" }, true, true),
  c("contains remains case sensitive", when(contains("region", "West")), { region: "northwest" }, true, false),
  c("contains missing key", when(contains("device_id", "042")), {}, true, false),
  c("empty contains refused", when(contains("device_id", "")), { device_id: "device-042" }, false, false),
  // in.
  c("in names the value", when(oneOf("region", "eu-west-1", "eu-central-1")), { region: "eu-central-1" }, true, true),
  c("in misses the value", when(oneOf("region", "eu-west-1", "eu-central-1")), { region: "us-east-1" }, true, false),
  c("in on a missing key", when(oneOf("region", "eu-west-1")), {}, true, false),
  c("in is exact, not a substring", when(oneOf("region", "eu")), { region: "eu-west-1" }, true, false),
  c("in with no values refused", when(oneOf("region")), {}, false, false),
  c("in with 64 values", when(oneOf("n", ...Array.from({ length: 64 }, (_, i) => `v${i}`))), { n: "v63" }, true, true),
  c("in with 65 values refused", when(oneOf("n", ...Array.from({ length: 65 }, (_, i) => `v${i}`))), { n: "v0" }, false, false),
  c("in with a repeated value refused", when(oneOf("n", "a", "a")), { n: "a" }, false, false),
  // range.
  c("range inside both bounds", when(range("age", { gte: 18, lt: 65 })), { age: "18" }, true, true),
  c("range upper bound is exclusive", when(range("age", { gte: 18, lt: 65 })), { age: "65" }, true, false),
  c("range below the lower bound", when(range("age", { gte: 18 })), { age: "17.99" }, true, false),
  c("range with only an upper bound, on a fractional tag value", when(range("score", { lt: 1 })), { score: "-3.25" }, true, true),
  c("a fractional bound refused", when(range("score", { lt: 0.5 })), { score: "0.25" }, false, false),
  c("a bound past the safe integers refused", when(range("score", { lt: 9007199254740992 })), { score: "1" }, false, false),
  c("range on a missing key", when(range("age", { gte: 18 })), {}, true, false),
  c("range on a word is false", when(range("age", { gte: 0 })), { age: "old" }, true, false),
  c("range on an empty value is false", when(range("age", { gte: 0 })), { age: "" }, true, false),
  c("range on an exponent is false", when(range("age", { gte: 0 })), { age: "1e3" }, true, false),
  c("range on a leading plus is false", when(range("age", { gte: 0 })), { age: "+5" }, true, false),
  c("range on a space is false", when(range("age", { gte: 0 })), { age: " 5" }, true, false),
  c("range on hexadecimal is false", when(range("age", { gte: 0 })), { age: "0x10" }, true, false),
  c("range on Infinity is false", when(range("age", { gte: 0 })), { age: "Infinity" }, true, false),
  c("range on NaN is false", when(range("age", { gte: 0 })), { age: "NaN" }, true, false),
  c("range on a non-ASCII digit is false", when(range("age", { gte: 0 })), { age: "٣" }, true, false),
  c("range with no bound refused", when(range("age", {})), { age: "1" }, false, false),
  c("range with an unknown bound refused", when(range("age", { gt: 1 })), { age: "2" }, false, false),
  c("range with a string bound refused", when(range("age", { gte: "1" })), { age: "2" }, false, false),
  // all, any, not.
  c("all of multiple tags", when(all(is("region", "west"), is("device_id", "d42"))), { region: "west", device_id: "d42" }, true, true),
  c("all partially matching", when(all(is("region", "west"), is("device_id", "d42"))), { region: "west" }, true, false),
  c("same tag exact contradiction is valid but does not match", when(all(is("region", "west"), is("region", "east"))), { region: "west" }, true, false),
  c("same tag contains both values", when(all(contains("roles", "admin"), contains("roles", "billing"))), { roles: "billing-admin" }, true, true),
  c("any of multiple tags", when(any(is("region", "west"), is("region", "east"))), { region: "east" }, true, true),
  c("any with nothing matching", when(any(is("region", "west"), is("region", "east"))), { region: "north" }, true, false),
  c("any with every key missing", when(any(is("a", "1"), is("b", "2"))), {}, true, false),
  c("not of a match", when(not(is("plan", "free"))), { plan: "free" }, true, false),
  c("not of a miss", when(not(is("plan", "free"))), { plan: "team" }, true, true),
  c("not of a missing key: the leaf is false, so the not is true", when(not(is("plan", "free"))), {}, true, true),
  c("not of a non-numeric range: the leaf is false, so the not is true", when(not(range("age", { gte: 18 }))), { age: "old" }, true, true),
  c("any and not together", when(any(oneOf("region", "eu-west-1"), not(is("plan", "free")))), { region: "us-east-1", plan: "free" }, true, false),
  c("empty all refused", when(all()), {}, false, false),
  c("empty any refused", when(any()), {}, false, false),
  c("all with 16 items", when(all(...leaves(16))), Object.fromEntries(leaves(16).map((l) => [l.key, "v"])), true, true),
  c("all with 17 items refused", when(all(...leaves(17))), {}, false, false),
  c("any with 17 items refused", when(any(...leaves(17))), {}, false, false),
  // Depth and leaves.
  c("depth 4 is the deepest tree", when(all(any(not(is("a", "b"))))), { a: "c" }, true, true),
  c("depth 4 with a false leaf", when(all(any(not(is("a", "b"))))), { a: "b" }, true, false),
  c("depth 5 refused", when(all(any(not(all(is("a", "b")))))), { a: "c" }, false, false),
  c("32 leaves", when(all(all(...leaves(16)), all(...leaves(16)))), Object.fromEntries(leaves(16).map((l) => [l.key, "v"])), true, true),
  c("33 leaves refused", when(all(all(...leaves(16)), all(...leaves(16)), is("k0", "v"))), {}, false, false),
  // Closed shapes.
  c("the older condition list refused", { mode: "tags", conditions: [{ key: "region", operator: "is", value: "west" }] }, { region: "west" }, false, false),
  c("match field refused", { mode: "when", when: is("region", "west"), match: "any" }, { region: "west" }, false, false),
  c("condition missing key refused", when({ is: "west" }), { region: "west" }, false, false),
  c("condition missing value refused", when({ key: "region" }), { region: "west" }, false, false),
  c("unknown operator refused", when({ key: "device_id", starts_with: "device-" }), { device_id: "device-042" }, false, false),
  c("two operators on one leaf refused", when({ key: "a", is: "b", contains: "b" }), { a: "b" }, false, false),
  c("a group with a key refused", when({ key: "a", all: [is("a", "b")] }), { a: "b" }, false, false),
  // Unicode bounds.
  c("unpaired surrogate selector refused", when(is("device_id", "\ud800")), { device_id: "unit-7" }, false, false),
  c("unpaired surrogate local tag refused", when(is("device_id", "unit-7")), { device_id: "\ud800" }, true, false),
  c("astral key at scalar limit", when(is(pad(64), "v")), { [pad(64)]: "v" }, true, true),
  c("astral key over scalar limit refused", when(is(pad(65), "v")), {}, false, false),
  c("astral value at scalar limit", when(is("device.id", pad(256))), { "device.id": pad(256) }, true, true),
  c("astral value over scalar limit refused", when(is("device.id", pad(257))), {}, false, false),
];

const validators = [
  { name: "key retains ECMAScript nonbreaking next line whitespace", kind: "key", value: "\u0085", valid: true },
  { name: "key trims ECMAScript byte order mark whitespace", kind: "key", value: "﻿", valid: false },
  { name: "label retains ECMAScript nonbreaking next line whitespace", kind: "label", value: "\u0085", valid: true },
  { name: "label trims ECMAScript byte order mark whitespace", kind: "label", value: "﻿", valid: false },
  { name: "instant rejects impossible offset", kind: "instant", value: "2026-09-12T14:03:10+99:99", valid: false },
  { name: "instant accepts largest ECMAScript parsed offset", kind: "instant", value: "2026-01-01T00:00:00+23:59", valid: true },
  { name: "instant rejects year zero", kind: "instant", value: "0000-01-01T00:00:00Z", valid: false },
  { name: "instant rejects impossible calendar day", kind: "instant", value: "2026-02-30T12:00:00Z", valid: false },
  { name: "key rejects unpaired surrogate", kind: "key", value: "\ud800", valid: false },
  { name: "label rejects unpaired surrogate", kind: "label", value: "\ud800", valid: false },
];

// ------------------------------------------------------------------------------------------- manifests
const AUDIENCE = "aud_AAAAAAAAAAAAAAAAAAAAAA";
const selector = when(any(oneOf("region", "eu-west-1"), not(is("device_id", "device-042"))));
const slotOf = (versionId, text) => ({ tag: "support.reply", kind: "prompt", artifactId: "art_support.reply", versionId, versionOrdinal: 1, contentHash: sha256Prefixed(Buffer.from(text, "utf8")), byteLength: Buffer.byteLength(text), model: "claude-sonnet-5", variables: [] });
const base = slotOf("ver_base", "base text");
const candidate = slotOf("ver_candidate", "candidate");
const digest = releaseDigest([base]);
const candidateDigest = releaseDigest([candidate]);
const experiment = (audience = { audienceId: AUDIENCE, selector }) => ({ tag: "support.reply", experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "instance", audience, arms: [{ arm: "control", weightBps: 0, releaseDigest: digest, overrides: [] }, { arm: "candidate", weightBps: 10000, releaseDigest: candidateDigest, overrides: [candidate] }] });
const observation = (audienceSelector = selector, overrides = {}) => ({ audienceId: AUDIENCE, selector: audienceSelector, tag: "support.reply", observeFrom: "2026-09-12T14:00:00Z", ...overrides });
const defined = (value) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
const payload = (overrides = {}) => defined({ protocol: PROTOCOL, organizationId: "org_1", agentId: "agt_1", target: "prod", generation: 1, releaseDigest: digest, issuedAt: "2026-10-05T02:23:52.295Z", leaseSeconds: 3600, applyPolicy: "auto", requireCountersign: false, slots: [base], directives: [], experiments: [experiment()], observations: [observation()], ...overrides });
const signedRoot = { type: "root", protocol: PROTOCOL, purpose: "platform", environment: "prod", version: 1, expires: "2027-12-11T00:00:00Z", keys: { [rootSignerId]: { keyType: "ecdsa-p256", scheme: "ES256", publicKey: publicJwkOf(rootSigner) }, [signerId]: { keyType: "ecdsa-p256", scheme: "ES256", publicKey: publicJwkOf(signer) } }, roles: { root: { keyIds: [rootSignerId], threshold: 1 }, targets: { keyIds: [signerId], threshold: 1 } } };
const root = { signed: signedRoot, signatures: [{ keyId: rootSignerId, alg: "ES256", sig: signBytes(Buffer.from(canonicalJson(signedRoot), "utf8"), rootSigner) }] };
const sign = (p) => ({ payload: p, signatures: [{ keyId: signerId, alg: "ES256", sig: signBytes(Buffer.from(canonicalJson(p), "utf8"), signer) }] });
const manifestCase = (name, p, expected, schemaOk) => ({ name, manifest: sign(p), root, now: "2026-10-05T03:00:00Z", scope: { organizationId: "org_1", agentId: "agt_1", target: "prod" }, storedGeneration: 0, expected, ...(schemaOk === undefined ? {} : { schemaOk }) });
const refused = { ok: false, reason: "protocol_unsupported" };
const accepted = { ok: true };
const withSelector = (audienceSelector) => ({ experiments: [experiment({ audienceId: AUDIENCE, selector: audienceSelector })], observations: [observation(audienceSelector)] });

const manifests = [
  manifestCase("signed protocol 3 audience accepted", payload(), accepted, true),
  manifestCase("a later minor is accepted", payload({ protocol: "3.7.0" }), accepted, true),
  manifestCase("a manifest with no observations accepted", payload({ experiments: undefined, observations: undefined }), accepted, true),
  manifestCase("an experiment with no audience accepted", payload({ experiments: [defined({ ...experiment(), audience: undefined })], observations: undefined }), accepted, true),
  manifestCase("unknown capability refused", payload({ requiredCapabilities: ["future_feature"] }), refused, true),
  manifestCase("the retired audience capability refused", payload({ requiredCapabilities: ["audience"] }), refused, true),
  manifestCase("unknown observation id refused", payload({ observations: [observation(selector, { audienceId: "aud_BBBBBBBBBBBBBBBBBBBBBB" })] }), refused),
  manifestCase("an experiment audience its observation does not name refused", payload({ observations: undefined }), refused),
  manifestCase("impossible calendar observation refused", payload({ observations: [observation(selector, { observeFrom: "2026-02-30T12:00:00Z" })] }), refused),
  (() => {
    const entry = manifestCase("selector tampering fails signature", payload(), { ok: false, reason: "signature_invalid" });
    const tampered = when(not(is("device_id", "device-042")));
    entry.manifest.payload = { ...entry.manifest.payload, ...withSelector(tampered) };
    return entry;
  })(),
  ...["0x3.0.0", "+3.0.0", ".0.0", "03.0.0"].map((protocol) => manifestCase(`malformed protocol ${protocol} refused`, payload({ protocol }), refused, false)),
  ...["0.9.0", "1.0.0", "2.0.0", "4.0.0"].map((protocol) => manifestCase(`protocol major ${protocol[0]} refused`, payload({ protocol }), refused, false)),
  manifestCase("an unknown selector mode loads and matches nothing", payload(withSelector({ mode: "tags", conditions: [{ key: "region", operator: "is", value: "west" }] })), accepted, false),
  manifestCase("a non-object condition loads and matches nothing", payload(withSelector({ mode: "when", when: "region" })), accepted, false),
  manifestCase("an unknown selector member loads and matches nothing", payload(withSelector({ ...selector, match: "any" })), accepted, false),
  manifestCase("a leaf with an operator this reader lacks loads and matches nothing", payload(withSelector(when({ key: "region", later: "west" }))), accepted, false),
  manifestCase("an unknown operator under not loads and matches nothing", payload(withSelector(when(not({ key: "region", later: "west" })))), accepted, false),
  manifestCase("an unknown operator under any loads and matches nothing", payload(withSelector(when(any(is("region", "west"), { key: "region", later: "west" })))), accepted, false),
  { ...manifestCase("an unknown operator beside a disable: the manifest loads and the disable stands", payload({ ...withSelector(when({ key: "region", later: "west" })), directives: [{ kind: "disable", scope: "slot", tag: "support.reply", issuedAt: "2026-10-05T02:00:00Z" }] }), accepted, false), disabledSlots: ["support.reply"] },
  manifestCase("a later member on an observation or an experiment audience is ignored", payload({ experiments: [experiment({ audienceId: AUDIENCE, selector, laterMember: 1 })], observations: [observation(selector, { laterMember: 1 })] }), accepted, false),
  manifestCase("an experiment selector that differs from its observation refused, read or not", payload({ experiments: [experiment({ audienceId: AUDIENCE, selector: when({ key: "region", later: "west" }) })], observations: [observation(when({ key: "region", later: "east" }))] }), refused, false),
  manifestCase("a tree past depth 4 loads and matches nothing", payload(withSelector(when(all(any(not(all(is("a", "b")))))))), accepted, false),
  manifestCase("a tree past 32 leaves loads and matches nothing (the schema cannot count them)", payload(withSelector(when(all(all(...leaves(16)), all(...leaves(16)), is("k0", "v"))))), accepted, true),
];

const vectors = { $comment: "Generated by protocol/tools/gen_audience_vectors.mjs. Expected answers are written there by hand. See audiences.md.", protocol: PROTOCOL, cases, validators, manifests };
if (cases.length < 40) throw new Error("audience_vector_contract: at least 40 cases");
writeFileSync(new URL("../vectors/audiences.json", import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`${cases.length} cases, ${validators.length} validators, ${manifests.length} manifests`);
