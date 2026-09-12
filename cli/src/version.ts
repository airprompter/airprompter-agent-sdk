/** Stamped by the bundler from package.json and protocol/VERSION; the source defaults are for tests. */
import { readFileSync } from "node:fs";

declare const __AIRPROMPTER_CLI_VERSION__: string | undefined;
declare const __AIRPROMPTER_PROTOCOL_VERSION__: string | undefined;

export const CLI_VERSION: string = typeof __AIRPROMPTER_CLI_VERSION__ === "string" ? __AIRPROMPTER_CLI_VERSION__ : "0.0.0-dev";
export const PROTOCOL_VERSION: string = typeof __AIRPROMPTER_PROTOCOL_VERSION__ === "string" ? __AIRPROMPTER_PROTOCOL_VERSION__ : readProtocolVersion();

function readProtocolVersion(): string {
  try {
    return readFileSync(new URL("../../protocol/VERSION", import.meta.url), "utf8").trim();
  } catch {
    return "0.0.0";
  }
}
