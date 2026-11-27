/**
 * The 1.0 promise, name by name (`docs/stability.md`). Every specifier inside the promise is pinned here: the values
 * its built module exports, in ESM and in CommonJS, and the type names its entry declares. A name a layer's barrel
 * exports for another layer is not public; a name added here is, on purpose and in a minor release; a name removed
 * from here is a major release.
 *
 * `@airprompter/agent-sdk/frameworks/contract` and `/frameworks/steps` resolve but sit outside the promise (OUTSIDE):
 * they may change in any release.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const root = process.cwd();
const sdk = join(root, "packages", "sdk");
type Entry = { import: { types: string; default: string }; require: { types: string; default: string } };
const PACKAGES = ["sdk", "agent-otel", "datastore-s3", "datastore-postgres", "datastore-redis"];
const manifests = Object.fromEntries(PACKAGES.map((dir) => [dir, JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")) as { name: string; exports: Record<string, Entry> }]));

/** Every specifier the published packages answer to, with the package directory and the exports-map entry behind it. */
const SPECIFIERS = new Map(
  PACKAGES.flatMap((dir) => Object.entries(manifests[dir]!.exports).map(([subpath, entry]) => [subpath === "." ? manifests[dir]!.name : `${manifests[dir]!.name}/${subpath.slice(2)}`, { dir: join(root, "packages", dir), entry }] as const)),
);

/** Specifiers that resolve but promise nothing: the adapter contract (AIR-2231) and the Steps core (AIR-2405, until AIR-2233). */
const OUTSIDE = ["@airprompter/agent-sdk/frameworks/contract", "@airprompter/agent-sdk/frameworks/steps"];

