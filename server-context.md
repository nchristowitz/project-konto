# Server Context for Konto Development

## Server

- **Provider:** Hetzner Cloud
- **Type:** cpx11 (2 vCPU, 4GB RAM)
- **OS:** Ubuntu 24.04
- **User:** `deploy` (has sudo and docker access)
- **SSH:** `ssh deploy@cloud.nicholaschristowitz.com`

## Domain & DNS

- **Registrar:** Infomaniak
- **Base domain:** `nicholaschristowitz.com`
- **Konto subdomain:** `money.nicholaschristowitz.com` (A record pointing to server IP)

Existing subdomains: `cloud.*`, `video.*`, `storage.*`

## File Layout on Server

```
~/services/
├── docker-compose.yml      # All services defined here
├── .env                    # All secrets
├── caddy/
│   └── Caddyfile           # Reverse proxy routing
├── garage/
│   └── garage.toml
├── dashboard/
│   └── index.html
├── sendrec/                # Existing app
└── konto/                  # ← Konto goes here
```

## Existing Services

| Service    | Internal Port | Notes                          |
|------------|---------------|--------------------------------|
| Caddy      | 80, 443       | Reverse proxy, auto SSL        |
| SendRec    | 8080          | Video recording app             |
| Garage     | 3900          | S3-compatible object storage    |
| PostgreSQL | 5432          | Shared database                 |

All services run via `docker compose` in `~/services/`. They share an `internal` Docker network.

## PostgreSQL

- PostgreSQL 16, running as a Docker container named `postgres`
- SendRec uses the default schema in a database (likely named `sendrec`)
- **Konto must use a dedicated `konto` schema** within the same database
- **Konto must use a dedicated `konto` database user** (not the SendRec user)
- Connection from Konto container: `postgresql://konto:<password>@postgres:5432/sendrec`

## Caddy

Caddyfile location: `~/services/caddy/Caddyfile`

To add Konto, append:
```
money.nicholaschristowitz.com {
    reverse_proxy konto:3000
}
```

Reload after changes: `docker compose restart caddy`

## Environment Variables

All secrets go in `~/services/.env`. Konto-specific vars should be prefixed with `KONTO_`:

```
KONTO_DB_PASSWORD=<generate>
KONTO_SESSION_SECRET=<generate>
KONTO_ADMIN_USERNAME=nicholas
KONTO_ADMIN_PASSWORD_HASH=<bcrypt hash>
KONTO_SMTP_USER=hello@nicholaschristowitz.com
KONTO_SMTP_PASS=<google app password>
KONTO_EMAIL_FROM=Nicholas Christowitz <hello@nicholaschristowitz.com>
```

## Docker Compose Pattern

New services follow this pattern in `docker-compose.yml`:

```yaml
  konto:
    build: ./konto
    container_name: konto
    restart: unless-stopped
    environment:
      - DATABASE_URL=postgresql://konto:${KONTO_DB_PASSWORD}@postgres:5432/sendrec
      - DB_SCHEMA=konto
      # ... other env vars
    volumes:
      - konto-data:/app/data
    depends_on:
      - postgres
    networks:
      - internal
```

Volumes declared at the bottom of docker-compose.yml. The `internal` network already exists.

## Key Commands

```bash
cd ~/services
docker compose up -d              # Start all services
docker compose up -d --build      # Rebuild and start
docker compose logs konto -f      # Follow Konto logs
docker compose restart caddy      # Reload Caddy after config change
docker compose ps                 # Check status
```
