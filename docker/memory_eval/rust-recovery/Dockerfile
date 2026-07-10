FROM rust:1.85.1-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/root/.cargo

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        pkg-config \
        libssl-dev \
        clang \
        cmake \
        nodejs \
        npm \
    && npm install --global jest@29.7.0 vitest@2.1.4 cross-env@7.0.3 \
    && rm -rf /var/lib/apt/lists/*
