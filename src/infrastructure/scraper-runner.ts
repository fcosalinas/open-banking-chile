import type { ScrapeResult, ScraperOptions } from "../types.js";
import { logout } from "../utils.js";
import { launchBrowser, type BrowserOptions, type BrowserSession } from "./browser.js";

export type ScrapeFn = (
  session: BrowserSession,
  options: ScraperOptions,
) => Promise<ScrapeResult>;

/**
 * Wraps the full scraper lifecycle:
 * 1. Validate credentials
 * 2. Find Chrome
 * 3. Launch browser
 * 4. Run bank-specific scrapeFn
 * 5. Logout + close browser
 * 6. Catch errors → return ScrapeResult
 */
/**
 * Con `OBC_DUMP_XHR` activo, deja el navegador abierto `OBC_DUMP_PAUSE_SEC`
 * segundos antes de cerrar sesion.
 *
 * El volcado solo puede capturar lo que la pagina pide, y el scraper no visita
 * todo: si una seccion necesita un clic que el no da -elegir otra tarjeta, por
 * ejemplo-, su endpoint no aparece nunca. La pausa permite navegar a mano esa
 * parte con el interceptor puesto, que es como se descubre que parametro
 * distingue lo que falta.
 */
async function pauseForDump(
  debugLog: string[],
  onDebug?: (line: string) => void,
): Promise<void> {
  if (!process.env.OBC_DUMP_XHR?.trim()) return;
  const raw = parseInt(process.env.OBC_DUMP_PAUSE_SEC || "0", 10) || 0;
  const seconds = Math.min(Math.max(raw, 0), 600);
  if (seconds === 0) return;

  const message = `Volcado XHR: navegador abierto ${seconds}s para explorar a mano.`;
  debugLog.push(message);
  onDebug?.(message);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export async function runScraper(
  bankId: string,
  options: ScraperOptions,
  browserOptions: Partial<BrowserOptions>,
  scrapeFn: ScrapeFn,
): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots, headful, onDebug } = options;

  if (!rut || !password) {
    return {
      success: false,
      bank: bankId,
      accounts: [],
      error: "Debes proveer RUT y clave.",
    };
  }

  let session: BrowserSession | undefined;

  try {
    session = await launchBrowser(
      { chromePath, headful, onDebug, ...browserOptions },
      !!saveScreenshots,
    );

    const result = await scrapeFn(session, options);
    await pauseForDump(session.debugLog, onDebug);
    return result;
  } catch (error) {
    return {
      success: false,
      bank: bankId,
      accounts: [],
      error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`,
      debug: session?.debugLog.join("\n"),
    };
  } finally {
    if (session?.browser) {
      try {
        const pages = await session.browser.pages();
        if (pages.length > 0) await logout(pages[pages.length - 1], session.debugLog);
      } catch { /* best effort */ }
      await session.browser.close().catch(() => {});
    }
  }
}
