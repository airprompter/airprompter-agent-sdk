/** The protocol this SDK speaks (`protocol/VERSION`); the manifest carries it and the heartbeat reports it. */
export const PROTOCOL_VERSION = "0.3.4";
/** This package's own version, as the heartbeat and store.json (S8: the writer) record it. */
export const SDK_VERSION = "0.2.12";

/**
 * Whether a protocol version string is at least another (`major.minor.patch`, numerically). The manifest a control
 * plane sealed names the protocol it speaks; a runtime that must send a newer optional member reads that before
 * sending it, so a 0.3.4 SDK talking to a 0.3.3 service never trips its strict schemas.
 */
export function protocolAtLeast(version: string, floor: string): boolean {
  const parse = (value: string) => (/^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map((part) => Number.parseInt(part, 10)) : []);
  const [a, b] = [parse(version), parse(floor)];
  if (a.length !== 3 || b.length !== 3) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]!;
  }
  return true;
}
