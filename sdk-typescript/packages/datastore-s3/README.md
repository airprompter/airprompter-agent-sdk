# @airprompter/datastore-s3

The AirPrompter release datastore over an S3 bucket: a `KvStore` for
`kvReleaseDatastore` (`@airprompter/agent-sdk/sync`), with S3's own conditional
writes. The puller writes sealed releases through it; every runtime
hydrates from it
([docs/datastore.md](https://github.com/airprompter/airprompter-agent-sdk/blob/main/docs/datastore.md)).

## Install

```bash
npm install --save-exact @airprompter/agent-sdk@1.0.0-rc.5 @airprompter/datastore-s3@1.0.0-rc.5 @aws-sdk/client-s3
```

The SDK is a peer (exactly this version on a release candidate, this version or later within the major
from 1.0.0), so one copy resolves.

<!-- release-candidate -->
This is a release candidate for 1.0.0. Pin it exactly, as above: npm's default
range on a candidate also matches later candidates, and an unpinned install
takes the `latest` tag, the 0.x line.
<!-- /release-candidate -->

## Use

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { kvReleaseDatastore } from "@airprompter/agent-sdk/sync";
import { s3KvStore } from "@airprompter/datastore-s3";

const kv = s3KvStore({ client: new S3Client({ region: "eu-west-1" }), bucket: "acme-airprompter-releases" });
const datastore = kvReleaseDatastore(kv);
```

- **Peer dependency:** `@aws-sdk/client-s3` 3.700 or later; pass your own
  configured `S3Client`.
- **Conditional writes:** `If-None-Match: *` (`ifAbsent`) and
  `If-Match: <ETag>` (`ifVersion`); a `412` or `409` is a lost race.
- **S3-compatible stores** work when they honour both headers on
  `PutObject` (MinIO and Cloudflare R2 do). Prove yours:
  `await checkKvStore(kv)` → `{ ok, failures }`.
- **Permissions:** the puller needs `s3:GetObject`, `s3:PutObject`,
  `s3:ListBucket` and `s3:DeleteObject` (pruning) on the prefix; runtimes
  need `s3:GetObject` and `s3:ListBucket` only. Encrypt the bucket at rest;
  the rows are already ciphertext to the fleet's distribution key.