/** One name per line, sorted, so a diff names exactly what moved. */
const PROMISE: Record<string, { values: string[]; types: string[] }> = {
  "@airprompter/agent-sdk": {
    values: [
      "AgentStartError",
      "AirPrompterAgent",
      "PROTOCOL_VERSION",
      "RenderRefusedError",
      "SDK_NAME",
      "SDK_VERSION",
      "VENDORED_BUNDLE_EXPIRY_WARNING_DAYS",
      "healthzOf",
      "healthzResponse",
      "isAgentStartError",
    ],
    types: [
      "AgentRampStatus",
      "AgentRuntime",
      "AgentStatus",
      "BundleOutcome",
      "DatastoreStatus",
      "FlushOutcome",
      "Healthz",
      "HeartbeatReporterName",
      "HeartbeatSdkName",
      "HydrateOutcome",
      "ModelCallRecord",
      "ModelResolver",
      "Placement",
      "ReleaseChange",
      "ReleaseSource",
      "Rendered",
      "RunInput",
      "RunRefEntry",
      "RunReport",
      "RunSession",
      "SpoolDirSource",
      "SpoolReport",
      "StartOptions",
      "SyncMode",
      "TelemetryPlacement",
      "TokenUsage",
      "ToolCallRecord",
      "UnavailableReason",
    ],
  },
  "@airprompter/agent-sdk/core": {
    values: [
      "ASSIGNMENT_MODULUS",
      "AssignmentError",
      "BundleError",
      "BundleRelease",
      "CanonicalJsonError",
      "ERROR_CLASSES",
      "GOLDEN_SET_FORMAT",
      "GOLDEN_SET_VERSION",
      "GoldenSetError",
      "LATENCY_BUCKET_EDGES_MS",
      "MissingVariableError",
      "PROTOCOL_VERSION",
      "SDK_VERSION",
      "STEP_BOUNDS",
      "SUPPORTED_CAPABILITIES",
      "SyncClient",
      "USAGE_SOURCES",
      "UnknownVariableError",
      "armForBucket",
      "assignArm",
      "bucketFromHash",
      "canonicalBytes",
      "canonicalJson",
      "createEncryptedBundle",
      "createPlaintextBundle",
      "distributionKeyId",
      "effectiveArms",
      "epochMinute",
      "errorNamed",
      "evaluateChecks",
      "generateX25519KeyPair",
      "goldenReportsMeet",
      "isAssignmentError",
      "keyThumbprint",
      "latencyBucketIndex",
      "minuteOf",
      "nodeFs",
      "normalizeFeedback",
      "openBundle",
      "parseGoldenSet",
      "placeholdersOf",
      "publicJwkOf",
      "rampWeightsAt",
      "releaseDigest",
      "renderTemplate",
      "runGoldenSet",
      "sha256Prefixed",
      "subjectHash",
      "systemClock",
      "trustedRootFromPinnedKey",
      "validateArms",
      "validateRamp",
      "verifyManifest",
      "verifyRootMetadata",
      "x25519PrivateKeyFromRaw",
      "x25519PublicKeyFromRaw",
      "xmlDelimiters",
    ],
    types: [
      "ApplyPolicy",
      "AssignmentRefusal",
      "AudienceCondition",
      "AudienceObservation",
      "AudienceSelector",
      "AudienceSnapshot",
      "Bundle",
      "BundleContents",
      "BundleReleaseInput",
      "BundleReleaseRefusal",
      "CanonicalJsonRefusal",
      "CheckOutcome",
      "CheckResult",
      "ClockPort",
      "ControlPlaneRefusal",
      "Countersignature",
      "DeclaredCheck",
      "Delimiters",
      "Directive",
      "DistributionKey",
      "DroppedRow",
      "EdgePointer",
      "ErrorClass",
      "Experiment",
      "ExperimentArm",
      "FeedbackRejection",
      "FetchLike",
      "FetchPort",
      "FsFailure",
      "FsOpenFlags",
      "FsPort",
      "GoldenCase",
      "GoldenCaseResult",
      "GoldenInvocation",
      "GoldenInvoke",
      "GoldenReport",
      "GoldenSet",
      "GoldenSetRef",
      "HostedEnvironment",
      "JudgeResult",
      "JudgeRubric",
      "LoadedRelease",
      "Manifest",
      "ManifestFetch",
      "ManifestPayload",
      "ManifestSlot",
      "NormalizedFeedback",
      "Observation",
      "OutputCheck",
      "P256PrivateJwk",
      "P256PublicJwk",
      "RampStep",
      "RefusalCode",
      "RefusalRow",
      "ReleaseReader",
      "ReleaseSlot",
      "RenderInput",
      "RootKeyEntry",
      "RootMetadata",
      "RootMetadataSigned",
      "RootRole",
      "RunDimensions",
      "RunRefEntry",
      "RunTotals",
      "Sha256",
      "Signature",
      "SlotInference",
      "SlotStep",
      "SlotVariable",
      "SpoolRow",
      "StepRow",
      "StepTotals",
      "SyncClientOptions",
      "Target",
      "TokenMoments",
      "TokenTotals",
      "UploadOutcome",
      "UploadSegment",
      "UploadSink",
      "UsageSource",
      "Verdict",
      "VerifyManifestInput",
      "WindowRow",
    ],
  },
  "@airprompter/agent-sdk/sync": {
    values: [
      "MemoryKvStore",
      "MemoryReleaseDatastore",
      "PayloadDecryptError",
      "SlotStore",
      "StoreError",
      "checkKvStore",
      "clearDatastoreRollback",
      "customKeyProvider",
      "fileKey",
      "fsKvStore",
      "isKnownTimeZone",
      "isPayloadDecryptError",
      "isStoreError",
      "kvReleaseDatastore",
      "nextPullDelayMs",
      "parseWindow",
      "pruneDatastore",
      "pullBundle",
      "pullToDatastore",
      "rollbackDatastore",
      "syncOnce",
      "validateWindow",
      "windowState",
    ],
    types: [
      "ApplyPolicyDecision",
      "ApplyPolicyPin",
      "DatastoreRollbackResult",
      "KeyProvider",
      "KvEntry",
      "KvPutCondition",
      "KvReleaseDatastore",
      "KvStore",
      "KvStoreReport",
      "LoadedSlot",
      "OpenStoreInput",
      "PullBundleInput",
      "PullBundleResult",
      "PullEdgeState",
      "PullToDatastoreInput",
      "PullToDatastoreResult",
      "ReleaseControl",
      "ReleaseDatastore",
      "ReleaseKey",
      "ReleaseRollout",
      "RolloutExperiment",
      "SlotName",
      "StorageProtection",
      "StoreErrorCode",
      "StoreHooks",
      "StoredReleaseRow",
      "SyncPassInput",
      "SyncPassOutput",
      "SyncPassResult",
      "UpdateWindow",
      "WindowDay",
      "WindowState",
    ],
  },
  "@airprompter/agent-sdk/runtime": {
    values: [
      "ReleaseResolver",
      "VariableSourceError",
      "VariableSourceRequiredError",
      "applyInference",
      "currentAttribution",
      "isVariableSourceError",
      "isVariableSourceRequiredError",
      "newSubject",
      "normalizeUsage",
      "observeCall",
      "withAttribution",
    ],
    types: [
      "AgentRuntime",
      "AppliedInference",
      "Attribution",
      "Disabled",
      "InferenceUnsupportedReason",
      "ModelCallRecord",
      "ModelResolver",
      "ObserveOptions",
      "ObserveTarget",
      "Placement",
      "RegisteredSource",
      "RenderValues",
      "Rendered",
      "RequestKind",
      "ResolveOutcome",
      "ResolverInput",
      "RunInput",
      "RunSession",
      "TokenUsage",
      "ToolCallRecord",
      "UnavailableReason",
      "UsageNormalized",
      "VariableSource",
      "VariableSourceContext",
      "VariableSourceInput",
      "VariableSourceRegistry",
    ],
  },
  "@airprompter/agent-sdk/telemetry": {
    values: [
      "DirectorySink",
      "HOST_SPOOL_BUDGET_BYTES",
      "MemorySink",
      "SEGMENT_MAX_BYTES",
      "SERVERLESS_BUFFER_BYTES",
      "SpoolUploader",
      "SpoolWriter",
      "airprompterUploadSink",
      "inspectSegment",
    ],
    types: [
      "DirectorySinkOptions",
      "GrantDecision",
      "OutcomeDimensions",
      "PassResult",
      "SegmentInspection",
      "SinkFaults",
      "SpoolSink",
      "UploadGrant",
      "UploaderOptions",
      "UploaderStatus",
    ],
  },
  "@airprompter/agent-sdk/testing": {
    values: [
      "FakeClock",
      "FakeControlPlane",
      "MemoryFs",
      "serveOverHttp",
    ],
    types: [
      "SlotSpec",
    ],
  },
  "@airprompter/agent-sdk/frameworks/openai": {
    values: [
      "applyPlacement",
      "instrument",
    ],
    types: [
      "InstrumentOptions",
    ],
  },
  "@airprompter/agent-sdk/frameworks/anthropic": {
    values: [
      "applyPlacement",
      "instrument",
    ],
    types: [
      "InstrumentOptions",
    ],
  },
  "@airprompter/agent-sdk/frameworks/ai-sdk": {
    values: [
      "airprompterMiddleware",
    ],
    types: [
      "AiSdkMiddleware",
      "AiSdkMiddlewareOptions",
      "LanguageModelLike",
    ],
  },
  "@airprompter/agent-sdk/frameworks/langchain": {
    values: [
      "airprompter",
    ],
    types: [
      "AirPrompterMiddlewareOptions",
    ],
  },
  "@airprompter/agent-otel/exporter": {
    values: [
      "OTLP_SCOPE_NAME",
      "httpJsonExporter",
      "otlpAttribute",
      "otlpUploadSink",
      "spoolRowsToOtlp",
    ],
    types: [
      "ExportMetricsServiceRequest",
      "MappingOptions",
      "OtlpAttribute",
      "OtlpExporter",
      "OtlpHistogramPoint",
      "OtlpMetric",
      "OtlpNumberPoint",
      "OtlpSinkOptions",
      "OtlpSinkStatus",
      "OtlpValue",
    ],
  },
  "@airprompter/datastore-s3": {
    values: [
      "s3KvStore",
    ],
    types: [
      "S3KvStoreOptions",
    ],
  },
  "@airprompter/datastore-postgres": {
    values: [
      "postgresKvSchema",
      "postgresKvStore",
    ],
    types: [
      "PostgresKvStore",
      "PostgresKvStoreOptions",
      "PostgresQueryable",
    ],
  },
  "@airprompter/datastore-redis": {
    values: [
      "fromIoRedis",
      "fromNodeRedis",
      "redisKvStore",
    ],
    types: [
      "RedisCommand",
      "RedisKvStoreOptions",
    ],
  },
};

