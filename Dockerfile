# syntax=docker/dockerfile:1

# BINARY_STAGE selects how the phase-server binary arrives in the runtime image:
#   - "compile"  (default): cross-compile from source on the BUILD host for each
#     requested platform, so one plain
#       docker buildx build --platform linux/amd64,linux/arm64 .
#     yields a multi-arch image with no emulated cargo run.
#   - "prebuilt": copy ./phase-server-<amd64|arm64> (static musl binaries built
#     outside Docker with a warm cargo cache) from the build context; the image
#     build is then just apt + COPY. Used by release.yml and deploy.yml.
#
# PHASE_CHANNEL (compile stage only; e.g. "release", as release.yml sets for
# its native builds) bakes the data-manifest identity into the binary so an
# empty PHASE_DATA_DIR self-bootstraps card data on first boot. Unset = no
# identity: such an image needs PHASE_DATA_MANIFEST_URL or pre-provisioned data.
ARG BINARY_STAGE=compile

# FRONTEND_STAGE selects whether the runtime image also serves the web client:
#   - "frontend" (default): build client/dist inside the image (engine WASM +
#     Vite bundle) and ship it, so ONE container answers the app, its card data
#     and /ws on a single origin and a single port. No static sidecar, no init
#     container staging a dist artifact, no second origin to keep in step.
#   - "no-frontend": the server alone, for deployments that already front it
#     with their own static host. release.yml and deploy.yml pass this: those
#     workflows build and publish the very same bundle to Cloudflare Pages, so
#     rebuilding it here would only duplicate CI time.
ARG FRONTEND_STAGE=frontend

FROM --platform=$BUILDPLATFORM rust:slim-bookworm AS compile
ARG TARGETARCH
ARG PHASE_CHANNEL

# zig is the C cross-compiler/linker for the musl targets (ring, bundled
# SQLite, mimalloc). It runs on any build host, unlike per-target gcc tarballs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --break-system-packages --no-cache-dir cargo-zigbuild==0.23.0 ziglang==0.16.0

WORKDIR /app

COPY . .

# -p scopes feature unification to phase-server's own graph: unscoped, the
# workspace unifies feed-scraper's native-tls reqwest features in, dynamically
# linking OpenSSL — which the musl target and the slim runtime image lack.
# Every cache is keyed per arch: a multi-platform build runs both legs
# concurrently, and cargo's package-cache lock lives in $CARGO_HOME itself
# (outside these mounts), so two legs sharing one registry dir race on
# unpacking crates (measured: "failed to unpack package … File exists").
# BuildKit's default 1024-fd soft limit is too low for zig/lld to link the
# final binary (ProcessFdQuotaExceeded); the hard limit is far higher.
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=phase-server-cargo-registry-$TARGETARCH \
    --mount=type=cache,target=/usr/local/cargo/git,id=phase-server-cargo-git-$TARGETARCH \
    --mount=type=cache,target=/app/target,id=phase-server-target-$TARGETARCH \
    ulimit -n 65536 \
    && case "$TARGETARCH" in \
      amd64) TARGET=x86_64-unknown-linux-musl ;; \
      arm64) TARGET=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac \
    && rustup target add "$TARGET" \
    && ${PHASE_CHANNEL:+env PHASE_CHANNEL="$PHASE_CHANNEL"} \
       cargo zigbuild -p phase-server --profile server-release --bin phase-server --target "$TARGET" \
    && cp "target/$TARGET/server-release/phase-server" /phase-server

# Prebuilt path: expects ./phase-server-<arch> (static musl) in the build
# context for every platform being built. Only evaluated when
# BINARY_STAGE=prebuilt; otherwise BuildKit skips it.
FROM scratch AS prebuilt
ARG TARGETARCH
COPY phase-server-${TARGETARCH} /phase-server

# The client bundle is architecture-independent, so it is built once on the
# BUILD host and copied into every platform leg of the runtime image — a
# multi-platform build never runs Vite or wasm-bindgen under emulation.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS frontend

