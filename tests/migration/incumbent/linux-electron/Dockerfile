FROM node:26.13.1-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS replay
FROM debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0

COPY --from=replay /usr/local/bin/node /usr/local/bin/node
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl python3 python3-websocket sqlite3 git procps \
        xvfb xauth dbus-x11 x11-utils xdotool scrot fonts-dejavu-core libatomic1 \
        libgtk-3-0t64 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0t64 \
        libuuid1 libsecret-1-0 libgbm1 libasound2t64 libdrm2 libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1501 sailfixture
