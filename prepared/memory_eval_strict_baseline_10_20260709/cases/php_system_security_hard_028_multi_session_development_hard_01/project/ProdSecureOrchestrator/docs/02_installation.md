```markdown
# ProdSecure Orchestrator – Installation Guide
This document describes several supported ways to install **ProdSecure Orchestrator** in development, staging, and production environments.  
For additional information on architecture and contribution guidelines see `docs/01_introduction.md` and `CONTRIBUTING.md`.

---

## 1. System Requirements

| Component            | Recommended (Prod)                                                             | Minimum (Dev)                 |
|----------------------|--------------------------------------------------------------------------------|-------------------------------|
| PHP                  | 8.2 (FPM) with Zend OPcache, JIT disabled                                      | 8.1                           |
| Web Server           | Nginx 1.22 (or newer) / Apache 2.4 (with `mod_proxy_fcgi`)                     | Any modern Nginx/Apache       |
| Database             | PostgreSQL 14 / MySQL 8 / MariaDB 10.6 (tested on Postgres)                    | SQLite 3.39                   |
| Message Broker       | Redis 7 (preferred), RabbitMQ 3.11                                             | Redis 6                       |
| Search / Analytics   | OpenSearch 2.x / Elasticsearch 8.x                                             | —                             |
| OS                   | Debian 12, Ubuntu 22.04, RHEL 9, AlmaLinux 9, macOS 13                         | Any recent Linux/macOS        |
| Optional             | Consul 1.15 / Hashicorp Nomad 1.5, Envoy 1.27 (Service Mesh)                   | —                             |

*Memory*: 2 GB (dev) / 8 GB (prod)  
*CPU*: 2 vCPU (dev) / 4 vCPU (prod)

> ℹ️  All first-party extensions are distributed under the MIT license. Third-party dependencies retain their respective licenses.

---

## 2. Quick-Start (Docker Compose)

Ideal for evaluation and local development.

```bash
git clone https://github.com/prodsecure/orchestrator.git ps-orchestrator
cd ps-orchestrator

# Copy sample environment
cp .env.example .env

# Spin up the stack
docker compose --profile=full up -d --build

# Tail the orchestrator logs
docker compose logs -f orchestrator-app
```

Available service profiles:

| Profile     | Components                                                     |
|-------------|----------------------------------------------------------------|
| `tiny`      | PHP-FPM + Nginx + SQLite                                       |
| `dev`       | PHP-FPM + Nginx + PostgreSQL + Redis + MailHog                 |
| `full`      | Everything in `dev` + OpenSearch + Logstash + Konsumer workers |

After the containers are healthy, navigate to <http://localhost:8080>.  
Default credentials are printed to the log on first boot.

---

## 3. Production Installation (Bare-Metal / VM)

### 3.1 Create a Dedicated System User

```bash
sudo adduser --system --group --home /opt/prodsecure orchestrator
```

### 3.2 Obtain the Source

```bash
sudo -u orchestrator -H git clone --depth=1 \
  https://github.com/prodsecure/orchestrator.git /opt/prodsecure
cd /opt/prodsecure
```

### 3.3 Install PHP Dependencies

```bash
curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
sudo -u orchestrator -H composer install --no-dev --optimize-autoloader
```

> 🛡️  The `--no-dev` and `--optimize-autoloader` flags are mandatory in production.

### 3.4 Install Node / Front-End Assets (Optional UI)

```bash
sudo -u orchestrator -H corepack enable
sudo -u orchestrator -H pnpm install --frozen-lockfile
sudo -u orchestrator -H pnpm run build
```

### 3.5 Configure Environment

```bash
sudo -u orchestrator -H cp .env.example .env
sudo -u orchestrator -H php artisan key:generate   # Laravel-style helper
sudo -u orchestrator -H php artisan secure:secret  # Generates JWT & encryption keys
```

Key environment variables:

```dotenv
APP_ENV=production
APP_DEBUG=false
APP_URL=https://secure.example.com

DB_CONNECTION=pgsql
DB_HOST=127.0.0.1
DB_PORT=5432
DB_DATABASE=prodsecure
DB_USERNAME=orchestrator
DB_PASSWORD=strong_password

REDIS_HOST=127.0.0.1
REDIS_PORT=6379

