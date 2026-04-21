# Authelia OIDC on Cloudflare Containers

Self-hosted OIDC identity provider for Cloudflare Access using Authelia on Cloudflare Containers and LLDAP on a remote VM. Includes R2-backed SQLite persistence, native TOTP + passkey support, and transactional email via Cloudflare Email Sending.

## Architecture

```
                        Cloudflare                                     Remote VM
 +---------------------------------------------------------------+     +------------------+
 |                                                               |     |                  |
 |   auth.example.com                                            |     |   LLDAP          |
 |   +--------+     +-----------+     +----------+               |     |   :3890 (LDAP)   |
 |   | Worker |---->| Container |---->| Authelia  |-------LDAP---+---->|   :17170 (HTTP)  |
 |   +---+----+     +-----+-----+     | :9091     |              |     |                  |
 |       |                |           +----------+               |     +--------+---------+
 |       | SEND_EMAIL     | snapshot  notification.txt            |              |
 |       v                v           ^                           |              |
 |   CF Email         R2 bucket       | notif-forwarder           |              |
 |   Sending          authelia-db     | (tail + POST)             |              |
 |                                                                |              |
 |   ldap.example.com                                             |              |
 |   +-------------------+     +-------------------+              |              |
 |   | Cloudflare Proxy  |---->| Tunnel (cloudflared) |-----------+--------------+
 |   +-------------------+     +-------------------+              |
 |                                                                |
 +----------------------------------------------------------------+

 LDAP:       lldap-direct.example.com:3890 (non-proxied A record, FW to CF IPs)
 Admin UI:   ldap.example.com (proxied CNAME -> tunnel)
 Auth:       auth.example.com (custom domain -> Worker)
 Workers.dev: <worker>.<account>.workers.dev (used by container for self-callbacks)
```

**Authelia** runs in a Cloudflare Container behind a Worker. It handles the OIDC authorization code flow, native TOTP enrollment, and WebAuthn/passkey registration and login. Authentication is against LLDAP over a non-proxied DNS record firewalled to Cloudflare IP ranges.

**LLDAP** runs on a remote VM (e.g. DigitalOcean). Its admin UI is exposed via a Cloudflare Tunnel. Users and groups are managed through the LLDAP web interface and are immediately available in Authelia.

**The Worker** proxies requests to Authelia and performs three jobs:

1. **ID token enrichment** — intercepts `/api/oidc/token`, calls Authelia's userinfo endpoint, merges email + groups into the ID token, and re-signs the JWT with the same RSA key. Required because Authelia v4.39 only returns those claims via userinfo, but Cloudflare Access needs them in the ID token.
2. **SQLite snapshot backend** — `GET /_snap/restore` and `PUT /_snap/save` (token-authenticated) back the container's SQLite DB to an R2 bucket. The container restores on cold start and pushes updates every 60 seconds, surviving container sleep and rollouts.
3. **Email relay** — `POST /_send` accepts parsed Authelia notifications and forwards them through the Cloudflare Email Sending `SEND_EMAIL` Worker binding.

**The container entrypoint** runs Authelia plus two background loops: the snapshot pusher and a notification forwarder that watches `/data/notification.txt` mtime and POSTs each new block to the Worker's `/_send` endpoint.

Container → Worker callbacks use the **workers.dev** subdomain to bypass the zone's bot-management challenges, which reject scripted requests to the custom domain.

## Prerequisites

- Cloudflare account with Workers, Containers, R2, and Cloudflare Email Sending enabled
- Remote VM with Docker and `cloudflared` installed
- Docker CLI on your local machine (for container image builds)
- `ssh-ed25519` key pair for container SSH debugging

## Setup

### 1. Generate secrets

```sh
# RSA key for OIDC JWT signing
openssl genrsa 4096 > authelia/private.pem

# Random secrets (storage encryption, session, HMAC, LDAP password)
openssl rand -hex 32  # repeat for each secret

# Bcrypt hash for the OIDC client secret
python3 -c "import bcrypt; print(bcrypt.hashpw(b'YOUR_CLIENT_SECRET', bcrypt.gensalt(12)).decode())"
```

### 2. Configure Authelia

Copy `authelia/configuration.yml.example` to `authelia/configuration.easydemo.yml` (or any environment name — the file is gitignored) and fill in:
- All `CHANGE_ME_*` placeholder values
- RSA private key in the `jwks` block
- LDAP bind password
- OIDC client secret (bcrypt hash) and Cloudflare Access callback URL
- Your domain in `totp.issuer`, `session.cookies[0].domain`, and `session.cookies[0].authelia_url`

