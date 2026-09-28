# Deploy manifests for airprompterd

`airprompter daemon` is the host's **telemetry daemon**
([`protocol/daemon.md`](../protocol/daemon.md)): it publishes
`<store dir>/daemon.json` naming the spool folder it scans, and ships the
segments every SDK process on the host writes there — to AirPrompter under
one grant per writer, or to your OpenTelemetry collector with
`--upload-sink otlp`. It **serves no release**: every process loads its
own from its store, the customer's datastore or a vendored bundle. SDK
processes find the file, write their segments into its folder with a
manifest each, and leave the upload to it; without it a process with a
key uploads its own spool — **the daemon is an optimization, never a
requirement.** Its value: one key ships the telemetry of processes that
hold none (a runtime hydrated from the datastore), and several processes
on one host share one uploader and one host budget.

| Host | Manifest | Validated in CI by |
|---|---|---|
| Linux, systemd | [`systemd/airprompterd.service`](systemd/airprompterd.service) + [`airprompterd.env.example`](systemd/airprompterd.env.example) | `systemd-analyze verify` |
| macOS, launchd | [`launchd/com.airprompter.airprompterd.plist`](launchd/com.airprompter.airprompterd.plist) | `plutil -lint` |
| Windows service | [`windows/airprompterd.xml`](windows/airprompterd.xml) (WinSW wrapper) | `xmllint --noout` |
| Docker sidecar | [`docker/Dockerfile`](docker/Dockerfile), [`docker/docker-compose.yml`](docker/docker-compose.yml) | `docker build` + `docker run … --version` + `docker compose config` |
| Kubernetes | [`kubernetes/daemonset.yaml`](kubernetes/daemonset.yaml) | `kubeconform -strict` |

What every manifest does the same way:

- The Agent key comes from `AIRPROMPTER_AGENT_KEY` in the service's
  environment (a `0600` env file, a Secret, the service account's
  environment), never from arguments. The daemon uses it for upload grants
  only; with `--upload-sink otlp` it needs none.
- The state directory is per-service and `0700`
  (`/var/lib/airprompter`, `~/Library/Application Support`,
  `C:\ProgramData\AirPrompter\state`); `daemon.json` lives inside the
  store directory, mode `0600`, refreshed every minute.
- Application processes that should hand their telemetry over run **as the
  same user** with the same state directory (or point
  `AIRPROMPTER_SPOOL_DIR` at the daemon's folder). Anything else uploads
  its own spool, or keeps it on disk without a key.
- The daemon stops on SIGTERM within 20 s: one last upload pass, then it
  deletes `daemon.json` and processes that can upload take it back within
  a minute.
- `airprompter status --agent … --environment … --require-daemon` reads
  `daemon.json` and is the liveness probe: it exits `1` when the file is
  missing or its heartbeat is over ten minutes old.