/** The last file the build writes (scripts/build.mjs: the SDK, then each satellite, ESM then CommonJS). */
function ensureBuilt(): void {
  if (!existsSync(join(root, "packages", "datastore-redis", "dist", "cjs", "index.d.ts"))) execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "ignore" });
}

const located = (spec: string) => {
  const found = SPECIFIERS.get(spec);
  assert.ok(found, `${spec} is in an exports map`);
  return found;
};

/** The source a specifier's ESM entry is built from. */
const sourceOf = (spec: string): string => {
  const { dir, entry } = located(spec);
  return join(dir, entry.import.default.replace(/^\.\/dist\/esm\//, "src/").replace(/\.js$/, ".ts"));
};

const sorted = (names: Iterable<string>): string[] => [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Every name an entry declares, read from its AST. A star export is refused: it would make a barrel's next name public. */
function declaredNames(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      assert.ok(statement.exportClause && ts.isNamedExports(statement.exportClause), `${file}: a star export makes every name behind it public; list them`);
      for (const element of statement.exportClause.elements) names.push(element.name.text);
      continue;
    }
    assert.ok(!ts.isExportAssignment(statement), `${file}: a default export is not part of the promise`);
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) names.push((declaration.name as ts.Identifier).text);
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) names.push(statement.name.text);
  }
  return sorted(new Set(names));
}

