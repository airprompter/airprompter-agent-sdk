/**
 * `@airprompter/datastore-s3` — the release datastore's `KvStore` over an S3
 * bucket (T40, `protocol/datastore-format.md`), with S3's own conditional
 * writes: `If-None-Match: *` for `ifAbsent`, `If-Match: <ETag>` for
 * `ifVersion`; the version is the object's ETag. A `412 PreconditionFailed`
 * or `409 ConditionalRequestConflict` is a lost race, answered `false`.
 * `@aws-sdk/client-s3` (3.700 or later) is a peer dependency: pass your own
 * configured `S3Client`. S3-compatible stores work when they honour both
 * headers on `PutObject` (MinIO and Cloudflare R2 do; check yours with
 * `checkKvStore`).
 *
 * @example
 * ```ts
 * import { S3Client } from "@aws-sdk/client-s3";
 * import { kvReleaseDatastore } from "@airprompter/agent-sdk";
 * import { s3KvStore } from "@airprompter/datastore-s3";
 *
 * const kv = s3KvStore({ client: new S3Client({ region: "eu-west-1" }), bucket: "acme-airprompter-releases" });
 * const datastore = kvReleaseDatastore(kv, { prefix: "prod/" });
 * ```
 */

import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { KvEntry, KvPutCondition, KvStore } from "@airprompter/agent-sync";

export interface S3KvStoreOptions {
  /** A configured client (credentials, region, endpoint). Anything with `S3Client#send` works. */
  client: Pick<S3Client, "send">;
  bucket: string;
  /** Prepended to every key, verbatim (`teams/acme/`). Empty unless told otherwise. */
  keyPrefix?: string;
}

interface S3ErrorLike {
  name?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
}

const statusOf = (error: unknown): number | undefined => (error as S3ErrorLike | null)?.$metadata?.httpStatusCode;
const nameOf = (error: unknown): string | undefined => (error as S3ErrorLike | null)?.name ?? (error as S3ErrorLike | null)?.Code;

function isMissing(error: unknown): boolean {
  return nameOf(error) === "NoSuchKey" || nameOf(error) === "NotFound" || statusOf(error) === 404;
}

/** A conditional write that lost: the object exists, the ETag moved, or another conditional write was in flight. */
function isLostRace(error: unknown): boolean {
  const name = nameOf(error);
  return name === "PreconditionFailed" || name === "ConditionalRequestConflict" || statusOf(error) === 412 || statusOf(error) === 409;
}

export function s3KvStore(options: S3KvStoreOptions): KvStore {
  const { client, bucket } = options;
  const keyPrefix = options.keyPrefix ?? "";
  const objectKey = (key: string) => `${keyPrefix}${key}`;
  return {
    async get(key: string): Promise<KvEntry | null> {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey(key) }));
        const value = result.Body ? await result.Body.transformToString("utf-8") : "";
        if (!result.ETag) throw new Error(`S3 answered ${objectKey(key)} without an ETag; conditional writes need one`);
        return { value, version: result.ETag };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async put(key: string, value: string, condition: KvPutCondition): Promise<boolean> {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: objectKey(key),
            Body: value,
            ContentType: "application/json; charset=utf-8",
            ...("ifAbsent" in condition ? { IfNoneMatch: "*" } : { IfMatch: condition.ifVersion }),
          }),
        );
        return true;
      } catch (error) {
        // `ifVersion` on a key that is gone is 404 on some stores: a lost race too.
        if (isLostRace(error) || ("ifVersion" in condition && isMissing(error))) return false;
        throw error;
      }
    },
    async list(prefix: string): Promise<string[]> {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: objectKey(prefix), ...(token ? { ContinuationToken: token } : {}) }));
        for (const object of page.Contents ?? []) if (object.Key && object.Key.startsWith(objectKey(prefix))) keys.push(object.Key.slice(keyPrefix.length));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async delete(key: string): Promise<void> {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(key) }));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
  };
}
