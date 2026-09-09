import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "puppeteer-core";

export interface EndpointConfig {
  /** Unique identifier used to retrieve captured data */
  id: string;
  /** URL prefix — any request whose URL starts with this string is captured */
  urlPrefix: string;
}

/**
 * Volcado de diagnostico. Con `OBC_DUMP_XHR=<directorio>` se guarda **todo** el
 * trafico JSON hacia los mismos hosts que el scraper ya consulta: URL, metodo,
 * cuerpo de la peticion y respuesta.
 *
 * Existe porque mantener un scraper a ciegas es adivinar. Cuando el banco cambia
 * su portal, o cuando falta una parte de los datos (una tarjeta que no aparece,
 * por ejemplo), este volcado dice que endpoints existen de verdad y con que
 * parametros se los llama, sin tener que leer el bundle minificado del banco.
 *
 * **Guarda datos sensibles** —saldos, movimientos, identificadores de cliente—,
 * asi que el directorio debe estar fuera de git y borrarse despues.
 */
const DUMP_DIR = process.env.OBC_DUMP_XHR?.trim() || "";
/** Id reservado del puente para el volcado: no es un endpoint del scraper. */
const DUMP_ID = "__obc_dump__";

function hostsOf(endpoints: EndpointConfig[]): string[] {
  const hosts = new Set<string>();
  for (const endpoint of endpoints) {
    try {
      hosts.add(new URL(endpoint.urlPrefix).host);
    } catch {
      // Prefijo que no es URL absoluta: no aporta host que vigilar.
    }
  }
  return [...hosts];
}