BROADCAST_DRIVER=log
CACHE_DRIVER=redis
QUEUE_CONNECTION=redis
SESSION_DRIVER=redis
```

### 3.6 Database Migration & Seeding

```bash
sudo -u orchestrator -H php bin/console doctrine:migrations:migrate --no-interaction
sudo -u orchestrator -H php bin/console app:seed --fixtures=baseline
```

### 3.7 Configure Process Supervisor

#### systemd unit for PHP-FPM pool (stand-alone workers)

```ini
# /etc/systemd/system/orchestrator-queue.service
[Unit]
Description=ProdSecure Orchestrator – Queue Worker
After=network.target redis.service

[Service]
Type=simple
User=orchestrator
Group=orchestrator
WorkingDirectory=/opt/prodsecure
ExecStart=/usr/bin/php artisan queue:work redis --sleep=3 --tries=3 --max-time=3600
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orchestrator-queue.service
```

#### Scheduler (CRON)

```cron
* * * * * orchestrator /usr/bin/php /opt/prodsecure/artisan schedule:run >> /var/log/prodsecure/schedule.log 2>&1
```

### 3.8 Nginx VirtualHost (fastcgi_pass)

```nginx
server {
    listen 80;
    server_name secure.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name secure.example.com;

    ssl_certificate     /etc/letsencrypt/live/secure.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/secure.example.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;

    root /opt/prodsecure/public;
    index index.php;

    access_log  /var/log/nginx/orchestrator.access.log;
    error_log   /var/log/nginx/orchestrator.error.log;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \.php$ {
        fastcgi_pass unix:/var/run/php/php-fpm.sock;
        fastcgi_index  index.php;
        include        fastcgi_params;
        fastcgi_param  SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
}
```

### 3.9 Service Mesh (Optional)

If you leverage Consul/Envoy, register the orchestrator API service:

```hcl
# /etc/consul.d/orchestrator.hcl
service {
  name = "orchestrator-api"
  id   = "orchestrator-api-1"
  port = 9000

  meta = {
    version = "1.6.0"
    environment = "production"
  }

  connect {
    sidecar_service {}
  }

  check {
    id       = "health-api"
    name     = "Orchestrator API health"
    http     = "http://localhost:9000/health"
    interval = "10s"
    timeout  = "2s"
  }
}
```

Apply:

```bash
consul reload
```

---

## 4. Upgrade Procedure

1. Backup the database and `.env`:
   ```bash
   pg_dump -Fc prodsecure > /backups/prodsecure-$(date +%F).dump
   ```
2. Place the system in maintenance mode:
   ```bash
   php artisan down --message="Upgrading to v1.7.0" --retry=60
   ```
3. Pull new code and dependencies:
   ```bash
   git fetch --tags
   git checkout v1.7.0
   composer install --no-dev --optimize-autoloader
   ```
4. Run migrations:
   ```bash
   php artisan migrate --force
   ```
5. Warm caches & restart workers:
   ```bash
   php artisan config:cache
   php artisan route:cache
   systemctl restart orchestrator-queue.service
   ```
6. Bring application back up:
   ```bash
   php artisan up
   ```

---

## 5. Uninstall

```bash
sudo systemctl disable --now orchestrator-queue.service
sudo rm /etc/systemd/system/orchestrator-queue.service
sudo rm -rf /opt/prodsecure
sudo deluser orchestrator --remove-home
```

---

## 6. Troubleshooting

| Symptom                                     | Possible Cause                       | Resolution                               |
|---------------------------------------------|--------------------------------------|------------------------------------------|
| `500 Internal Server Error` on login        | Wrong `APP_KEY` or `APP_URL`         | Regenerate key, clear caches             |
| Queue workers exit with `OOMKilled`         | Memory limit too low                 | Increase `memory_limit` or scale workers |
| Health check returns `db_ping_failed`       | DB credentials incorrect             | Verify `.env`                            |
| Slow dashboard (>5 s)                       | Search backend not reachable         | Check OpenSearch status                  |
| Alert duplicate flooding                    | Multiple message brokers configured  | Use a single, consistent broker          |

Use the built-in diagnostics:

```bash
php artisan orchestrator:doctor
```

The command will run >40 health checks and print actionable remediation steps.

---

## 7. Need Help?

• Issues: <https://github.com/prodsecure/orchestrator/issues>  
• Email: security@prodsecure.io  
• Slack: `#prodsecure-community`

---
© 2024 ProdSecure Inc. – All rights reserved.
```