/**
 * Loopback-only HTTP server.
 *
 * - Binds 127.0.0.1 (hostname override must still be loopback or we refuse).
 * - GET /             -> hub UI (list of live sessions; no redirects ever)
 *   GET /api/sessions -> HubSnapshot JSON
 *   GET /api/health   -> liveness + counters + best-effort CLI versions
 *   POST /api/sessions/:id/close -> SIGTERM a currently discovered session
 * - Everything else 404s with JSON. Mutations require a custom same-app header.
 */
import { assessCompatibility } from "./compat";
import { Hub } from "./hub";
import { isLoopbackHost } from "./loopback";
import { INDEX_HTML } from "./ui";

export interface ServerOptions {
  hostname?: string;
  port?: number;
}

export interface RunningServer {
  server: import("bun").Server<undefined>;
  hostname: string;
  port: number;
  url: string;
  /** Force a poll now (used by tests). */
  forcePoll(): Promise<void>;
  stop(): Promise<void>;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

export function startServer(hub: Hub, opts: ServerOptions = {}): RunningServer {
  const hostname = opts.hostname ?? "127.0.0.1";
  if (!isLoopbackHost(hostname) && hostname !== "127.0.0.1") {
    throw new Error(`Refusing to bind non-loopback hostname: ${hostname}`);
  }

  let polling = false;
  const tick = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      await hub.poll();
    } finally {
      polling = false;
    }
  };

  // Poll immediately, then on the interval. /api/sessions additionally
  // triggers a fresh poll when the cached snapshot is half-interval stale,
  // so the UI feels live without hammering the registries.
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, hub.pollIntervalMs);
  if (typeof timer.unref === "function") timer.unref();

  const maybeStaleTick = async (): Promise<void> => {
    if (Date.now() - hub.lastPollAtMs > Math.max(250, Math.floor(hub.pollIntervalMs / 2))) {
      await tick();
    }
  };

  const startedAtMs = Date.now();

  const server = Bun.serve({
    hostname,
    port: opts.port ?? 7632,
    idleTimeout: 10,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);

      const closeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/close$/);
      if (req.method === "POST" && closeMatch) {
        // A custom header prevents cross-origin HTML forms from triggering a
        // close. Cross-origin fetch would require an OPTIONS preflight, which
        // this loopback service does not allow.
        if (req.headers.get("x-annotation-hub-action") !== "close-session") {
          return json(403, { error: "missing action confirmation header" });
        }
        let id: string;
        try {
          id = decodeURIComponent(closeMatch[1]!);
        } catch {
          return json(400, { error: "invalid session id" });
        }
        const result = await hub.closeSession(id);
        if (!result.ok) {
          return json(result.reason === "not-found" ? 404 : 409, { error: result.reason });
        }
        return json(202, { ok: true, id: result.session.id, pid: result.session.pid, signal: "SIGTERM" });
      }

      if (req.method !== "GET") {
        return json(405, { error: "method not allowed", allowed: ["GET", "POST /api/sessions/:id/close"] });
      }
      await maybeStaleTick();

      if (url.pathname === "/api/sessions") {
        return json(200, hub.snapshot());
      }
      if (url.pathname === "/api/health") {
        const snap = hub.snapshot();
        const versions = await hub.getToolVersions();
        const counts = { crit: 0, plannotator: 0 } as Record<string, number>;
        for (const s of snap.sessions) counts[s.tool] = (counts[s.tool] ?? 0) + 1;
        return json(200, {
          status: "ok",
          hostname,
          port: server.port,
          uptimeSeconds: Math.round((Date.now() - startedAtMs) / 1000),
          pollIntervalMs: hub.pollIntervalMs,
          lastPollAt: hub.lastPollAtMs > 0 ? new Date(hub.lastPollAtMs).toISOString() : null,
          sessionCounts: counts,
          lastError: snap.lastError,
          versions,
          compatibility: assessCompatibility(versions),
        });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(INDEX_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return json(404, { error: "not found", paths: ["/", "/api/sessions", "/api/health", "POST /api/sessions/:id/close"] });
    },
  });

  const boundPort = server.port ?? 0;
  return {
    server,
    hostname,
    port: boundPort,
    url: `http://${hostname === "127.0.0.1" ? "127.0.0.1" : hostname}:${boundPort}`,
    forcePoll: tick,
    async stop(): Promise<void> {
      clearInterval(timer);
      server.stop(true);
    },
  };
}
