/**
 * HPKE base mode (RFC 9180) with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and
 * AES-GCM, on node:crypto alone. The offline bundle (`.apbundle`) is sealed
 * to the target's X25519 distribution key with AES-256-GCM; AES-128-GCM is
 * here only so the implementation can be checked against RFC 9180's A.1
 * test vector, which uses that AEAD with the same KEM and KDF.
 */

import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject } from "node:crypto";

const KEM_X25519 = 0x0020;
const KDF_HKDF_SHA256 = 0x0001;
export const AEAD_AES_128_GCM = 0x0001;
export const AEAD_AES_256_GCM = 0x0002;
const NSECRET = 32;
const NN = 12;

const utf8 = (text: string) => Buffer.from(text, "utf8");
const i2osp2 = (value: number) => Buffer.from([(value >> 8) & 0xff, value & 0xff]);
const kemSuiteId = Buffer.concat([utf8("KEM"), i2osp2(KEM_X25519)]);
const hpkeSuiteId = (aead: number) => Buffer.concat([utf8("HPKE"), i2osp2(KEM_X25519), i2osp2(KDF_HKDF_SHA256), i2osp2(aead)]);

function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac("sha256", salt.length ? salt : Buffer.alloc(32)).update(ikm).digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(blocks).length < length; counter += 1) {
    previous = createHmac("sha256", prk).update(Buffer.concat([previous, info, Buffer.from([counter])])).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

function labeledExtract(suiteId: Buffer, salt: Buffer, label: string, ikm: Buffer): Buffer {
  return hkdfExtract(salt, Buffer.concat([utf8("HPKE-v1"), suiteId, utf8(label), ikm]));
}

function labeledExpand(suiteId: Buffer, prk: Buffer, label: string, info: Buffer, length: number): Buffer {
  return hkdfExpand(prk, Buffer.concat([i2osp2(length), utf8("HPKE-v1"), suiteId, utf8(label), info]), length);
}

function rawPublic(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: "jwk" }).x as string, "base64url");
}

export function x25519PublicKeyFromRaw(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
}

export function x25519PrivateKeyFromRaw(raw: Uint8Array, publicRaw: Uint8Array): KeyObject {
  return createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(publicRaw).toString("base64url"), d: Buffer.from(raw).toString("base64url") }, format: "jwk" });
}

export function generateX25519KeyPair(): { privateKey: KeyObject; publicKey: KeyObject; publicRaw: Buffer } {
  const pair = generateKeyPairSync("x25519");
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicRaw: rawPublic(pair.publicKey) };
}

function extractAndExpand(dh: Buffer, kemContext: Buffer): Buffer {
  const eaePrk = labeledExtract(kemSuiteId, Buffer.alloc(0), "eae_prk", dh);
  return labeledExpand(kemSuiteId, eaePrk, "shared_secret", kemContext, NSECRET);
}

export function encap(recipientPublicRaw: Uint8Array, ephemeral?: { privateKey: KeyObject; publicRaw: Buffer }): { sharedSecret: Buffer; enc: Buffer } {
  const e = ephemeral ?? generateX25519KeyPair();
  const dh = diffieHellman({ privateKey: e.privateKey, publicKey: x25519PublicKeyFromRaw(recipientPublicRaw) });
  const enc = e.publicRaw;
  return { sharedSecret: extractAndExpand(dh, Buffer.concat([enc, Buffer.from(recipientPublicRaw)])), enc };
}

export function decap(enc: Uint8Array, recipientPrivateKey: KeyObject, recipientPublicRaw: Uint8Array): Buffer {
  const dh = diffieHellman({ privateKey: recipientPrivateKey, publicKey: x25519PublicKeyFromRaw(enc) });
  return extractAndExpand(dh, Buffer.concat([Buffer.from(enc), Buffer.from(recipientPublicRaw)]));
}

export interface HpkeContext {
  key: Buffer;
  baseNonce: Buffer;
  aead: number;
}

export function keySchedule(sharedSecret: Buffer, info: Buffer, aead: number): HpkeContext {
  const suite = hpkeSuiteId(aead);
  const pskIdHash = labeledExtract(suite, Buffer.alloc(0), "psk_id_hash", Buffer.alloc(0));
  const infoHash = labeledExtract(suite, Buffer.alloc(0), "info_hash", info);
  const context = Buffer.concat([Buffer.from([0x00]), pskIdHash, infoHash]);
  const secret = labeledExtract(suite, sharedSecret, "secret", Buffer.alloc(0));
  const nk = aead === AEAD_AES_256_GCM ? 32 : 16;
  return { key: labeledExpand(suite, secret, "key", context, nk), baseNonce: labeledExpand(suite, secret, "base_nonce", context, NN), aead };
}

function nonceFor(context: HpkeContext, seq: number): Buffer {
  const nonce = Buffer.from(context.baseNonce);
  // XOR the sequence number into the low-order bytes (big-endian).
  let remaining = seq;
  for (let index = nonce.length - 1; index >= 0 && remaining > 0; index -= 1) {
    nonce[index] = nonce[index]! ^ (remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return nonce;
}

/** ct ‖ tag(16), as HPKE's AEAD.Seal returns it. */
export function seal(context: HpkeContext, aad: Uint8Array, plaintext: Uint8Array, seq = 0): Buffer {
  const algorithm = context.aead === AEAD_AES_256_GCM ? "aes-256-gcm" : "aes-128-gcm";
  const cipher = createCipheriv(algorithm, context.key, nonceFor(context, seq));
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function open(context: HpkeContext, aad: Uint8Array, ciphertext: Uint8Array, seq = 0): Buffer {
  const algorithm = context.aead === AEAD_AES_256_GCM ? "aes-256-gcm" : "aes-128-gcm";
  const buffer = Buffer.from(ciphertext);
  const decipher = createDecipheriv(algorithm, context.key, nonceFor(context, seq));
  decipher.setAAD(aad);
  decipher.setAuthTag(buffer.subarray(buffer.length - 16));
  return Buffer.concat([decipher.update(buffer.subarray(0, buffer.length - 16)), decipher.final()]);
}

/** Single-shot base-mode seal: returns `enc` and the ciphertext. */
export function sealTo(recipientPublicRaw: Uint8Array, info: Uint8Array, aad: Uint8Array, plaintext: Uint8Array, aead = AEAD_AES_256_GCM): { enc: Buffer; ciphertext: Buffer } {
  const { sharedSecret, enc } = encap(recipientPublicRaw);
  return { enc, ciphertext: seal(keySchedule(sharedSecret, Buffer.from(info), aead), aad, plaintext) };
}

export function openFrom(input: { enc: Uint8Array; recipientPrivateKey: KeyObject; recipientPublicRaw: Uint8Array; info: Uint8Array; aad: Uint8Array; ciphertext: Uint8Array; aead?: number }): Buffer {
  const sharedSecret = decap(input.enc, input.recipientPrivateKey, input.recipientPublicRaw);
  return open(keySchedule(sharedSecret, Buffer.from(input.info), input.aead ?? AEAD_AES_256_GCM), input.aad, input.ciphertext);
}
