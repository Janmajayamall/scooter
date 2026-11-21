# Scooter's image: one image for both services, `bridge` and `runner`, which
# compose.yaml runs. It builds for the machine's own architecture, amd64 or arm64.
#
# - wacli is built from source in the first stage, so it always matches the architecture.
# - restic comes from its release, checked against the checksum the release's SHA256SUMS gives,
#   which is written here.
# - QEMU and the tools build-image needs: cpio, lz4 and e2fsprogs.
# - Scooter's three users, at fixed uids, so that the files of the data volume are theirs in every
#   container.
# - The data folder, /data, with its folders' owners and modes: a new volume mounted there starts
#   as a copy of it.
# - The app, with its dependencies installed without their install scripts. pi isn't here: it is in
#   the VM image, which build-image builds into the data volume.

# --- wacli, from source ---
FROM golang:1.27-trixie AS wacli
ARG WACLI_VERSION=0.26.0
RUN CGO_ENABLED=1 CGO_CFLAGS="-Wno-error=missing-braces" \
    go install -tags sqlite_fts5 -trimpath -ldflags="-s -w" "github.com/openclaw/wacli/cmd/wacli@v${WACLI_VERSION}"

# --- the runtime ---
FROM node:24-trixie-slim
ARG TARGETARCH
ARG RESTIC_VERSION=0.19.1
ARG RESTIC_SHA256_AMD64=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c
ARG RESTIC_SHA256_ARM64=a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465

# The runtime's packages, QEMU for this architecture, and qemu-utils, whose qemu-img Gondolin runs.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) qemu=qemu-system-x86 ;; \
      arm64) qemu=qemu-system-arm ;; \
      *) echo "Scooter's image builds for amd64 or arm64, not $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl bzip2 git tini tzdata cpio lz4 e2fsprogs "$qemu" qemu-utils; \
    rm -rf /var/lib/apt/lists/*

# restic, checked against its release's checksum.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) sum="$RESTIC_SHA256_AMD64" ;; \
      arm64) sum="$RESTIC_SHA256_ARM64" ;; \
    esac; \
    file="restic_${RESTIC_VERSION}_linux_${TARGETARCH}.bz2"; \
    cd /tmp; \
    curl -fsSLO "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${file}"; \
    echo "${sum}  ${file}" | sha256sum -c -; \
    bunzip2 "$file"; \
    install -m 0755 "${file%.bz2}" /usr/local/bin/restic; \
    rm -f "${file%.bz2}"

COPY --from=wacli /go/bin/wacli /usr/local/bin/wacli

# Scooter's users, without a login shell or a home, as `setup` makes them natively, at their
# fixed uids.
RUN set -eu; \
    for user in scooter-wacli:10001 scooter-runner:10002 scooter-mail:10003; do \
      name="${user%%:*}"; id="${user##*:}"; \
      groupadd --system --gid "$id" "$name"; \
      useradd --system --uid "$id" --gid "$id" --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --comment Scooter "$name"; \
    done

# The data folder, with its folders' owners and modes, as `setup` makes it natively (`dataFolders`
# in src/ops/setup.mjs, which a test holds this list to), and the config folder's mount point.
RUN set -eu; \
    install -d -o root -g root -m 0755 /data; \
    install -d -o root -g scooter-runner -m 0750 /data/datastore; \
    install -d -o scooter-runner -g scooter-runner -m 0700 /data/agents /data/exchange /data/exchange/outbox /data/exchange/locks /data/runner; \
    install -d -o root -g root -m 0700 /data/bridge; \
    install -d -o scooter-wacli -g scooter-wacli -m 0700 /data/wacli /data/wacli/store /data/wacli/staging /data/wacli/config /data/wacli/state /data/wacli/cache; \
    install -d -o scooter-mail -g scooter-mail -m 0700 /data/mail /data/mail/spool; \
    install -d -o root -g root -m 0755 /config

# The app, root's, readable by every user and writable by root alone, whatever modes the checkout
# gave it: a checkout made under umask 077 would otherwise leave scooter-runner and scooter-mail
# unable to read it.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src ./src
RUN chmod -R a+rX,go-w /app

# The services run in UTC, as the systemd units do.
ENV TZ=UTC
ENTRYPOINT ["tini", "--", "node", "/app/src/cli.mjs"]
CMD ["help"]