# Vite reads these at build time (see client/vite.config.ts). The defaults are
# the same public data bucket the official build uses, so a plain
# `docker buildx build .` yields a working app. `card-data.json` is deliberately
# NOT among them: no unhashed copy exists in that bucket, and the server already
# keeps a current one in PHASE_DATA_DIR and serves it at the site root.
ARG DATA_BASE_URL=https://data.phase-rs.dev
ARG AUDIO_BASE_URL=https://data.phase-rs.dev/audio
# Point this at your own `wss://host/ws` to make it the bundle's default (and
# first-listed) server. Unset leaves the public lobby as the default pick.
ARG DEFAULT_MULTIPLAYER_SERVER_URL

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@9.15.9 \
    && curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
ENV PATH=/root/.cargo/bin:$PATH

WORKDIR /app

# rust-toolchain.toml on its own first: any cargo call in a directory holding
# one makes rustup install exactly that pin (here: the nightly and its
# wasm32-unknown-unknown target), and doing it in its own layer means the
# toolchain survives every source edit.
COPY rust-toolchain.toml ./
RUN cargo --version && rustup target list --installed

# wasm-bindgen-cli must match the wasm-bindgen crate version Cargo.lock resolves
# to; a mismatch aborts the bind step with an explicit version error rather than
# producing a subtly wrong glue file.
ARG WASM_BINDGEN_VERSION=0.2.121
RUN --mount=type=cache,target=/root/.cargo/registry,id=phase-frontend-cargo-registry \
    --mount=type=cache,target=/root/.cargo/git,id=phase-frontend-cargo-git \
    --mount=type=cache,target=/tmp/wasm-bindgen-target,id=phase-frontend-wasm-bindgen-target \
    CARGO_TARGET_DIR=/tmp/wasm-bindgen-target \
    cargo install wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION" --locked

COPY . .

# No wasm-opt: build-wasm.sh treats it as optional (size only), and Debian's
# binaryen trails this toolchain's LLVM far enough that installing it would
# trade a smaller bundle for an unverifiable rewrite of the shipped engine.
RUN --mount=type=cache,target=/root/.cargo/registry,id=phase-frontend-cargo-registry \
    --mount=type=cache,target=/root/.cargo/git,id=phase-frontend-cargo-git \
    --mount=type=cache,target=/app/target,id=phase-frontend-wasm-target \
    ./scripts/build-wasm.sh release

RUN --mount=type=cache,target=/pnpm-store,id=phase-frontend-pnpm-store \
    cd client \
    && pnpm install --frozen-lockfile --store-dir /pnpm-store \
    && pnpm build \
    && mv dist /dist

# Server-only image: an empty bundle directory. The entrypoint keys static
# hosting off index.html, so this simply leaves PHASE_STATIC_DIR unset.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS no-frontend
RUN mkdir -p /dist

# Resolve each selection to a single stage name the runtime copies from.
FROM ${BINARY_STAGE} AS binary
FROM ${FRONTEND_STAGE} AS client-bundle

FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system phase \
    && useradd --system --gid phase --home-dir /var/lib/phase-server --shell /usr/sbin/nologin phase

COPY --from=binary /phase-server /usr/local/bin/phase-server
COPY docker/phase-server-entrypoint.sh /usr/local/bin/phase-server-entrypoint
COPY --from=client-bundle /dist /srv/phase-client

RUN mkdir -p /var/lib/phase-server \
    && chown -R phase:phase /var/lib/phase-server \
    && chmod +x /usr/local/bin/phase-server /usr/local/bin/phase-server-entrypoint

ENV PORT=9374
ENV PHASE_DATA_DIR=/var/lib/phase-server
ENV RUST_LOG=info

# One port for everything: the app, /health, /ws, and the data files the app
# fetches all answer here.
EXPOSE 9374

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD sh -c 'curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null'

ENTRYPOINT ["phase-server-entrypoint"]
CMD ["phase-server"]
