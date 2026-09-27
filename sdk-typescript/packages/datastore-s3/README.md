# @airprompter/datastore-s3

The AirPrompter release datastore over an S3 bucket: a `KvStore` for
`kvReleaseDatastore` (`@airprompter/agent-sync`), with S3's own conditional
writes. The puller writes sealed releases through it; every runtime
hydrates from it
([docs/datastore.md](https://github.com/airprompter/airprompter-agent-sdk/blob/main/docs/datastore.md)).

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { kvReleaseDatastore } from "@airprompter/agent-sdk";
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