test("every specifier is inside the promise or named outside it, and docs/stability.md says which", () => {
  assert.deepEqual(sorted(SPECIFIERS.keys()), sorted([...Object.keys(PROMISE), ...OUTSIDE]), "a new subpath is placed on purpose");
  // A Windows checkout may carry CRLF line endings; the headings are matched on LF.
  const page = readFileSync(join(root, "..", "docs", "stability.md"), "utf8").replace(/\r\n/g, "\n");
  const section = (heading: string): string => {
    const start = page.indexOf(`\n## ${heading}\n`);
    assert.ok(start >= 0, `docs/stability.md has a "## ${heading}" section`);
    const end = page.indexOf("\n## ", start + 1);
    return page.slice(start, end === -1 ? undefined : end);
  };
  const inside = section("What 1.0 promises");
  const outside = section("Outside the promise");
  for (const spec of Object.keys(PROMISE)) {
    assert.ok(inside.includes(`\`${spec}\``), `docs/stability.md promises ${spec}`);
    assert.ok(!outside.includes(`\`${spec}\``), `docs/stability.md does not also put ${spec} outside`);
  }
  for (const spec of OUTSIDE) {
    assert.ok(outside.includes(`\`${spec}\``), `docs/stability.md puts ${spec} outside the promise`);
    assert.ok(!inside.includes(`\`${spec}\``), `docs/stability.md does not also promise ${spec}`);
  }
});

