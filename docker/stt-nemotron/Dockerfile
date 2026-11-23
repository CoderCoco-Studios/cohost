# @spec DEPLOY-ENG-002, DEPLOY-ENG-005
# NeMo-Speech.cpp serving Nemotron Speech Streaming. The source is fetched at the commit of
# tag v0.3.0 and built with the project's cuda-server preset (docs/build.md). The image is the build image itself: the
# server needs the CUDA toolkit's libraries at run time and the system curl for model downloads.
# Build the image on a host with the NVIDIA Container Toolkit; the first build takes several minutes.

FROM nvidia/cuda:12.8.2-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git cmake ninja-build pkg-config build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# NeMo-Speech.cpp v0.3.0, pinned to the commit the tag names
RUN git clone https://github.com/NVIDIA/NeMo-Speech.cpp.git /src && git -C /src checkout 20999cc921d2b14aa58708f61756a8b2e787ba20

WORKDIR /src
RUN git submodule update --init --recursive
RUN scripts/configure.sh cuda-server && cmake --build --preset cuda-server
RUN cmake --install build/cuda-server --prefix /opt/nemo-speech

ENV PATH=/opt/nemo-speech/bin:${PATH}
ENV LD_LIBRARY_PATH=/opt/nemo-speech/lib:/opt/nemo-speech/bin
EXPOSE 8080
