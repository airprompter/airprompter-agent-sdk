/** Deterministic review-owned audience vectors; explicit expectations are not computed by the implementation under test. */
import { readFileSync, writeFileSync } from "node:fs";
const path = new URL("../vectors/audiences.json", import.meta.url);
const vectors = JSON.parse(readFileSync(path, "utf8"));
if (vectors.protocol !== "1.0.0" || vectors.cases.length < 20) throw new Error("audience_vector_contract");
writeFileSync(path, JSON.stringify(vectors, null, 2) + "\n");
