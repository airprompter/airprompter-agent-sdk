/**
 * The binary's entry: what `airprompter …` runs. It hands the process's argv,
 * stdio, environment and `fetch` (`defaultContext()`) to `run()` in `cli.ts`,
 * sets the exit code `run()` returns, and reports an error nothing caught as
 * `error: …` on stderr with exit 1. Nothing else lives here, so a test calls
 * `run()` with a fake context and never this file.
 *
 * @example
 * ```sh
 * airprompter --help
 * airprompter status --agent agt_… --environment prod --json
 * node dist/airprompter.cjs --version     # the bundled entry (npm run bundle), before it is a signed executable
 * ```
 */

import { run } from "./cli.js";
import { defaultContext } from "./io.js";

run(process.argv.slice(2), defaultContext()).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
