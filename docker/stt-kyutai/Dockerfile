# @spec DEPLOY-ENG-003, DEPLOY-ENG-006
# moshi-server serving Kyutai STT. The crate is installed from crates.io at exactly 0.6.4 with
# the lockfile the crate ships, with CUDA support, on the CUDA 12.8 development image; the server reads stt.toml beside this file.
# Build the image on a host with the NVIDIA Container Toolkit; compiling moshi-server takes several minutes.

FROM nvidia/cuda:12.8.2-devel-ubuntu24.04

# bindgen_cuda (a build dependency of the CUDA kernels) reads the GPU compute capability from this variable instead of running
# nvidia-smi, which is absent at image build time. 120 is the RTX 50-series (Blackwell) capability.
ARG CUDA_COMPUTE_CAP=120
ENV CUDA_COMPUTE_CAP=${CUDA_COMPUTE_CAP}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl build-essential pkg-config libssl-dev python3 python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Rust 1.100.0, the stable channel's version on 2026-11-23, minimal profile
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:${PATH}
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain 1.100.0

RUN cargo install --locked --version =0.6.4 --features cuda moshi-server --root /usr/local

COPY stt.toml /etc/moshi/stt.toml
RUN mkdir -p /opt/moshi/static /var/log/moshi
EXPOSE 8080
