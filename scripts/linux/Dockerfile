# Build against the oldest supported Linux userspace: Ubuntu 22.04 / Mint 21.
FROM ubuntu:22.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl ca-certificates python3 python3-pip pkg-config \
    libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
    file xz-utils xvfb xauth dbus-x11 xdotool imagemagick \
    && rm -rf /var/lib/apt/lists/*
ARG NODE_VERSION=20.19.0
RUN curl -fsSLO https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
    && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt -o node-checksums \
    && grep " node-v${NODE_VERSION}-linux-x64.tar.xz$" node-checksums | sha256sum -c - \
    && tar -xJf node-v${NODE_VERSION}-linux-x64.tar.xz -C /usr/local --strip-components=1 \
    && rm node-v${NODE_VERSION}-linux-x64.tar.xz node-checksums
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal && rm /tmp/rustup.sh
ENV PATH="/root/.cargo/bin:${PATH}"
RUN python3 -m pip install --no-cache-dir uv && uv python install 3.12
WORKDIR /work
