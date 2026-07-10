FROM locobench-memory-eval:c

ENV DEBIAN_FRONTEND=noninteractive \
    COMPOSER_ALLOW_SUPERUSER=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        php-cli \
        phpunit \
        composer \
        php-curl \
        php-mbstring \
        php-xml \
        php-sqlite3 \
        php-mysql \
        php-pgsql \
        php-redis \
    && rm -rf /var/lib/apt/lists/*
