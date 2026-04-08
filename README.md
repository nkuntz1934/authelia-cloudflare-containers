# Authelia OIDC on Cloudflare Containers

Authelia OIDC identity provider running on Cloudflare Containers with LLDAP as the authentication backend on DigitalOcean.

## Architecture

```
User -> Worker (auth.example.com) -> Cloudflare Container -> Authelia (:9091)
                                                                  |
                                                                  v
LLDAP Admin UI (ldap.example.com) <- Cloudflare Tunnel <- DO Droplet
                                                              |
Authelia LDAP connection (lldap-direct.example.com:3890) ----+
```

- **Authelia** runs in a Cloudflare Container (Durable Object) behind a Worker.
- **LLDAP** runs on a DigitalOcean droplet, exposed via Cloudflare Tunnel for the admin UI.
- Authelia connects to LLDAP over a non-proxied DNS record (`lldap-direct.example.com:3890`), firewalled to Cloudflare IP ranges.
- The Worker intercepts the OIDC token endpoint to enrich ID tokens with userinfo claims (email, groups) since Authelia v4.39 does not include them in the ID token by default.

## Components

| Component | Config |
|-----------|--------|
| Worker + Container | `wrangler.jsonc`, `src/index.ts` |
| Authelia config | `authelia/configuration.yml` |
| Dockerfile | `Dockerfile` |
| LLDAP | Docker on DO droplet, configured via env vars |

## Cloudflare Access Integration

Authelia is registered as a generic OIDC identity provider in Cloudflare Access:

- Authorization: `https://auth.example.com/api/oidc/authorization`
- Token: `https://auth.example.com/api/oidc/token`
- JWKS: `https://auth.example.com/jwks.json`
- Client ID: `cloudflare`
- Auth method: `client_secret_basic`
- Scopes: `openid email profile groups`

## Deployment

```sh
npm install
npx wrangler deploy
```

LLDAP runs on the DO droplet via `docker compose` with `cloudflared` providing the tunnel back to Cloudflare.

## DNS Records

| Record | Type | Proxied | Target |
|--------|------|---------|--------|
| `auth.example.com` | AAAA | Yes | `100::` (Worker route) |
| `ldap.example.com` | CNAME | Yes | `<tunnel-id>.cfargotunnel.com` |
| `lldap-direct.example.com` | A | No | DO droplet IP |
