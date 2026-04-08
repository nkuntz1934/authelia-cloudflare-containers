# Authelia OIDC on Cloudflare Containers

Self-hosted OIDC identity provider for Cloudflare Access using Authelia on Cloudflare Containers and LLDAP on a remote VM.

## Architecture

```
                        Cloudflare                                Remote VM
 +---------------------------------------------------------+     +------------------+
 |                                                         |     |                  |
 |   auth.example.com                                      |     |   LLDAP          |
 |   +--------+     +-----------+     +----------+         |     |   :3890 (LDAP)   |
 |   | Worker |---->| Container |---->| Authelia  |---LDAP-+---->|   :17170 (HTTP)  |
 |   +--------+     +-----------+     | :9091     |        |     |                  |
 |                                    +----------+         |     +--------+---------+
 |                                                         |              |
 |   ldap.example.com                                      |              |
 |   +-------------------+     +-------------------+       |              |
 |   | Cloudflare Proxy  |---->| Tunnel (cloudflared) |----+--------------+
 |   +-------------------+     +-------------------+       |
 |                                                         |
 +---------------------------------------------------------+

 LDAP:       lldap-direct.example.com:3890 (non-proxied A record, FW to CF IPs)
 Admin UI:   ldap.example.com (proxied CNAME -> tunnel)
 Auth:       auth.example.com (proxied AAAA -> Worker route)
```

**Authelia** runs in a Cloudflare Container behind a Worker. It handles OIDC authentication and connects to LLDAP over a non-proxied DNS record firewalled to Cloudflare IP ranges.

**LLDAP** runs on a remote VM (e.g. DigitalOcean). Its admin UI is exposed via a Cloudflare Tunnel. Users and groups are managed through the LLDAP web interface and are immediately available in Authelia.

**The Worker** proxies requests to Authelia and intercepts the OIDC token endpoint to enrich ID tokens with email and group claims. Authelia v4.39 only returns these via the userinfo endpoint, but Cloudflare Access requires them in the ID token. The Worker calls userinfo, merges the claims, and re-signs the JWT using the same RSA key.

## Prerequisites

- Cloudflare account with Workers and Containers enabled
- Remote VM with Docker and `cloudflared` installed
- Docker CLI on your local machine (for container image builds)

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

Copy `authelia/configuration.yml.example` to `authelia/configuration.yml` and fill in:
- All `CHANGE_ME_*` placeholder values
- RSA private key in the `jwks` block
- LDAP bind password
- OIDC client secret (bcrypt hash)
- Your domain and Cloudflare Access callback URL

### 3. Create Cloudflare Tunnel

```sh
# Via API or dashboard — create a tunnel and configure ingress:
#   ldap.your-domain.com -> http://localhost:17170
# Note the tunnel token for the VM setup.
```

### 4. Set up LLDAP on the VM

```sh
# Install Docker and cloudflared, then run LLDAP:
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

# Start the tunnel
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
| `auth` | AAAA | Yes | `100::` |
| `ldap` | CNAME | Yes | `<tunnel-id>.cfargotunnel.com` |
| `lldap-direct` | A | No | VM public IP |

Firewall `lldap-direct` port 3890 to [Cloudflare IP ranges](https://www.cloudflare.com/ips/) only.

### 6. Deploy

```sh
npm install

# Set the OIDC signing key as a Worker secret
cat authelia/private.pem | npx wrangler secret put OIDC_SIGNING_KEY

# Deploy
npx wrangler deploy
```

### 7. Register in Cloudflare Access

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

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker: proxies to Authelia container, enriches ID tokens |
| `Dockerfile` | Authelia container image |
| `wrangler.jsonc` | Worker and container configuration |
| `authelia/configuration.yml.example` | Authelia config template |
