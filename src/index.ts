/**
 * Entrypoint: starts the observer hub on 127.0.0.1:7632.
 *
 * Env:
 *   ANNOTATION_HUB_PORT  override port (default 7632; 0 = ephemeral, tests)
 *   ANNOTATION_HUB_HOST  override bind host (must be loopback; default 127.0.0.1)
 *   ANNOTATION_HUB_POLL_MS  override poll interval (default 2000)
 */
import { Hub } from "./hub";
import { startServer } from "./server";
import { isLoopbackHost } from "./loopback";

function main(): void {
  const portArg = process.env.ANNOTATION_HUB_PORT ? Number(process.env.ANNOTATION_HUB_PORT) : 7632;
  // 0 = ephemeral port (useful for tests); registry-derived ports use the
  // stricter parseStrictPort, but the bind port may legitimately be 0.
  if (!Number.isInteger(portArg) || portArg < 0 || portArg > 65535) {
    console.error("annotation-hub: ANNOTATION_HUB_PORT must be an integer in 0..65535 (or unset for 7632).");
    process.exit(2);
  }
  const port = portArg;
  const hostname = process.env.ANNOTATION_HUB_HOST?.trim() || "127.0.0.1";
  if (!isLoopbackHost(hostname)) {
    console.error(`annotation-hub: refusing to bind non-loopback host "${hostname}".`);
    process.exit(2);
  }
  const pollMs = Number(process.env.ANNOTATION_HUB_POLL_MS) || 2000;

  const hub = new Hub({ pollIntervalMs: pollMs });
  let run;
  try {
    run = startServer(hub, { hostname, port });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`annotation-hub: could not bind ${hostname}:${port} — ${msg}`);
    console.error("  Is another hub instance already running? (lsof -nP -iTCP:${port} -sTCP:LISTEN)");
    process.exit(1);
  }

  console.log("Agent Annotation Hub (observer)");
  console.log(`  listening   http://${run.hostname}:${run.port}   (loopback only)`);
  console.log(`  poll        every ${hub.pollIntervalMs}ms`);
  console.log(`  crit        ${hub.critHome}/sessions`);
  console.log(`  plannotator ${hub.plannotatorDataDir}/sessions`);
  console.log("  endpoints   GET /  GET /api/sessions  GET /api/health");

  const shutdown = (signal: string) => {
    console.log(`annotation-hub: ${signal}, shutting down.`);
    void run.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
