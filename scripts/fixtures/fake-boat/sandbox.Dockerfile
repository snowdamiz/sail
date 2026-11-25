ARG BASE=debian:bookworm
FROM node:26.13.1-bookworm-slim AS node

FROM ${BASE}
ENV container=docker
# Debian serves releases past their LTS only from archive.debian.org.
RUN . /etc/os-release && case "$VERSION_CODENAME" in buster|bullseye) \
    sed -i 's|deb.debian.org|archive.debian.org|' /etc/apt/sources.list ;; esac \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    systemd systemd-sysv dbus libpam-systemd sudo curl ca-certificates git procps \
    util-linux bsdutils socat bash libatomic1 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node

RUN systemctl mask \
    systemd-udevd.service systemd-udevd-control.socket systemd-udevd-kernel.socket \
    systemd-firstboot.service systemd-remount-fs.service systemd-modules-load.service \
    systemd-timesyncd.service getty.target console-getty.service \
    sys-kernel-debug.mount sys-kernel-tracing.mount sys-kernel-config.mount dev-hugepages.mount \
    proc-sys-fs-binfmt_misc.automount systemd-journald-audit.socket \
    apt-daily.timer apt-daily-upgrade.timer e2scrub_all.timer fstrim.timer

RUN useradd --create-home --uid 1000 --shell /bin/bash user \
  && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user \
  && chmod 440 /etc/sudoers.d/user \
  && mkdir -p /var/lib/systemd/linger /var/lib/fake-boat/outbox \
  && touch /var/lib/systemd/linger/user \
  && : > /etc/machine-id

COPY sandbox/ /opt/fake-boat/
RUN echo '{"type":"module"}' > /opt/fake-boat/package.json \
  && install -m 644 /opt/fake-boat/fake-boat.sh /etc/profile.d/fake-boat.sh \
  && install -m 644 /opt/fake-boat/fake-boat-host@.service /etc/systemd/system/fake-boat-host@.service \
  && for name in boat claude codex; do \
    printf '#!/bin/sh\nexec node /opt/fake-boat/%s.ts "$@"\n' "$name" > "/usr/local/bin/$name"; \
    chmod 755 "/usr/local/bin/$name"; \
  done

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
