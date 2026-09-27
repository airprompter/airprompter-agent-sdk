# airprompter-datastore-s3

The AirPrompter release datastore over an S3 bucket: a `KvStore` for
`kv_release_datastore` (`airprompter-agent-sync`), with S3's own conditional
writes ([docs/datastore.md](https://github.com/airprompter/airprompter-agent-sdk/blob/main/docs/datastore.md)).
Object keys match `@airprompter/datastore-s3`, so Python and TypeScript share a bucket.

```python
import boto3
from airprompter_agent import kv_release_datastore
from airprompter_datastore_s3 import s3_kv_store

releases = kv_release_datastore(s3_kv_store(client=boto3.client("s3", region_name="eu-west-1"), bucket="acme-airprompter-releases"))
```

- `IfNoneMatch="*"` (`if_absent`) and `IfMatch=<ETag>` (`if_version`); a `412`
  or `409` is a lost race. boto3 1.35.70+ for `IfMatch`.
- S3-compatible stores work when they honour both headers (MinIO, R2):
  `check_kv_store(kv)` proves yours.
- The puller needs `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` and
  `s3:DeleteObject` (pruning); runtimes need `s3:GetObject` and `s3:ListBucket`.