Native 2FA options (TOTP + WebAuthn/passkey) are enabled in the template; see the `totp:` and `webauthn:` blocks.

### 3. Create Cloudflare Tunnel

```sh
# Via API or dashboard — create a tunnel and configure ingress:
#   ldap.your-domain.com -> http://localhost:17170
# Note the tunnel token for the VM setup.
```

### 4. Set up LLDAP on the VM

```sh
docker run -d --name lldap --restart unless-stopped \
  -p 127.0.0.1:3890:3890 \
  -p 127.0.0.1:17170:17170 \
  -v /opt/lldap/data:/data \
  -e LLDAP_LDAP_BASE_DN=dc=example,dc=com \
  -e LLDAP_LDAP_USER_DN=admin \
  -e LLDAP_LDAP_USER_EMAIL=admin@example.com \
  -e LLDAP_LDAP_USER_PASS=YOUR_PASSWORD \
  -e LLDAP_JWT_SECRET=YOUR_JWT_SECRET \
  lldap/lldap:latest

cloudflared service install YOUR_TUNNEL_TOKEN
```

Pre-create `/opt/lldap/data` with ownership `1000:1000` and a minimal `lldap_config.toml`:
```toml
database_url = "sqlite:///data/users.db?mode=rwc"
key_file = "/data/server_key"
```

### 5. Create DNS records

| Record | Type | Proxied | Target |
|--------|------|---------|--------|
| `ldap` | CNAME | Yes | `<tunnel-id>.cfargotunnel.com` |
| `lldap-direct` | A | No | VM public IP |

`auth.<domain>` is provisioned automatically by Wrangler when the Worker is deployed with a `custom_domain` route. Firewall `lldap-direct` port 3890 to [Cloudflare IP ranges](https://www.cloudflare.com/ips/) only.

### 6. Configure `wrangler.jsonc`

Copy `wrangler.jsonc.example` to `wrangler.jsonc` (gitignored) and fill in your account ID, workers.dev URL, sender domain, SSH public key, and custom domain.

### 7. Provision Cloudflare resources

```sh
npm install

# R2 bucket for SQLite snapshots
npx wrangler r2 bucket create authelia-db

# Shared token between Worker and container for /_snap and /_send endpoints
openssl rand -base64 32 | npx wrangler secret put SNAPSHOT_TOKEN

# OIDC JWT signing key (same RSA key embedded in the Authelia config)
cat authelia/private.pem | npx wrangler secret put OIDC_SIGNING_KEY
```

### 8. Deploy

Requires Docker running locally for the container image build.

```sh
npx wrangler deploy
```

The first deploy reveals the account's `workers.dev` subdomain. Copy that URL into `vars.SNAPSHOT_URL` in `wrangler.jsonc` and redeploy so the container uses the right callback URL. The `MAIL_FROM` var sets the sender address for Authelia notifications (must be on a domain verified in Cloudflare Email Sending).

### 9. Register in Cloudflare Access

Add a generic OIDC identity provider:

| Field | Value |
|-------|-------|
| Auth URL | `https://auth.example.com/api/oidc/authorization` |
| Token URL | `https://auth.example.com/api/oidc/token` |
| JWKS URL | `https://auth.example.com/jwks.json` |
| Client ID | `cloudflare` |
| Client Secret | plaintext secret (not the bcrypt hash) |
| Auth method | `client_secret_basic` |
| Scopes | `openid email profile groups` |

## Debugging

### Container SSH

SSH is enabled via `wrangler_ssh` in the container config. Authorized public keys live in `wrangler.jsonc`. Only `ssh-ed25519` keys are supported.

```sh
# Find the running instance
npx wrangler containers list
npx wrangler containers instances <APPLICATION_UUID> --json

# Open a shell (requires the container be awake)
npx wrangler containers ssh <INSTANCE_ID> -i ~/.ssh/id_ed25519

# Or one-shot a command (read the latest Authelia notification)
npx wrangler containers ssh <INSTANCE_ID> -i ~/.ssh/id_ed25519 -- cat /data/notification.txt
```

### Worker tail

```sh
npx wrangler tail "auth.example.com/*" --format pretty
```

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker: proxies to Authelia, enriches ID tokens, handles `/_snap/*` and `/_send` |
| `Dockerfile` | Authelia container image |
| `container-entrypoint.sh` | Container init: snapshot restore, background snapshot loop, notification forwarder, Authelia |
| `notif-forwarder.sh` | Watches `/data/notification.txt` mtime, parses each block, POSTs to Worker `/_send` |
| `wrangler.jsonc.example` | Worker, container, R2, and routes config template |
| `authelia/configuration.yml.example` | Authelia config template (TOTP + WebAuthn enabled) |
