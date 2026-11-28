# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
FROM rust:1.99-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c AS rust
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
FROM --platform=$BUILDPLATFORM node:26.13.1-bookworm@sha256:893ea48106e988a5f31e69629d6472600daa9d0494adf7db87eb0b886ce82255 AS build
ENV CI=true \
    VP_NODE_MANAGER=no \
    VP_BIN_DIR=/opt/vp/bin \
    VP_DATA_DIR=/opt/vp/data \
    VP_CACHE_DIR=/opt/vp/cache \
    PATH=/opt/vp/bin:$PATH
RUN curl -fsSL https://raw.githubusercontent.com/voidzero-dev/vite-plus/374262589fa191b7ff1bb047b763f7ef86991fad/packages/cli/install.sh -o /tmp/vp.sh \
    && echo '5d360005c321fedb48d5a6dafb4e22e6ffc8d5a03e1b3aa3d7ee1c88f9ced3a9  /tmp/vp.sh' | sha256sum -c - \
    && VP_VERSION=1.8.0 bash /tmp/vp.sh \
    && rm /tmp/vp.sh \
    && vp --version
WORKDIR /src
COPY --exclude=deploy --exclude=native/sail-boat --exclude=native/resource-monitor \
    --exclude=docs --exclude=.github \
    --exclude=scripts/smoke-docker-image.ts . .
RUN test "v$(node -p 'require("./package.json").engines.node')" = "$(node --version)"
RUN --mount=type=cache,id=sail-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    vp install
# The server build copies development icons into its client; brand it as desktop releases do,
# from the version the bundle reports (APP_VERSION, else the server manifest without .git).
ARG APP_VERSION=
RUN APP_VERSION=$APP_VERSION vp run --filter t3 build \
    && version="${APP_VERSION:-$(node -p 'require("./apps/server/package.json").version')}" \
    && brand="$(node --input-type=module -e 'import { resolveDesktopWebAssetBrand } from "./scripts/build-desktop-artifact.ts"; console.log(resolveDesktopWebAssetBrand(process.argv[1]))' "$version")" \
    && node scripts/apply-web-brand-assets.ts "$brand" apps/server/dist/client \
    && find apps/server/dist -name '*.map' -delete
ARG TARGETARCH
RUN --mount=type=cache,id=sail-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    node scripts/stage-server-runtime.ts --platform linux \
      --arch "$(if [ "$TARGETARCH" = amd64 ]; then echo x64; else echo "$TARGETARCH"; fi)" \
      --output-dir /stage

# 1Password CLI enables 1Password service-account credentials on personal Sail web servers.
FROM --platform=$BUILDPLATFORM node:26.13.1-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS op-cli
ARG TARGETARCH
ARG OP_CLI_VERSION=2.42.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
         amd64) sha=261fe3844a43e7e83a3d85e8a9f36411729436a1d3add1dc7dd46cbbceebe9e5 ;; \
         arm64) sha=e56c379fabafb393ce699258e484694abe464870fb41f35ce1b5c3f17868ba61 ;; \
         *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_CLI_VERSION}/op_linux_${TARGETARCH}_v${OP_CLI_VERSION}.zip" -o /tmp/op.zip \
    && echo "${sha}  /tmp/op.zip" | sha256sum -c - \
    && unzip -q /tmp/op.zip op -d /out \
    && chmod 0755 /out/op \
    && rm -f /tmp/op.zip

FROM node:26.13.1-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git openssh-client procps tini \
    && rm -rf /var/lib/apt/lists/* \
    && userdel --remove node \
    && useradd --uid 1000 --user-group --home-dir /data/home --no-create-home --shell /bin/bash sail

COPY --from=rust /out/sail-boatd /opt/sail/bin/sail-boatd
COPY --from=op-cli /out/op /usr/local/bin/op
COPY --from=build /stage/node_modules /opt/sail/node_modules
COPY --from=build /src/apps/server/dist /opt/sail/server
COPY --from=rust /out/t3-resource-monitor /opt/sail/server/resource-monitor/t3-resource-monitor
COPY --chmod=0755 deploy/docker/entrypoint.sh /usr/local/bin/sail-entrypoint
# Sail's PATH points at directories sail can write, so only sail gets it: root keeps
# the image's PATH and its passwd HOME, and code that runs as root names commands by path.
COPY <<'EOF' /etc/sail/env.sh
export HOME=/data/home USER=sail LOGNAME=sail
export PATH=/data/home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EOF
# Root drops to sail before sail's environment applies, so no root process ever has sail's HOME.
COPY --chmod=0755 <<'EOF' /usr/local/bin/as-sail
#!/bin/sh
if [ "$(/usr/bin/id -u)" = 0 ]; then
  exec /usr/bin/setpriv --reuid=sail --regid=sail --init-groups --no-new-privs -- /usr/local/bin/as-sail "$@"
fi
. /etc/sail/env.sh
exec /usr/bin/setpriv --no-new-privs -- "$@"
EOF
COPY --chmod=0755 <<'EOF' /usr/local/bin/t3
#!/bin/sh
exec /usr/local/bin/as-sail /usr/local/bin/node /opt/sail/server/bin.mjs "$@"
EOF
# /etc/profile resets PATH for login shells, such as fly ssh console.
COPY <<'EOF' /etc/profile.d/sail-env.sh
[ "$(/usr/bin/id -u)" = 0 ] || . /etc/sail/env.sh
EOF
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

ENV SAIL_HOME=/data/sail \
    T3CODE_HOME=/data/sail \
    SAIL_STARTUP_PAIRING=off \
    SAIL_BOATD_PATH=/opt/sail/bin/sail-boatd \
    SHELL=/bin/bash \
    LANG=C.UTF-8
EXPOSE 8080
VOLUME /data
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sail-entrypoint"]
