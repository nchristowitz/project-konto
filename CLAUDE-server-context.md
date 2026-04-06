# Server Context for Claude Code

## Infrastructure

- **Server:** Hetzner Cloud cpx11 (2 vCPU, 4GB RAM), Ubuntu 24.04, Nuremberg
- **SSH:** `ssh deploy@cloud.nicholaschristowitz.com` (deploy user has sudo + docker access)
- **DNS/Domains:** Managed at Infomaniak. All subdomains are A records pointing to the server IP.
- **Domain:** `nicholaschristowitz.com`

## Server Layout

Everything lives under `~/services/` on the server:

```
~/services/
├── docker-compose.yml      # All services defined here
├── .env                    # All secrets (DB passwords, API keys, SMTP creds, etc.)
├── caddy/
│   └── Caddyfile           # Reverse proxy routing rules
├── garage/
│   └── garage.toml         # Garage S3 config
├── sendrec/                # SendRec app (Loom alternative)
├── konto/                  # Invoicing app (if deploying Konto)
└── dashboard/
    └── index.html          # Dashboard page
```

## Stack

| Component | Role |
|-----------|------|
| **Caddy** | Reverse proxy + automatic HTTPS (ports 80, 443) |
| **PostgreSQL 16** | Shared database (apps use separate schemas) |
| **Garage** | S3-compatible object storage (replaced MinIO, AGPLv3) |
| **Docker Compose** | Orchestrates everything |

## Active Subdomains

| Subdomain | Service | Internal Port |
|-----------|---------|---------------|
| `cloud.nicholaschristowitz.com` | Dashboard (basic auth) | static files via Caddy |
| `video.nicholaschristowitz.com` | SendRec | 8080 |
| `storage.nicholaschristowitz.com` | Garage S3 API | 3900 |
| `money.nicholaschristowitz.com` | Konto (invoicing) | 3000 |

## How to Deploy a New App

### 1. Add DNS record
At Infomaniak: create an A record for `yourapp.nicholaschristowitz.com` → server IP.

### 2. Add Caddy route
In `~/services/caddy/Caddyfile`:
```
yourapp.nicholaschristowitz.com {
    reverse_proxy yourapp:3000
}
```
Caddy handles SSL automatically — no cert config needed.

### 3. Add service to docker-compose.yml
```yaml
  yourapp:
    build: ./yourapp
    container_name: yourapp
    restart: unless-stopped
    environment:
      - DATABASE_URL=postgresql://yourapp:${YOURAPP_DB_PASSWORD}@postgres:5432/sendrec
      - DB_SCHEMA=yourapp
      # ... other env vars
    volumes:
      - yourapp-data:/app/data
    depends_on:
      - postgres
    networks:
      - internal

volumes:
  yourapp-data:
```

### 4. Add secrets to .env
Add any `YOURAPP_*` environment variables to `~/services/.env`.

### 5. Create Postgres user + schema
```bash
docker exec -ti postgres psql -U postgres
```
```sql
CREATE USER yourapp WITH PASSWORD 'generated-password';
CREATE SCHEMA yourapp AUTHORIZATION yourapp;
GRANT USAGE ON SCHEMA yourapp TO yourapp;
-- If sharing the existing DB:
ALTER DEFAULT PRIVILEGES IN SCHEMA yourapp GRANT ALL ON TABLES TO yourapp;
```

### 6. Deploy
```bash
cd ~/services
docker compose up -d --build
```

## Key Commands

```bash
cd ~/services
docker compose ps                    # Check status
docker compose up -d                 # Start all (required when adding new volumes/services)
docker compose up -d --build         # Rebuild after code changes
docker compose restart caddy         # Restart single service
docker compose logs yourapp --tail 50  # View logs
docker compose logs -f               # Follow all logs
docker compose down                  # Stop all
```

**Important:** `docker compose up -d` (not `restart`) is required when adding new volume mounts or services. A restart alone won't apply them.

## Database Convention

All apps share the same PostgreSQL instance but use **separate schemas** for isolation:
- SendRec → default schema
- Konto → `konto` schema
- New apps → their own schema

## Secrets

- **Never put secrets in code or chat.** They go in `~/services/.env` on the server.
- Credentials for the dashboard are bcrypt hashes in the Caddyfile.
- Google App Passwords are used for SMTP (Gmail/Workspace).

## Backups

- Database: `pg_dump` to Hetzner Storage Box (u545394) before migrations
- Photos: rsync over SSH (port 23) to Storage Box
- PDF/file volumes: should be included in backup routine

## Constraints & Preferences

- **No heavyweight dependencies** — avoid Puppeteer/Chromium, prefer lightweight alternatives
- **No CI/CD** — local dev → GitHub Desktop → manual deploy to server
- **EU-based providers only** where possible
- **Docker Compose for everything** — explicit config over automation magic
- **Fragile build toolchains** (e.g., legacy Node versions) should run in disposable Docker containers
- **Security:** incremental hardening (non-root containers, `no-new-privileges`, proper volume scoping)
