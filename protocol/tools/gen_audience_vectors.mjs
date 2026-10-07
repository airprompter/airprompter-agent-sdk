/** Deterministic review-owned audience vectors; explicit expectations are not computed by the implementation under test.
 *
 * Usage:
 *   $ node protocol/tools/gen_audience_vectors.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson } from "../../conformance/reference.mjs";
import { jwkThumbprint, publicJwkOf, signBytes } from "../../conformance/trust.mjs";

// This published test key is deliberately public test material, reused from
// the trust-vector generator so refusal cases can carry a valid signature.
const signer = { kty: "EC", crv: "P-256", x: "2MDfMOVEz8pM_m7u_O9zMlr4T2GHN_tlpj9pfVMGdyo", y: "ym9DiH-4GitdO8-tBC3sZePPU-bEV9Hc0kYOen_IYho", d: "suiXAnwPf-Gk1JvX1m2PHRVKuL0iSXfIakwiFef6b5g" };
const rootSigner = { kty: "EC", crv: "P-256", x: "kHE8TI-jnQoL1Gb2fyooDgcvVUJGUQQwPXzfX1MGiK4", y: "-7-BQROtrrTIaS5tnbfiS72az-XDBzbph57mB8MT1jU", d: "hUxny0ocprVEGy2YVbwSFp3-SDNGSaZ2CEtyPISSNx8" };
const signerId = jwkThumbprint(signer);
const rootSignerId = jwkThumbprint(rootSigner);
const path = new URL("../vectors/audiences.json", import.meta.url);
const vectors = JSON.parse(readFileSync(path, "utf8"));
const targetedProtocolOne = vectors.manifests.find((v) => v.name === "protocol 1.0 targeted envelope refused");
const malformedMajorZero = ["0x0.2.0", "+0.2.0", ".2.0", "00.2.0"];
const refusedNonTargetedProtocols = ["1.2.0", "3.0.0"];
if (vectors.protocol !== "2.0.0" || vectors.cases.length < 34 || vectors.validators?.length < 10 || !vectors.cases.some((v) => v.name === "device prefix contains") || !vectors.cases.some((v) => v.name === "same tag contains both values") || !vectors.cases.some((v) => v.name === "match field refused") || !vectors.cases.some((v) => v.name === "condition missing key refused") || !vectors.cases.some((v) => v.name === "condition missing value refused") || !vectors.cases.some((v) => v.name === "empty contains refused") || !vectors.cases.some((v) => v.name === "unpaired surrogate selector refused") || !vectors.cases.some((v) => v.name === "unpaired surrogate local tag refused") || !vectors.cases.some((v) => v.name === "astral key at scalar limit") || !vectors.cases.some((v) => v.name === "astral key over scalar limit refused") || !vectors.cases.some((v) => v.name === "astral value at scalar limit") || !vectors.cases.some((v) => v.name === "astral value over scalar limit refused") || !vectors.manifests.some((v) => v.name === "signed protocol 2 audience accepted") || !targetedProtocolOne || !Array.isArray(targetedProtocolOne.manifest?.payload?.requiredCapabilities) || !Array.isArray(targetedProtocolOne.manifest?.payload?.observations) || !targetedProtocolOne.manifest?.payload?.experiments?.some((entry) => entry.audience?.selector) || !malformedMajorZero.every((protocol) => vectors.manifests.some((v) => v.manifest?.payload?.protocol === protocol && v.schemaOk === false)) || !refusedNonTargetedProtocols.every((protocol) => vectors.manifests.some((v) => v.manifest?.payload?.protocol === protocol && v.schemaOk === false && !v.manifest.payload.requiredCapabilities && !v.manifest.payload.observations)) || !vectors.manifests.some((v) => v.name === "manifest match field refused") || !vectors.manifests.some((v) => v.name === "manifest missing operator refused") || !vectors.manifests.some((v) => v.name === "protocol 2 audience without capability refused") || !vectors.manifests.some((v) => v.name === "unknown protocol 2.1 audience refused")) throw new Error("audience_vector_contract");
for (const vector of vectors.manifests) {
  vector.root.signed.keys = {
    [rootSignerId]: { keyType: "ecdsa-p256", scheme: "ES256", publicKey: publicJwkOf(rootSigner) },
    [signerId]: { keyType: "ecdsa-p256", scheme: "ES256", publicKey: publicJwkOf(signer) },
  };
  vector.root.signed.roles = {
    root: { keyIds: [rootSignerId], threshold: 1 },
    targets: { keyIds: [signerId], threshold: 1 },
  };
  vector.root.signatures = [{ keyId: rootSignerId, alg: "ES256", sig: signBytes(Buffer.from(canonicalJson(vector.root.signed), "utf8"), rootSigner) }];
  vector.manifest.signatures = [{ keyId: signerId, alg: "ES256", sig: signBytes(Buffer.from(canonicalJson(vector.manifest.payload), "utf8"), signer) }];
}
// This vector changes the signed selector after signing; it must fail at signature verification before semantics.
const accepted = vectors.manifests.find((entry) => entry.name === "signed protocol 2 audience accepted");
const tampered = vectors.manifests.find((entry) => entry.name === "selector tampering fails signature");
tampered.manifest.signatures = accepted.manifest.signatures;
writeFileSync(path, JSON.stringify(vectors, null, 2) + "\n");
