FROM php:8.3-cli-bookworm

ENV COMPOSER_ALLOW_SUPERUSER=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        libicu-dev \
        libonig-dev \
        libpq-dev \
        libsqlite3-dev \
        libxml2-dev \
        libzip-dev \
        nodejs \
        npm \
        unzip \
    && docker-php-ext-install -j2 intl mbstring pdo_mysql pdo_pgsql pdo_sqlite zip \
    && pecl install redis \
    && docker-php-ext-enable redis \
    && rm -rf /var/lib/apt/lists/* /tmp/pear

COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

RUN curl -fsSL https://phar.phpunit.de/phpunit-9.6.29.phar -o /usr/local/bin/phpunit \
    && chmod +x /usr/local/bin/phpunit \
    && npm install --global cross-env vitest
