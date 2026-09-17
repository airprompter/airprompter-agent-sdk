# Change notification: how a fleet learns a release moved

**Status: design note, 2026-09-17.** The pointer-first pull (§2) is shipped
in SDKs 0.2.8. The nudge (§3) is proposed; the channel is the open decision.

## 1. The rule this cannot bend

Every connection is opened by the customer's side, outbound. AirPrompter
never reaches into a customer's network, and nothing AirPrompter sends is
trusted until the puller has fetched the release and verified the whole
chain (`trust-chain.md`). Any notification is therefore at most *"there may
be something newer — check"*; it can never carry the release, a generation
number a runtime would act on, or anything a runtime would apply.

That rules out "AirPrompter POSTs to the client" as the mechanism of
record. A customer in a VPC with no inbound path — the common case — must
get the same service as one with a public endpoint.

## 2. What is shipped: poll the edge, not the API

The control plane writes a few hundred bytes per target behind a CDN after
every promotion or rollback:

```
GET https://<edge>/g/<targetToken>/generation.json      → 200 { generation, releaseDigest, leaseSeconds, issuedAt }
GET …  If-None-Match: <etag>                               → 304
```

The URL is unguessable (a 43-character token per environment) and unsigned:
it can say "nothing moved", never extend trust. Every manifest answer names
it (`x-agent-edge-pointer-url`, protocol 0.3.3) and so does the heartbeat
(`edgePointerUrl`), so no client is configured with it.

`pullBundle` / `pull_bundle` (0.2.8) use it when the caller hands the last
result's `edge` state back:

| Pull | What happens | Cost |
|---|---|---|
| first | origin, once; learns the pointer URL and the manifest ETag | 1 API request |
| idle | pointer with ETag → 304, or a generation the table holds → `unchanged` via `pointer` | 1 CDN 304 |
| moved | pointer says a higher generation → origin, conditional → new bundle | 1 CDN 200 + 1 API request + payloads |
| nudged (`skipPointer`) | origin, conditional → `unchanged` via `origin` or a new bundle | 1 API request |
| no edge on the deployment | origin, conditional, every pull | 1 API request (304) |

`nextPullDelayMs` stretches the interval while nothing changes (doubling,
capped at five minutes by default) and snaps back on any change, refusal or
outage.

Three rules keep the pointer honest, since it is unsigned and a CDN (or a
party between the fleet and the edge) can pin it:

- **A stuck pointer has a bound.** The puller trusts "nothing moved" only
  for `maxPointerAgeMs` (one hour by default) after the origin last
  answered; past that it reads the origin once, conditionally — one API
  304 per puller per hour when nothing moved. A pinned pointer, or one the
  control plane failed to write, can hide a promotion for at most that long.
- **Nothing advances past an answer the origin did not confirm.** The
  pointer's ETag is kept only when the pull ends in `unchanged` or `ok`; a
  pull that fails after the pointer moved returns the state it was given, so
  the next pull sees the move again instead of a 304 that hides it.
- **A CDN outage or a malformed pointer is not an answer.** Either falls
  through to the origin.

And one rule for the caller: persist `edge` **with** the row it came back
beside, never before it — a saved manifest ETag for a row that was never
written makes the next origin read a 304. For scale: a puller at a 30 s base interval that has seen no change
for an hour makes ~12 CDN requests an hour; ten thousand of them cost
roughly $3 a month at CDN rates, against ~$3,000 for the same cadence
against API Gateway + Lambda. The API sees one request per puller per
*promotion*, which is the only number that grows with real activity.

A CloudFront 304 also carries no per-organization Lambda concurrency, so a
fleet of pullers cannot starve the long-poll gate or the run route.

## 3. Proposed: an optional nudge on a channel the customer owns

Some customers want a kill to land in seconds, not at the next poll. For
them, a **nudge**: on every promotion, rollback, dial move or arm disable
the control plane publishes one content-free message

```json
{ "agentId": "agt_…", "target": "prod", "generation": 28, "issuedAt": "…" }
```

to a channel the customer registers for the environment. The puller, on a
nudge, runs one pull with `skipPointer: true`. Nothing else changes: the
pull verifies as always, the pointer poll keeps running, a lost nudge costs
one poll interval of latency and nothing else. A nudge is a *timing hint*,
and the generation in it is informational — a puller that receives
"generation 28" and pulls generation 27 has been told nothing it acts on.

### Channel options

| Channel | Works from a VPC with no inbound | AirPrompter needs | Customer needs | Notes |
|---|---|---|---|---|
| **Amazon SQS queue** in the customer's account | yes (the puller long-polls its own queue) | `sqs:SendMessage` on that queue (cross-account queue policy) | a queue + a policy line | the strongest default: no endpoint, no secret, long-poll is free |
| **Amazon SNS topic** in the customer's account | yes (fan-out to their SQS / Lambda) | `sns:Publish` on the topic | a topic policy | for customers who want several subscribers |
| **Amazon EventBridge** (their bus) | yes | `events:PutEvents` on the bus | a bus policy + rule | native for platform teams already on EventBridge |
| **Webhook URL** (HTTPS POST) | no | to reach the URL | a public or VPN-reachable endpoint; a shared secret to verify the signature | the familiar option; signed with the environment's key so a forged nudge is ignored (it would only cause a pull anyway) |
| **Long poll on the API** (`?wait=25`, exists today) | yes | nothing new | nothing | reaction in ≤ 25 s, but each open request holds a Lambda: bounded per organization, and it is the expensive path this note exists to avoid |

Recommendation: ship **SQS first** (it is the one that needs no endpoint,
no secret and no new surface on our side beyond a delivery), **webhook
second** (customers who ask for it), SNS/EventBridge as the customer's own
fan-out from SQS. Registration lives on the environment's policy
(Settings › Environments), one channel per environment, with a "send test
nudge" button.

### What the control plane does

- One delivery per event, at-least-once, from the same place the edge
  pointer is written (`agentPointerRouteHelpers` after the generation
  commits). A failed delivery is logged and retried a few times; the
  pointer is the fallback and always moves.
- The message carries the four fields above and nothing else — no prompt
  text, no digest (the digest is in the signed manifest the puller
  fetches), no secret.
- A per-environment rate cap (a dial ramp moving every minute is fine; a
  runaway loop is not).

### What the SDK does

- `pullBundle` already takes `skipPointer`. The puller job wires the
  channel: an SQS long-poll loop (or an HTTP handler) that calls the pull.
  The demo puller (`~/customer-app-test/src/fleet/puller.mjs`) shows the
  poll loop; the nudge is a second trigger into the same `pass()`.
- `airprompterd` gains `--nudge-sqs <queue-url>` (and later a webhook
  listener) so a daemon-run host reacts too.

### Open decisions

1. SQS-first, then webhook? Or webhook-first because it is what customers
   expect to see in a settings page?
2. Should a nudge also carry the *kind* (`promote`, `rollback`, `dial`,
   `disable`) so a customer can page on `disable`? It is content-free
   either way.
3. Per-environment or per-agent registration? (Per-environment matches
   where keys and policy live.)