function writeDump(dir: string, seq: number, entry: { url: string }): void {
  const path = (() => {
    try {
      return new URL(entry.url).pathname;
    } catch {
      return "sin-url";
    }
  })();
  const name = `${String(seq).padStart(3, "0")}-${path.replace(/[^a-zA-Z0-9]+/g, "-").slice(-60)}.json`;
  writeFileSync(join(dir, name), JSON.stringify(entry, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export interface Interceptor {
  /** Returns all captured response bodies for the given endpoint id */
  getAll(id: string): unknown[];
  /**
   * Waits until at least one response has been captured for the given endpoint id.
   * Returns the captured responses, or an empty array if the timeout is reached.
   */
  waitFor(id: string, timeoutMs?: number): Promise<unknown[]>;
}

/**
 * Installs fetch() and XMLHttpRequest interception on the page.
 *
 * Must be called BEFORE page.goto() because it uses:
 *   - page.exposeFunction  — makes a Node.js callback available as window.__obcCapture
 *   - page.evaluateOnNewDocument — installs the wrappers in every new document
 *
 * When a monitored URL is requested by the page, the response JSON is forwarded
 * to Node.js and stored keyed by endpoint id.
 */
export async function createInterceptor(
  page: Page,
  endpoints: EndpointConfig[],
): Promise<Interceptor> {
  const captures = new Map<string, unknown[]>();

  if (DUMP_DIR) mkdirSync(DUMP_DIR, { recursive: true, mode: 0o700 });
  let dumped = 0;

  // Bridge: called from browser context → stores data in Node.js
  await page.exposeFunction(
    "__obcCapture",
    (id: string, dataJson: string) => {
      if (id === DUMP_ID) {
        if (!DUMP_DIR) return;
        try {
          const entry = JSON.parse(dataJson) as { url: string };
          writeDump(DUMP_DIR, ++dumped, entry);
        } catch {
          // Volcado best-effort: nunca debe voltear una corrida.
        }
        return;
      }
      try {
        const data: unknown = JSON.parse(dataJson);
        const existing = captures.get(id) ?? [];
        existing.push(data);
        captures.set(id, existing);
      } catch {
        // Ignore malformed JSON
      }
    },
  );

  // Inject the fetch/XHR wrappers before any document loads
  await page.evaluateOnNewDocument(
    (configJson: string) => {
      const config = JSON.parse(configJson) as {
        endpoints: Array<{ id: string; urlPrefix: string }>;
        dumpId: string;
        dumpHosts: string[];
      };
      const eps = config.endpoints;

      function matchEndpoint(url: string): { id: string; urlPrefix: string } | undefined {
        return eps.find((e) => url.startsWith(e.urlPrefix));
      }

      /** ¿Va a uno de los hosts del banco que el scraper ya consulta? */
      function shouldDump(url: string): boolean {
        if (config.dumpHosts.length === 0) return false;
        try {
          return config.dumpHosts.includes(new URL(url, location.href).host);
        } catch {
          return false;
        }
      }

      function bodyOf(body: unknown): string | undefined {
        if (typeof body === "string") return body.slice(0, 20000);
        if (body == null) return undefined;
        try {
          return JSON.stringify(body).slice(0, 20000);
        } catch {
          return "(cuerpo no serializable)";
        }
      }

      function dump(url: string, method: string, requestBody: unknown, response: unknown): void {
        capture(config.dumpId, {
          url,
          method,
          requestBody: bodyOf(requestBody),
          response,
        });
      }

      function capture(id: string, data: unknown): void {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__obcCapture(id, JSON.stringify(data));
        } catch {
          // Bridge not yet ready — ignore
        }
      }

      // ── Wrap fetch ──────────────────────────────────────────────
      const originalFetch = window.fetch;
      window.fetch = async function (...args: Parameters<typeof fetch>): Promise<Response> {
        const url =
          typeof args[0] === "string"
            ? args[0]
            : args[0] instanceof Request
              ? args[0].url
              : String(args[0]);

        const ep = matchEndpoint(url);
        const response = await originalFetch.apply(window, args);

        if (ep || shouldDump(url)) {
          const init = (args[1] || {}) as RequestInit;
          const method = (init.method || (args[0] instanceof Request ? args[0].method : "GET")).toUpperCase();
          response
            .clone()
            .json()
            .then((data: unknown) => {
              if (ep) capture(ep.id, data);
              if (shouldDump(url)) dump(url, method, init.body, data);
            })
            .catch(() => {});
        }

        return response;
      };

      // ── Wrap XHR ────────────────────────────────────────────────
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (
        method: string,
        url: string | URL,
        ...rest: [boolean?, string?, string?]
      ): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const self = this as any;
        self.__obcEp = matchEndpoint(String(url));
        self.__obcUrl = String(url);
        self.__obcMethod = method;
        return origOpen.apply(this, [method, url, ...rest] as Parameters<typeof origOpen>);
      };

      XMLHttpRequest.prototype.send = function (
        ...args: Parameters<typeof origSend>
      ): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const self = this as any;
        const ep = self.__obcEp as { id: string } | undefined;
        const url = (self.__obcUrl as string) || "";
        const requestBody = args[0];
        if (ep || shouldDump(url)) {
          this.addEventListener("load", function (this: XMLHttpRequest) {
            try {
              const data: unknown =
                this.responseType === "json"
                  ? this.response
                  : (JSON.parse(this.responseText) as unknown);
              if (ep) capture(ep.id, data);
              if (shouldDump(url)) dump(url, (self.__obcMethod as string) || "GET", requestBody, data);
            } catch {
              // Ignore parse errors
            }
          });
        }
        return origSend.apply(this, args);
      };
    },
    JSON.stringify({
      endpoints,
      dumpId: DUMP_ID,
      dumpHosts: DUMP_DIR ? hostsOf(endpoints) : [],
    }),
  );

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    getAll(id: string): unknown[] {
      return captures.get(id) ?? [];
    },

    async waitFor(id: string, timeoutMs = 10_000): Promise<unknown[]> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const data = captures.get(id);
        if (data && data.length > 0) return data;
        await sleep(200);
      }
      return captures.get(id) ?? [];
    },
  };
}
