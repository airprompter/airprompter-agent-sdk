/**
 * `airprompter login` (S11): a signed-in user's session token for the
 * commands that write to a workspace (`import`). Team writes need a person,
 * never an API key (AIR-1854), so this signs in with the person's own email
 * and password through the same route the app uses and prints the session
 * token as an `export` line to paste, or as JSON with `--json`.
 *
 * The password is never taken on argv: it comes from the environment
 * (`--password-env`, default AIRPROMPTER_PASSWORD) or, on a terminal, is
 * prompted for without echo. The token is short-lived (an hour); nothing is
 * stored on disk.
 *
 * @example
 * ```sh
 * eval "$(airprompter login --email you@example.com)"     # password from AIRPROMPTER_PASSWORD or the terminal; exports AIRPROMPTER_SESSION_TOKEN
 * ```
 */

import { CliError, EXIT, Output, refused, requireOption, usage, type Context } from "../io.js";
import { COMMON_OPTIONS, flag, helpFor, parse, str, type OptionSpec } from "../args.js";
import { CLI_VERSION } from "../version.js";

export const LOGIN_OPTIONS: OptionSpec = {
  email: { type: "string", help: "The email of the AirPrompter user (a member of the workspace)" },
  "password-env": { type: "string", default: "AIRPROMPTER_PASSWORD", help: "Environment variable holding the password (never passed on argv); on a terminal it is prompted for when unset" },
  "base-url": { type: "string", help: "AirPrompter API base URL (default https://api.airprompter.com)" },
  ...COMMON_OPTIONS,
};

export interface SignInResponse {
  accessToken?: string;
  idToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  challengeName?: string;
  error?: string;
  message?: string;
}

/** Reads a secret from the terminal without echo; null when there is no terminal. */
export async function promptSecret(ctx: Context, label: string): Promise<string | null> {
  if (!ctx.isTTY) return null;
  const { createInterface } = await import("node:readline");
  const input = process.stdin;
  const output = process.stderr;
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: true });
    const muted = { on: true };
    const write = output.write.bind(output);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (!muted.on || s.includes(label)) write(s);
    };
    rl.question(`${label}: `, (answer) => {
      muted.on = false;
      write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

export async function login(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, LOGIN_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("login", "--email … [--password-env AIRPROMPTER_PASSWORD] [--base-url …]", LOGIN_OPTIONS));
    return EXIT.ok;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const email = requireOption(str(parsed, "email"), "email").trim().toLowerCase();
  const passwordEnv = str(parsed, "password-env") ?? "AIRPROMPTER_PASSWORD";
  let password = ctx.env[passwordEnv];
  if (!password) password = (await promptSecret(ctx, `Password for ${email}`)) ?? undefined;
  if (!password) throw usage(`${passwordEnv} is not set and there is no terminal to ask on (the password is never taken on argv)`);
  if (!ctx.fetch) throw usage("no fetch available: Node 20+ is required");
  const baseUrl = (str(parsed, "base-url") ?? "https://api.airprompter.com").replace(/\/+$/, "");
  const response = await ctx.fetch(`${baseUrl}/auth/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": `airprompter-cli/${CLI_VERSION}` },
    body: JSON.stringify({ email, password, client: "airprompter-cli" }),
  });
  const text = await response.text();
  let body: SignInResponse = {};
  try {
    body = JSON.parse(text) as SignInResponse;
  } catch {
    // the status is the message
  }
  if (response.status === 401) throw refused("invalid email or password", { reason: "unauthorized" });
  if (response.status !== 200) throw refused(`sign-in was refused: ${body.message ?? body.error ?? `HTTP ${response.status}`}`, { reason: body.error ?? `http_${response.status}` });
  if (body.challengeName) throw new CliError(EXIT.refused, `sign-in needs another step (${body.challengeName}); complete it in the app, then try again`, { reason: "challenge", challengeName: body.challengeName });
  if (!body.accessToken) throw refused("sign-in answered without a session token", { reason: "protocol" });
  out.set("accessToken", body.accessToken);
  if (body.expiresIn !== undefined) out.set("expiresIn", body.expiresIn);
  out.line(`# Signed in as ${email}. Paste the line below into your shell (the token lasts about an hour):`);
  out.line(`export AIRPROMPTER_SESSION_TOKEN=${body.accessToken}`);
  out.flush();
  return EXIT.ok;
}
