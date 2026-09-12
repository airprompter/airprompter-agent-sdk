# Deploy manifests for airprompterd

`airprompter daemon` runs one sync loop and one shared, encrypted store per
host and serves the verified release to every SDK process on the host
over a local socket (`protocol/daemon-socket.md`). SDK processes started
with `sync.mode: "daemon"` attach when the socket is there and sync
in-process when it is not — **the daemon is an optimization, never a
requirement.** One process per container that never shares a host gains
nothing from it; several processes on one host stop pulling separately
and holding separate stores.

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
  environment), never from arguments.
- The state directory is per-service and `0700`
  (`/var/lib/airprompter`, `~/Library/Application Support`,
  `C:\ProgramData\AirPrompter\state`); the socket lives inside the
  store directory, mode `0600`.
- Application processes that should attach run **as the same user** with
  the same state directory. Anything else falls back to in-process sync.
- The daemon stops on SIGTERM within 20 s (it tells attached SDKs it is
  going; they keep serving what they hold and reconnect).
- `airprompter status --agent … --environment …` on the host asks the
  daemon (last sync, backoff, attached clients, RSS) and doubles as the
  liveness probe; `GET /healthz` on the socket answers `200` with a
  verified release active and `503` without.
