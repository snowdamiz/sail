# syntax=docker/dockerfile:1
ARG NODE_VERSION=26.13.1

FROM rust:1.99-bookworm AS rust
ARG TARGETARCH
WORKDIR /src
COPY native/resource-monitor native/resource-monitor
COPY native/sail-boat native/sail-boat
RUN --mount=type=cache,id=sail-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=sail-cargo-target-${TARGETARCH},target=/src/target,sharing=locked \
    cargo build --release --locked --target-dir target --manifest-path native/resource-monitor/Cargo.toml \
    && cargo build --release --locked --target-dir target --manifest-path native/sail-boat/Cargo.toml --bin sail-boatd \
    && install -D -m 0755 -t /out target/release/t3-resource-monitor target/release/sail-boatd

# The bundle and web client are the same on every platform, so this stage runs natively when
# cross-building. Only the staged runtime externals pick packages for the target.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm AS build
ARG VP_VERSION=1.8.0
ENV CI=true \
    VP_NODE_MANAGER=no \
    VP_BIN_DIR=/opt/vp/bin \
    VP_DATA_DIR=/opt/vp/data \
    VP_CACHE_DIR=/opt/vp/cache \
    PATH=/opt/vp/bin:$PATH
RUN curl -fsSL https://vite.plus -o /tmp/vp.sh && VP_VERSION=$VP_VERSION bash /tmp/vp.sh && vp --version
WORKDIR /src
COPY --exclude=deploy --exclude=native/sail-boat --exclude=native/resource-monitor \
    --exclude=docs --exclude=.github \
    --exclude=scripts/smoke-docker-image.ts . .
RUN test "v$(node -p 'require("./package.json").engines.node')" = "$(node --version)"
RUN --mount=type=cache,id=sail-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    vp install
# The server's own build task swaps development icons into its copy of the client.
ARG APP_VERSION=
RUN APP_VERSION=$APP_VERSION vp run --filter @t3tools/web build \
    && APP_VERSION=$APP_VERSION vp run --filter t3 build:bundle \
    && find apps/server/dist apps/web/dist -name '*.map' -delete
ARG TARGETARCH
RUN --mount=type=cache,id=sail-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    node scripts/stage-server-runtime.ts --platform linux \
      --arch "$(if [ "$TARGETARCH" = amd64 ]; then echo x64; else echo "$TARGETARCH"; fi)" \
      --output-dir /stage

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git openssh-client procps ripgrep tini \
    && rm -rf /var/lib/apt/lists/* \
    && userdel --remove node \
    && useradd --uid 1000 --user-group --home-dir /data/home --no-create-home --shell /bin/bash sail
# sail owns the npm prefix, so the agent CLIs can update themselves without root.
ARG CLAUDE_CODE_VERSION=2.1.332
ARG CODEX_VERSION=0.172.0
ARG OPENCODE_VERSION=1.19.6
RUN npm install --global --prefix /opt/npm-global \
      --allow-scripts=@anthropic-ai/claude-code,opencode-ai \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
      opencode-ai@${OPENCODE_VERSION} \
    && rm -rf /root/.npm \
    && chown -R sail:sail /opt/npm-global

COPY --from=rust /out/sail-boatd /opt/sail/bin/sail-boatd
COPY --from=build /stage/node_modules /opt/sail/node_modules
COPY --from=build /src/apps/server/dist /opt/sail/server
COPY --from=build /src/apps/web/dist /opt/sail/server/client
COPY --from=rust /out/t3-resource-monitor /opt/sail/server/resource-monitor/t3-resource-monitor
COPY --chmod=0755 deploy/docker/entrypoint.sh /usr/local/bin/sail-entrypoint
# fly ssh and docker exec start as root; t3 always runs as sail so its data stays sail's.
# Code that runs as root names every command by path: sail can write to directories on PATH.
COPY --chmod=0755 <<'EOF' /usr/local/bin/t3
#!/bin/sh
if [ "$(/usr/bin/id -u)" = 0 ]; then
  exec /usr/bin/setpriv --reuid=sail --regid=sail --init-groups \
    /usr/bin/env HOME=/data/home USER=sail LOGNAME=sail \
    /usr/local/bin/node /opt/sail/server/bin.mjs "$@"
fi
exec /usr/local/bin/node /opt/sail/server/bin.mjs "$@"
EOF
# /etc/profile resets PATH for login shells, such as the web terminal and fly ssh console.
# Root shells move to /root so they never read or write sail's dotfiles.
COPY <<'EOF' /etc/profile.d/sail-path.sh
if [ "$(/usr/bin/id -u)" = 0 ]; then
  HOME=/root
else
  PATH="$HOME/.local/bin:/opt/npm-global/bin:$PATH"
fi
EOF
RUN printf '[ "$(/usr/bin/id -u)" = 0 ] && HOME=/root\n' >> /etc/bash.bashrc
# A container has no logind and never sleeps, so keep-awake runs its hold without a lock.
COPY --chmod=0755 <<'EOF' /usr/local/bin/systemd-inhibit
#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    --*) shift ;;
    *) break ;;
  esac
done
[ "$#" -gt 0 ] || { echo "systemd-inhibit: no command to run" >&2; exit 1; }
exec "$@"
EOF

ENV HOME=/data/home \
    SAIL_HOME=/data/sail \
    T3CODE_HOME=/data/sail \
    SAIL_STARTUP_PAIRING=off \
    SAIL_BOATD_PATH=/opt/sail/bin/sail-boatd \
    NPM_CONFIG_PREFIX=/opt/npm-global \
    SHELL=/bin/bash \
    LANG=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/data/home/.local/bin:/opt/npm-global/bin
EXPOSE 8080
VOLUME /data
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sail-entrypoint"]