test("each promised specifier exports exactly its pinned values, in ESM and in CommonJS", async () => {
  ensureBuilt();
  for (const [spec, { values }] of Object.entries(PROMISE)) {
    const { dir, entry } = located(spec);
    const esm = (await import(pathToFileURL(join(dir, entry.import.default)).href)) as Record<string, unknown>;
    assert.deepEqual(sorted(Object.keys(esm)), values, `${spec}: the ESM build's values`);
    const cjs = createRequire(join(dir, "package.json"))(join(dir, entry.require.default)) as Record<string, unknown>;
    assert.deepEqual(sorted(Object.keys(cjs).filter((key) => key !== "__esModule")), values, `${spec}: the CommonJS build's values`);
  }
});

test("each promised specifier's entry declares exactly its pinned values and types, with no star export", () => {
  for (const [spec, { values, types }] of Object.entries(PROMISE)) {
    assert.deepEqual(values, sorted(values), `${spec}: values are listed sorted`);
    assert.deepEqual(types, sorted(types), `${spec}: types are listed sorted`);
    assert.deepEqual(declaredNames(sourceOf(spec)), sorted([...values, ...types]), `${spec}: ${sourceOf(spec)} declares exactly these names`);
  }
});

test("each module system carries its own declarations: dist/cjs is CommonJS, .d.ts included, so `module: Node16` CommonJS code type-checks", () => {
  ensureBuilt();
  for (const [spec, { dir, entry }] of SPECIFIERS) {
    assert.ok(entry.import.types.startsWith("./dist/esm/") && entry.import.default.startsWith("./dist/esm/"), `${spec}: import is the ESM build`);
    // The same entry in both builds: a `require` pointed at a barrel would show CommonJS users names the promise does not hold.
    assert.deepEqual(entry.require, { types: entry.import.types.replace("./dist/esm/", "./dist/cjs/"), default: entry.import.default.replace("./dist/esm/", "./dist/cjs/") }, `${spec}: require is the same entry, CommonJS`);
    for (const target of [entry.import.types, entry.import.default, entry.require.types, entry.require.default]) assert.ok(existsSync(join(dir, target)), `${spec}: ${target} is built`);
  }
  for (const dir of PACKAGES) assert.deepEqual(JSON.parse(readFileSync(join(root, "packages", dir, "dist", "cjs", "package.json"), "utf8")), { type: "commonjs" }, `${dir}: dist/cjs is CommonJS`);
  // `scripts/install-alone.mjs` type-checks a CommonJS consumer against the packed tarballs.
});

test("the `ap.attribute` scope is one per process: a scope opened by the ESM copy is seen by the CommonJS copy", async () => {
  ensureBuilt();
  type Runtime = typeof import("../packages/sdk/src/runtime/public.js");
  const esm = (await import(pathToFileURL(join(sdk, "dist", "esm", "runtime", "public.js")).href)) as Runtime;
  const cjs = createRequire(join(sdk, "package.json"))(join(sdk, "dist", "cjs", "runtime", "public.js")) as Runtime;
  assert.notEqual(esm.withAttribution, cjs.withAttribution, "two module instances");
  const attribution = { artifactId: "art_1", tag: "support.reply", versionId: "v1", arm: "none", model: "gpt-5" };
  assert.equal(esm.withAttribution(attribution, () => cjs.currentAttribution()), attribution);
  assert.equal(cjs.withAttribution(attribution, () => esm.currentAttribution()), attribution);
  assert.equal(esm.currentAttribution(), undefined, "outside the scope, nothing");
  // The key is the rule: one per major. Renaming it inside 1.x would split the scope between two 1.x copies.
  assert.ok(Symbol.for("airprompter.agent-sdk.attribution.v1") in globalThis, "the scope sits on the 1.x key");
});

