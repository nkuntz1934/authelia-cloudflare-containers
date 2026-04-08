import { Container } from "@cloudflare/containers";

export class AutheliaContainer extends Container {
  defaultPort = 9091;
  sleepAfter = "2h";
  enableInternet = true;
  pingEndpoint = "/api/health";
}

interface Env {
  AUTHELIA: DurableObjectNamespace;
  OIDC_SIGNING_KEY: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = env.AUTHELIA.getByName("singleton");
    await container.startAndWaitForPorts();

    const url = new URL(request.url);
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
      try {
        const tokenData = JSON.parse(body);
        if (tokenData.access_token && tokenData.id_token) {
          const userinfoResp = await container.fetch(
            new Request("http://localhost/api/oidc/userinfo", {
              headers: { Authorization: `Bearer ${tokenData.access_token}` },
            })
          );

          if (userinfoResp.ok) {
            const userinfo = JSON.parse(await userinfoResp.text()) as Record<string, unknown>;
            const [headerB64, payloadB64] = tokenData.id_token.split(".");
            const originalHeader = JSON.parse(base64urlDecode(headerB64));
            const originalClaims = JSON.parse(base64urlDecode(payloadB64));
            const enrichedClaims = { ...originalClaims, ...userinfo };

            const key = await importPrivateKey(env.OIDC_SIGNING_KEY);
            tokenData.id_token = await signJwt(originalHeader, enrichedClaims, key);

            return new Response(JSON.stringify(tokenData), {
              status: response.status,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
      } catch (e) {
        console.log("Token enrichment failed:", String(e));
      }
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    }

    return response;
  },
};
