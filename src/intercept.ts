import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "puppeteer-core";

/** Una petición tal como la hizo la página, para poder repetirla. */
interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /**
   * Origen del documento que hizo la peticion. Los modulos del portal viven
   * en iframes de otro subdominio: repetir la peticion desde el frame
   * principal falla por CORS ("Failed to fetch") aunque la sesion este viva.
   */
  origin?: string;
  /** `withCredentials` del XHR (o `credentials: "include"` del fetch). */
  credentials?: boolean;
}

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
/** Id reservado del puente para las peticiones grabadas. */
const REQUEST_ID = "__obc_request__";

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
  /**
   * Cuerpo de la última petición que la propia página hizo a ese endpoint, ya
   * parseado. Sirve de plantilla: se le cambia lo que distingue un producto de
   * otro y se vuelve a pedir con `replay`.
   */
  lastRequestBody(id: string): unknown | undefined;
  /**
   * Repite una petición del endpoint con otro cuerpo, desde la propia página.
   *
   * Reutiliza URL, método y cabeceras tal como los mandó la aplicación del
   * banco, así que la sesión y cualquier token viajan sin que el scraper tenga
   * que saber cómo se autentica. Es la forma de pedir lo que la interfaz nunca
   * pide sola: el resto de las tarjetas, otro extracto, la otra moneda.
   *
   * Devuelve la respuesta JSON, o `undefined` si no hay plantilla o si falló.
   */
  replay(id: string, body: unknown): Promise<unknown | undefined>;
  /**
   * Por qué falló el último `replay` de ese endpoint: estado HTTP y un trozo
   * del cuerpo, o la excepción. `undefined` si el último replay funcionó.
   */
  lastReplayError(id: string): string | undefined;
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
  const requests = new Map<string, RecordedRequest>();
  const replayErrors = new Map<string, string>();

  if (DUMP_DIR) mkdirSync(DUMP_DIR, { recursive: true, mode: 0o700 });
  let dumped = 0;

  // Bridge: called from browser context → stores data in Node.js
  await page.exposeFunction(
    "__obcCapture",
    (id: string, dataJson: string) => {
      if (id === REQUEST_ID) {
        try {
          const recorded = JSON.parse(dataJson) as { endpointId: string } & RecordedRequest;
          requests.set(recorded.endpointId, {
            url: recorded.url,
            method: recorded.method,
            headers: recorded.headers,
            body: recorded.body,
            origin: recorded.origin,
            credentials: recorded.credentials,
          });
        } catch {
          // Sin plantilla no hay replay; el scraper sigue con lo que capturo.
        }
        return;
      }
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
        requestId: string;
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

      /** Cabeceras que el navegador no deja fijar a mano al repetir la peticion. */
      const FORBIDDEN = [
        "host", "connection", "content-length", "cookie", "origin", "referer", "user-agent",
      ];

      function plainHeaders(raw: unknown): Record<string, string> {
        const out: Record<string, string> = {};
        const add = (key: string, value: string): void => {
          if (!FORBIDDEN.includes(key.toLowerCase())) out[key] = value;
        };
        if (raw instanceof Headers) {
          raw.forEach((value, key) => add(key, value));
        } else if (Array.isArray(raw)) {
          for (const [key, value] of raw as Array<[string, string]>) add(key, String(value));
        } else if (raw && typeof raw === "object") {
          for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            add(key, String(value));
          }
        }
        return out;
      }

      /** Guarda la peticion tal como la mando el banco, para poder repetirla. */
      function recordRequest(
        endpointId: string,
        url: string,
        method: string,
        headers: unknown,
        body: unknown,
        credentials: boolean,
      ): void {
        capture(config.requestId, {
          endpointId,
          url,
          method,
          origin: location.origin,
          credentials,
          headers: plainHeaders(headers),
          body: typeof body === "string" ? body : undefined,
        });
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
      // El replay usa este: repetir por el fetch envuelto se capturaria a si
      // mismo y contaria los movimientos dos veces.
      Object.defineProperty(window, "__obcFetch", {
        value: originalFetch.bind(window),
        configurable: true,
      });
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
          const headers = init.headers ?? (args[0] instanceof Request ? args[0].headers : undefined);
          if (ep) recordRequest(ep.id, url, method, headers, init.body, init.credentials === "include");
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
      const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

      XMLHttpRequest.prototype.open = function (
        method: string,
        url: string | URL,
        ...rest: [boolean?, string?, string?]
      ): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const self = this as any;
        // Un XHR marcado por `replay` pasa de largo: si se capturara, el
        // movimiento repetido se contaria dos veces.
        self.__obcEp = self.__obcReplay ? undefined : matchEndpoint(String(url));
        self.__obcUrl = String(url);
        self.__obcMethod = method;
        return origOpen.apply(this, [method, url, ...rest] as Parameters<typeof origOpen>);
      };

      XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const self = this as any;
        self.__obcHeaders = { ...(self.__obcHeaders || {}), [name]: value };
        return origSetHeader.apply(this, [name, value]);
      };

      XMLHttpRequest.prototype.send = function (
        ...args: Parameters<typeof origSend>
      ): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const self = this as any;
        const ep = self.__obcEp as { id: string } | undefined;
        const url = (self.__obcUrl as string) || "";
        const requestBody = args[0];
        if (ep) {
          recordRequest(
            ep.id,
            url,
            (self.__obcMethod as string) || "GET",
            self.__obcHeaders,
            requestBody,
            Boolean(this.withCredentials),
          );
        }
        if ((ep || shouldDump(url)) && !self.__obcReplay) {
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
      requestId: REQUEST_ID,
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

    lastRequestBody(id: string): unknown | undefined {
      const recorded = requests.get(id);
      if (!recorded?.body) return undefined;
      try {
        return JSON.parse(recorded.body);
      } catch {
        return undefined;
      }
    },

    async replay(id: string, body: unknown): Promise<unknown | undefined> {
      const recorded = requests.get(id);
      if (!recorded) {
        replayErrors.set(id, "sin peticion grabada para ese endpoint");
        return undefined;
      }
      // Se repite desde el mismo frame que la hizo: es el unico origen al que
      // el banco le responde con CORS.
      const frame =
        page.frames().find((f) => {
          try {
            return recorded.origin !== undefined && new URL(f.url()).origin === recorded.origin;
          } catch {
            return false;
          }
        }) ?? page.mainFrame();
      try {
        // Se resuelve en la pagina y se devuelve el estado aparte: un 401 o
        // un HTML de sesion caida tambien "responden", y sin el estado se
        // confunden con un producto sin movimientos.
        const outcome = await frame.evaluate(
          (request: RecordedRequest, bodyJson: string) =>
            new Promise<{ ok: boolean; status: number; data?: unknown; text?: string }>((resolve) => {
              // XHR del propio realm de la pagina, con los metodos que haya
              // en ese momento (los nuestros, los de zone.js): guardar los
              // originales al cargar el documento no sirve, Chrome reutiliza
              // la ventana del about:blank inicial y quedan de otro realm
              // ("Illegal invocation").
              const xhr = new XMLHttpRequest();
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (xhr as any).__obcReplay = true;
              xhr.open(request.method, request.url, true);
              xhr.withCredentials = Boolean(request.credentials);
              for (const [name, value] of Object.entries(request.headers)) {
                try {
                  xhr.setRequestHeader(name, value);
                } catch {
                  // Cabecera prohibida por el navegador: la pone el solo.
                }
              }
              xhr.onload = () => {
                const ok = xhr.status >= 200 && xhr.status < 300;
                try {
                  resolve({ ok, status: xhr.status, data: JSON.parse(xhr.responseText) as unknown });
                } catch {
                  resolve({ ok: false, status: xhr.status, text: xhr.responseText.slice(0, 300) });
                }
              };
              xhr.onerror = () => resolve({ ok: false, status: xhr.status, text: "error de red" });
              xhr.ontimeout = () => resolve({ ok: false, status: xhr.status, text: "timeout" });
              xhr.send(request.method === "GET" ? null : bodyJson);
            }),
          recorded,
          JSON.stringify(body),
        );
        if (!outcome.ok || outcome.data === undefined) {
          replayErrors.set(
            id,
            `HTTP ${outcome.status}` + (outcome.text !== undefined ? ` cuerpo no JSON: ${outcome.text}` : ""),
          );
          return outcome.data;
        }
        replayErrors.delete(id);
        return outcome.data;
      } catch (err) {
        replayErrors.set(
          id,
          `excepcion desde ${frame.url()}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    },

    lastReplayError(id: string): string | undefined {
      return replayErrors.get(id);
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