test("HeartbeatReporterName and the list start() checks against name the same reporters", async () => {
  const { HEARTBEAT_REPORTER_NAMES } = await import("../packages/sdk/src/agent.js");
  // A name added to the type and not the list fails to compile here; one added to the list and not the type fails in agent.ts.
  const every: Record<import("../packages/sdk/src/index.js").HeartbeatReporterName, true> = { "agent-sdk-typescript": true, "agent-sdk-python": true, "airprompter-cli": true, airprompterd: true };
  assert.deepEqual([...HEARTBEAT_REPORTER_NAMES].sort(), Object.keys(every).sort());
});

/**
 * Every type a promised declaration reaches, followed through the built `.d.ts` files: a type the SDK declares that no
 * specifier exports would be frozen by the signatures that use it, yet nobody could name it. Each one is either
 * exported (and pinned above) or the member that reaches it is `@internal` (stripped from the declarations). The
 * adapter contract's own types are the one exception: `frameworks/contract` exports them, outside the promise.
 */
test("every type a promised signature reaches is one a specifier exports", () => {
  ensureBuilt();
  // A type may be named on a promised specifier, or on the contract (outside the promise; its types are the adapters'), never on Steps.
  const nameable = new Set([...Object.keys(PROMISE), "@airprompter/agent-sdk/frameworks/contract"]);
  const entries = [...SPECIFIERS].filter(([spec]) => nameable.has(spec)).map(([spec, { dir, entry }]) => ({ spec, file: join(dir, entry.import.types) }));
  const program = ts.createProgram(entries.map(({ file }) => file), { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, skipLibCheck: true, noEmit: true, types: [] });
  const checker = program.getTypeChecker();
  const packages = join(root, "packages").split("\\").join("/");
  const ours = (declaration: ts.Declaration): boolean => {
    const file = declaration.getSourceFile().fileName;
    return file.startsWith(`${packages}/`) && file.includes("/dist/esm/");
  };
  const resolved = (symbol: ts.Symbol): ts.Symbol => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  const exported = new Set<ts.Symbol>();
  const roots: Array<{ spec: string; symbol: ts.Symbol }> = [];
  for (const { spec, file } of entries) {
    const source = program.getSourceFile(file);
    assert.ok(source, file);
    for (const symbol of checker.getExportsOfModule(checker.getSymbolAtLocation(source)!)) {
      exported.add(resolved(symbol));
      if (spec in PROMISE) roots.push({ spec, symbol: resolved(symbol) });
    }
  }
  const unnamed = new Map<string, string>();
  const seen = new Set<ts.Symbol>();
  const visit = (symbol: ts.Symbol, from: string): void => {
    if (seen.has(symbol)) return;
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (!ours(declaration)) continue;
      const walk = (node: ts.Node): void => {
        // A private member's type is not emitted, and is no one's to name.
        if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)) return;
        if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node) || ts.isTypeQueryNode(node) || (ts.isImportTypeNode(node) && node.qualifier)) {
          // `import("./x.js").T` is how a declaration names a type from another file.
          const name = ts.isImportTypeNode(node) ? (ts.isQualifiedName(node.qualifier!) ? node.qualifier.right : node.qualifier!) : ts.isTypeReferenceNode(node) ? node.typeName : ts.isExpressionWithTypeArguments(node) ? node.expression : node.exprName;
          const target = checker.getSymbolAtLocation(name);
          const real = target ? resolved(target) : undefined;
          const declared = real?.declarations?.find(ours);
          if (real && declared && !(real.flags & ts.SymbolFlags.TypeParameter)) {
            if (!exported.has(real)) unnamed.set(`${real.getName()} (${declared.getSourceFile().fileName.slice(packages.length + 1)})`, from);
            visit(real, `${from} → ${real.getName()}`);
          }
        }
        ts.forEachChild(node, walk);
      };
      walk(declaration);
    }
  };
  for (const { spec, symbol } of roots) visit(symbol, `${spec}: ${symbol.getName()}`);
  assert.deepEqual([...unnamed].map(([name, from]) => `${name}, reached from ${from}`).sort(), []);
});
