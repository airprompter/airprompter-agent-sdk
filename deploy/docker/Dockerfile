# The airprompterd sidecar image, built from this repository's sources.
#
#   docker build -f deploy/docker/Dockerfile -t airprompterd .
#   docker run --rm airprompterd --version
#
# The image carries the single-file executable (the Node runtime is inside
# it) and nothing else; it runs as an unprivileged user with the state
# directory on a volume. See docker-compose.yml for the sidecar wiring.

FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY protocol/VERSION protocol/VERSION
COPY sdk-typescript/packages/core/src sdk-typescript/packages/core/src
COPY sdk-typescript/packages/sync/src sdk-typescript/packages/sync/src
COPY sdk-typescript/packages/runtime/src sdk-typescript/packages/runtime/src
COPY sdk-typescript/packages/telemetry/src sdk-typescript/packages/telemetry/src
COPY sdk-typescript/packages/otel-bridge/src sdk-typescript/packages/otel-bridge/src
COPY sdk-typescript/packages/sdk/src sdk-typescript/packages/sdk/src
COPY sdk-typescript/test/helpers sdk-typescript/test/helpers
COPY cli/package.json cli/package-lock.json cli/tsconfig.json cli/
COPY cli/src cli/src
COPY cli/scripts cli/scripts
RUN cd cli && npm ci --ignore-scripts --no-audit --no-fund && node scripts/build-sea.mjs --out dist/airprompter

FROM debian:bookworm-slim
RUN groupadd --system airprompter && useradd --system --gid airprompter --home-dir /var/lib/airprompter --shell /usr/sbin/nologin airprompter \
  && install -d -o airprompter -g airprompter -m 0700 /var/lib/airprompter \
  && apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/cli/dist/airprompter /usr/local/bin/airprompter
USER airprompter
ENV XDG_STATE_HOME=/var/lib/airprompter
VOLUME ["/var/lib/airprompter"]
ENTRYPOINT ["/usr/local/bin/airprompter"]
CMD ["--help"]
