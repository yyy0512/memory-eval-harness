FROM locobench-memory-eval:c

ENV CARGO_HOME=/root/.cargo \
    PATH=/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends cargo rustc \
    && rm -rf /var/lib/apt/lists/* \
    && rustc --version \
    && cargo --version
