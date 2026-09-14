import assert from "node:assert/strict";
import test from "node:test";

import { AEAD_AES_128_GCM, AEAD_AES_256_GCM, decap, encap, generateX25519KeyPair, keySchedule, open, openFrom, seal, sealTo, x25519PrivateKeyFromRaw } from "../packages/core/src/bundle/hpke.js";

const hex = (text: string) => Buffer.from(text, "hex");

// RFC 9180, Appendix A.1.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode.
const A1 = {
  info: hex("4f6465206f6e2061204772656369616e2055726e"),
  skEm: hex("52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736"),
  pkEm: hex("37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431"),
  skRm: hex("4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8"),
  pkRm: hex("3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d"),
  sharedSecret: hex("fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc"),
  key: hex("4531685d41d65f03dc48f6b8302c05b0"),
  baseNonce: hex("56d890e5accaaf011cff4b7d"),
  aad0: hex("436f756e742d30"),
  pt: hex("4265617574792069732074727574682c20747275746820626561757479"),
  ct0: hex("f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a"),
};

test("RFC 9180 A.1: encap with the vector's ephemeral key, decap with the recipient key, key schedule, seal and open all match", () => {
  const ephemeral = { privateKey: x25519PrivateKeyFromRaw(A1.skEm, A1.pkEm), publicRaw: A1.pkEm };
  const encapped = encap(A1.pkRm, ephemeral);
  assert.deepEqual(encapped.enc, A1.pkEm);
  assert.deepEqual(encapped.sharedSecret, A1.sharedSecret);
  assert.deepEqual(decap(A1.pkEm, x25519PrivateKeyFromRaw(A1.skRm, A1.pkRm), A1.pkRm), A1.sharedSecret);
  const context = keySchedule(A1.sharedSecret, A1.info, AEAD_AES_128_GCM);
  assert.deepEqual(context.key, A1.key);
  assert.deepEqual(context.baseNonce, A1.baseNonce);
  assert.deepEqual(seal(context, A1.aad0, A1.pt, 0), A1.ct0);
  assert.deepEqual(open(context, A1.aad0, A1.ct0, 0), A1.pt);
});

test("AES-256-GCM single-shot seal/open round-trips and fails closed on a wrong key, wrong AAD, or tampered bytes", () => {
  const recipient = generateX25519KeyPair();
  const info = Buffer.from("airprompter-apbundle-v1", "utf8");
  const aad = Buffer.from("agt_1|prod", "utf8");
  const plaintext = Buffer.from(JSON.stringify({ hello: "bundle" }), "utf8");
  const sealed = sealTo(recipient.publicRaw, info, aad, plaintext, AEAD_AES_256_GCM);
  assert.deepEqual(openFrom({ enc: sealed.enc, recipientPrivateKey: recipient.privateKey, recipientPublicRaw: recipient.publicRaw, info, aad, ciphertext: sealed.ciphertext }), plaintext);
  const other = generateX25519KeyPair();
  assert.throws(() => openFrom({ enc: sealed.enc, recipientPrivateKey: other.privateKey, recipientPublicRaw: other.publicRaw, info, aad, ciphertext: sealed.ciphertext }));
  assert.throws(() => openFrom({ enc: sealed.enc, recipientPrivateKey: recipient.privateKey, recipientPublicRaw: recipient.publicRaw, info, aad: Buffer.from("agt_1|staging"), ciphertext: sealed.ciphertext }));
  const tampered = Buffer.from(sealed.ciphertext);
  tampered[0] = tampered[0]! ^ 0x01;
  assert.throws(() => openFrom({ enc: sealed.enc, recipientPrivateKey: recipient.privateKey, recipientPublicRaw: recipient.publicRaw, info, aad, ciphertext: tampered }));
});
