import { Container } from "@cloudflare/containers";

export class AutheliaContainer extends Container {
  defaultPort = 9091;
  sleepAfter = "2h";
  enableInternet = true;
  pingEndpoint = "/api/health";
}

interface Env {
  AUTHELIA: DurableObjectNamespace;
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
    return container.fetch(proxyRequest);
  },
};
