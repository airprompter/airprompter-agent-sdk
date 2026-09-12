# airprompter CLI and daemon

One binary, shipped as signed single-file executables for macOS
(notarized), Linux and Windows, so Python users never install Node.

Commands: `pull`, `verify`, `apply`, `status`, `diff`, `unlock`,
`rollback`, `keygen`, `countersign`, `export-telemetry`,
`import-telemetry`, and `daemon` (`airprompterd`).

The daemon runs one per host: it pulls the manifest once for every process
on the host, keeps the shared slot store, executes unlock for the host,
holds the current upload grant, and uploads the spool with backoff and
jitter. SDKs attach over a local socket if it exists and fall back to
in-process mode if it does not — the daemon is an optimization, never a
hard requirement.
