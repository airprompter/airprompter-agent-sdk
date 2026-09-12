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
