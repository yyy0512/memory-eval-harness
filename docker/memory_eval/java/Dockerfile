FROM locobench-memory-eval:c

ENV DEBIAN_FRONTEND=noninteractive \
    MAVEN_OPTS=-Dmaven.repo.local=/root/.m2/repository

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openjdk-17-jdk-headless \
        maven \
    && rm -rf /var/lib/apt/lists/*
