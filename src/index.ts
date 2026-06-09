import { Container } from "@cloudflare/containers";

interface SendEmailBinding {
  send(msg: {
    from: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<void>;
}

interface Env {
  AUTHELIA: DurableObjectNamespace;
  OIDC_SIGNING_KEY: string;
  AUTHELIA_DB: R2Bucket;
  SNAPSHOT_TOKEN: string;
  // workers.dev URL the container uses to call back into the Worker for
  // snapshot save/restore. Set per-environment in wrangler.jsonc `vars`.
  SNAPSHOT_URL: string;
  // Cloudflare Email Sending beta binding.
  SEND_EMAIL: SendEmailBinding;
  // From-address used when forwarding Authelia notifications.
  MAIL_FROM: string;
  // Cloudflare Tunnel hostname for the LLDAP service.
  TUNNEL_HOSTNAME: string;
  // Access service-token credentials for the LLDAP tunnel.
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
}

const SNAPSHOT_KEY = "db.sqlite3";

export class AutheliaContainer extends Container<Env> {
  defaultPort = 9091;
  sleepAfter = "2h";
  enableInternet = true;
  pingEndpoint = "/api/health";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.envVars = {
      // workers.dev URL bypasses the zone's bot management / WAF rules that
      // would otherwise block the container's scripted requests.
      // Set per-environment via `vars.SNAPSHOT_URL` in wrangler.jsonc.
      WORKER_URL: env.SNAPSHOT_URL,
      SNAPSHOT_TOKEN: env.SNAPSHOT_TOKEN,
      TUNNEL_HOSTNAME: env.TUNNEL_HOSTNAME,
      CF_ACCESS_CLIENT_ID: env.CF_ACCESS_CLIENT_ID,
      CF_ACCESS_CLIENT_SECRET: env.CF_ACCESS_CLIENT_SECRET,
    };
  }
}

function base64urlEncode(data: ArrayBuffer | string): string {
  let b64: string;
  if (typeof data === "string") {
    b64 = btoa(data);
  } else {
    const bytes = new Uint8Array(data);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    b64 = btoa(binary);
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): string {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return atob(b64);
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const contents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = Uint8Array.from(atob(contents), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binary,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: CryptoKey
): Promise<string> {
  const h = base64urlEncode(JSON.stringify(header));
  const p = base64urlEncode(JSON.stringify(claims));
  const input = new TextEncoder().encode(`${h}.${p}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, input);
  return `${h}.${p}.${base64urlEncode(sig)}`;
}

// Handle snapshot + email-send requests from the container.
// Authenticated via a shared secret.
async function handleInternal(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const token = request.headers.get("X-Snapshot-Token");
  if (!token || token !== env.SNAPSHOT_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (path === "/_snap/restore" && request.method === "GET") {
    const obj = await env.AUTHELIA_DB.get(SNAPSHOT_KEY);
    if (!obj) {
      return new Response("", { status: 404 });
    }
    return new Response(obj.body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(obj.size),
      },
    });
  }

  if (path === "/_snap/save" && request.method === "PUT") {
    if (!request.body) {
      return new Response("No body", { status: 400 });
    }
    await env.AUTHELIA_DB.put(SNAPSHOT_KEY, request.body);
    return new Response("OK", { status: 200 });
  }

  // Container posts parsed Authelia notifications here; we forward them via
  // the Cloudflare Email Sending binding.
  if (path === "/_send" && request.method === "POST") {
    try {
      const msg = await request.json<{
        to: string;
        subject: string;
        text: string;
      }>();
      if (!msg.to || !msg.subject || !msg.text) {
        return Response.json({ error: "to, subject, text required" }, { status: 400 });
      }
      await env.SEND_EMAIL.send({
        from: env.MAIL_FROM,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
      });
      console.log(`SEND ok to=${msg.to} subject="${msg.subject}"`);
      return Response.json({ ok: true });
    } catch (e) {
      console.log(`SEND failed: ${String(e)}`);
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Internal endpoints (/_snap/*, /_send) — handled by the Worker directly.
    if (url.pathname.startsWith("/_snap/") || url.pathname === "/_send") {
      return handleInternal(request, env, url.pathname);
    }

    const container = env.AUTHELIA.getByName("singleton");
    await container.startAndWaitForPorts();

    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Proto", "https");
    headers.set("X-Forwarded-Host", url.hostname);
    headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") || "");
    headers.set("X-Real-IP", request.headers.get("CF-Connecting-IP") || "");

    const proxyRequest = new Request(request, { headers });
    const response = await container.fetch(proxyRequest);

    // Enrich token endpoint response with userinfo claims.
    // Authelia v4.39 only returns email/groups via the userinfo endpoint,
    // not in the ID token. Cloudflare Access requires email in the ID token.
    if (url.pathname === "/api/oidc/token" && request.method === "POST") {
      const body = await response.text();
      console.log("TOKEN endpoint hit, status=" + response.status + " bodyLen=" + body.length);
      try {
        const tokenData = JSON.parse(body);
        console.log("TOKEN keys=" + Object.keys(tokenData).join(","));
        if (tokenData.access_token && tokenData.id_token) {
          // Authelia derives the OIDC issuer from X-Forwarded-* headers to
          // validate the access token's `iss` claim. Without these the userinfo
          // endpoint returns 500 "Error occurred determining the effective issuer".
          const userinfoResp = await container.fetch(
            new Request(`https://${url.hostname}/api/oidc/userinfo`, {
              headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": url.hostname,
              },
            })
          );
          console.log("USERINFO status=" + userinfoResp.status);

          if (userinfoResp.ok) {
            const userinfoBody = await userinfoResp.text();
            console.log("USERINFO body=" + userinfoBody.slice(0, 500));
            const userinfo = JSON.parse(userinfoBody) as Record<string, unknown>;
            const [headerB64, payloadB64] = tokenData.id_token.split(".");
            const originalHeader = JSON.parse(base64urlDecode(headerB64));
            const originalClaims = JSON.parse(base64urlDecode(payloadB64));
            const enrichedClaims = { ...originalClaims, ...userinfo };
            console.log("ENRICHED claims keys=" + Object.keys(enrichedClaims).join(","));

            const key = await importPrivateKey(env.OIDC_SIGNING_KEY);
            tokenData.id_token = await signJwt(originalHeader, enrichedClaims, key);

            return new Response(JSON.stringify(tokenData), {
              status: response.status,
              headers: { "Content-Type": "application/json" },
            });
          } else {
            console.log("USERINFO failed, body=" + (await userinfoResp.text()).slice(0, 300));
          }
        } else {
          console.log("TOKEN missing access_token or id_token, skipping enrichment");
        }
      } catch (e) {
        console.log("Token enrichment failed: " + String(e));
      }
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    }

    return response;
  },
};
