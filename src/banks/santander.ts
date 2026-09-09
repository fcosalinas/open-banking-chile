import type { Frame, Page } from "puppeteer-core";
import type {
  BankMovement,
  BankScraper,
  CardOwner,
  CreditCardBalance,
  ScrapeResult,
  ScraperOptions,
} from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { deduplicateMovements, closePopups, delay, normalizeDate, parseChileanAmount } from "../utils.js";
import { createInterceptor, type Interceptor } from "../intercept.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { fillRut, fillPassword, clickSubmit, detectLoginError } from "../actions/login.js";
import { detect2FA, waitFor2FA } from "../actions/two-factor.js";
import { clickByText, clickSidebarItem, dismissBanners, clickWidget } from "../actions/navigation.js";
import { extractAccountMovements } from "../actions/extraction.js";
import { paginateAndExtract } from "../actions/pagination.js";
import { extractBalance } from "../actions/balance.js";
import { clickTcTab, extractCreditCardMovements } from "../actions/credit-card.js";

// ─── Santander-specific constants ────────────────────────────────────

const BANK_URL = "https://banco.santander.cl/personas";

// ─── API endpoint prefixes ───────────────────────────────────────
const SANTANDER_CHECKING_API_PREFIX =
  "https://openbanking.santander.cl/account_balances_transactions_and_withholdings_retail/v1/current-accounts/transactions";
const SANTANDER_CC_API_PREFIX =
  "https://api-dsk.santander.cl/perdsk/tarjetasDeCredito/consultaUltimosMovimientos";
const SANTANDER_CC_BILLED_API_PREFIX =
  "https://api-dsk.santander.cl/perdsk/tarjetasDeCredito/estadoCuentaNacional";
// Lista de plasticos del cliente: de aca salen las coordenadas
// (entidad/centro/cuenta) con las que se le puede preguntar al banco por cada
// tarjeta. Sin esto solo se ve la que el portal muestra por omision.
const SANTANDER_CARDS_API_PREFIX =
  "https://openbanking.santander.cl/card_authorization/card_authorization/v1/cards/card_devices_management";
// Extractos disponibles de una tarjeta: el numero de extracto es obligatorio
// para pedir los movimientos facturados.
const SANTANDER_CC_STATEMENTS_API_PREFIX =
  "https://api-dsk.santander.cl/perdsk/tarjetasDeCredito/cuentasDisponibles";

// ─── API response normalizers ────────────────────────────────────

interface SantanderCheckingApiMovement {
  transactionDate: string; // "2026-03-19"
  movementAmount: string; // "00000010000000-" (centavos, trailing - = debit)
  chargePaymentFlag: string; // "D" = debit, "H" = haber/credit
  observation: string;
  expandedCode: string;
  newBalance?: string;
}

export function normalizeSantanderCheckingApiMovements(captures: unknown[]): BankMovement[] {
  const movements: BankMovement[] = [];
  for (const capture of captures) {
    const obj = capture as { movements?: SantanderCheckingApiMovement[] };
    const list = obj?.movements;
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const digits = m.movementAmount.replace(/[^0-9]/g, "");
      const raw = parseInt(digits, 10);
      if (!raw || isNaN(raw)) continue;
      const clp = raw / 100;
      const isDebit = m.chargePaymentFlag === "D" || m.movementAmount.endsWith("-");
      const amount = isDebit ? -clp : clp;
      const description = (m.observation?.trim() || m.expandedCode?.trim() || "").trim();
      let balance = 0;
      if (m.newBalance) {
        // El signo va al final, igual que en movementAmount. Sin esto, la
        // cuenta en rojo -saldo negativo que la linea de credito rellena- se
        // lee como si tuviera plata, y la cadena de saldos se parte en cada uno.
        const negative = m.newBalance.trim().endsWith("-");
        const balDigits = m.newBalance.replace(/[^0-9]/g, "");
        balance = Math.round(parseInt(balDigits, 10) / 100);
        if (negative) balance = -balance;
      }
      movements.push({
        date: normalizeDate(m.transactionDate),
        description,
        amount,
        balance,
        source: MOVEMENT_SOURCE.account,
      });
    }
  }
  return movements;
}

interface SantanderCcApiMovement {
  Fecha: string; // "18/01/2026"
  Comercio: string;
  Descripcion: string;
  Importe: string; // "3.990" (Chilean thousands)
  IndicadorDebeHaber: string; // "D" = debit, "H" = credit
  TipoBen?: string | null; // "Titular" | null — quien hizo la compra
}

export function isSaldoInicial(description: string): boolean {
  return /saldo\s+inicial/i.test(description);
}

export function normalizeSantanderUnbilledApiMovements(
  captures: unknown[],
  card?: string,
): BankMovement[] {
  const movements: BankMovement[] = [];
  for (const capture of captures) {
    const obj = capture as { DATA?: { MatrizMovimientos?: SantanderCcApiMovement[] } };
    const list = obj?.DATA?.MatrizMovimientos;
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const raw = parseChileanAmount(m.Importe);
      if (!raw || isNaN(raw)) continue;
      const isDebit = m.IndicadorDebeHaber === "D";
      const amount = isDebit ? -raw : raw;
      const description = (m.Comercio?.trim() || m.Descripcion?.trim() || "").trim();
      if (isSaldoInicial(description)) continue;
      // Los no facturados no traen PAN: la tarjeta es la de la consulta. El
      // banco si dice si la compra es del titular o de un adicional.
      const owner: CardOwner | undefined =
        m.TipoBen == null ? undefined : /titular/i.test(m.TipoBen) ? "titular" : "adicional";
      movements.push({
        date: normalizeDate(m.Fecha),
        description,
        amount,
        balance: 0,
        source: MOVEMENT_SOURCE.credit_card_unbilled,
        ...(card ? { card } : {}),
        ...(owner ? { owner } : {}),
      });
    }
  }
  return movements;
}

interface SantanderBilledApiMovement {
  FechaTxs: string; // "2026-01-28"
  NombreComercio: string;
  MontoTxs: string; // "0000833685" or "50.000" (Chilean thousands, leading zeros)
  NumeroCuotas: string; // "00"
  TotalCuotas: string; // "00"
  Pan?: string; // "240004#375833608" — el plastico que hizo la compra
}

/** Ultimos cuatro digitos del PAN, que es como se nombra una tarjeta. */
export function maskOfPan(pan: string | undefined): string | undefined {
  const digits = (pan || "").replace(/[^0-9]/g, "");
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

export function normalizeSantanderBilledApiMovements(captures: unknown[]): BankMovement[] {
  const movements: BankMovement[] = [];
  for (const capture of captures) {
    const path = (capture as Record<string, unknown>)?.DATA as Record<string, unknown> | undefined;
    const response = path?.AS_TIB_WM02_CONEstCtaNacional_Response as
      | Record<string, unknown>
      | undefined;
    const output = response?.OUTPUT as Record<string, unknown> | undefined;
    const list = output?.Matriz as SantanderBilledApiMovement[] | undefined;
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      // Strip leading zeros + dots (Chilean thousands separator), parse as integer pesos
      const cleaned = m.MontoTxs.replace(/^0+/, "").replace(/\./g, "") || "0";
      const raw = parseInt(cleaned, 10);
      if (!raw || isNaN(raw)) continue;
      if (isSaldoInicial(m.NombreComercio)) continue;
      const isPayment = m.NombreComercio.toLowerCase().includes("monto cancelado");
      const amount = isPayment ? raw : -raw;
      const totalCuotas = parseInt(m.TotalCuotas.replace(/^0+/, "") || "0", 10);
      const currentCuota = parseInt(m.NumeroCuotas.replace(/^0+/, "") || "0", 10);
      const installments =
        totalCuotas > 0
          ? `${String(currentCuota).padStart(2, "0")}/${String(totalCuotas).padStart(2, "0")}`
          : undefined;
      const card = maskOfPan(m.Pan);
      movements.push({
        date: normalizeDate(m.FechaTxs),
        description: m.NombreComercio,
        amount,
        balance: 0,
        source: MOVEMENT_SOURCE.credit_card_billed,
        ...(card ? { card } : {}),
        ...(installments ? { installments } : {}),
      });
    }
  }
  return movements;
}

// ─── Tarjetas: lista de plasticos y extractos ────────────────────

interface SantanderCardDevice {
  debitOrCreditCard?: string;
  entityCode?: string;
  emissionCenter?: string;
  accountNumber?: string;
  cardNumber?: string;
  beneficiaryNumber?: string;
  productComment?: string;
  limitCenterPesos?: string;
  limitContractUSD?: string;
  cardStatusComment?: string;
}

/** Una tarjeta con las coordenadas que el banco pide para consultarla. */
export interface SantanderCard {
  entity: string;
  center: string;
  account: string;
  /** Ultimos cuatro digitos del plastico. */
  mask: string;
  label: string;
  owner: CardOwner;
  /** Cupo nacional en pesos, si lo declara la lista de plasticos. */
  limitClp?: number;
  /** Cupo internacional en dolares. */
  limitUsd?: number;
}

/**
 * Tarjetas del cliente, con la entidad/centro/cuenta que las identifica.
 *
 * Varios plasticos comparten cuenta -el titular y sus adicionales- y los
 * movimientos se consultan por cuenta, no por plastico.
 */
export function parseSantanderCards(captures: unknown[]): SantanderCard[] {
  const cards: SantanderCard[] = [];
  for (const capture of captures) {
    const list = (capture as { output?: SantanderCardDevice[] })?.output;
    if (!Array.isArray(list)) continue;
    for (const device of list) {
      if (device.debitOrCreditCard && device.debitOrCreditCard !== "C") continue;
      const mask = maskOfPan(device.cardNumber);
      const account = device.accountNumber?.trim();
      const center = device.emissionCenter?.trim();
      const entity = device.entityCode?.trim();
      if (!mask || !account || !center || !entity) continue;
      const name = device.productComment?.trim() || "Tarjeta de crédito";
      cards.push({
        entity,
        center,
        account,
        mask,
        label: `${name} ****${mask}`,
        // El primer beneficiario es el titular; el resto son adicionales.
        owner:
          (device.beneficiaryNumber || "").replace(/^0+/, "") === "1" ? "titular" : "adicional",
        ...(device.limitCenterPesos ? { limitClp: parseInt(device.limitCenterPesos, 10) || 0 } : {}),
        ...(device.limitContractUSD
          ? { limitUsd: Math.round((parseInt(device.limitContractUSD, 10) || 0) / 100) }
          : {}),
      });
    }
  }
  return cards;
}

/** Una entrada por cuenta de tarjeta, con el plastico del titular de cara. */
export function cardAccounts(cards: SantanderCard[]): SantanderCard[] {
  const byAccount = new Map<string, SantanderCard>();
  for (const card of cards) {
    const key = `${card.entity}|${card.center}|${card.account}`;
    const current = byAccount.get(key);
    if (!current || (current.owner === "adicional" && card.owner === "titular")) {
      byAccount.set(key, card);
    }
  }
  return [...byAccount.values()];
}

interface SantanderStatementRef {
  NUMEXT?: string;
  FECHAEXT?: string;
  MONEDA?: string;
}

/** Numero del ultimo extracto en pesos, que es el que se pide facturado. */
export function latestStatementNumber(capture: unknown): string | undefined {
  const matrix = (
    capture as {
      DATA?: {
        AS_TIB_WM01_CONCuentasDisponibles?: { OUTPUT?: { MATRIZ?: SantanderStatementRef[] } };
      };
    }
  )?.DATA?.AS_TIB_WM01_CONCuentasDisponibles?.OUTPUT?.MATRIZ;
  if (!Array.isArray(matrix)) return undefined;
  // 152 es CLP en el codigo de moneda del banco; 840 es el extracto en dolares.
  const clp = matrix.filter((row) => (row.MONEDA || "152") === "152" && row.NUMEXT);
  if (clp.length === 0) return undefined;
  clp.sort((a, b) => (a.FECHAEXT || "").localeCompare(b.FECHAEXT || ""));
  return clp[clp.length - 1].NUMEXT;
}

interface SantanderStatementHeader {
  CupoPesos?: string;
  MontoUtilizado?: string;
  CupoDisponible?: string;
  FechaFactActual?: string;
  FechaVenc?: string;
  FechaProxFact?: string;
  DeudaTotalFact?: string;
  PagoMinimo?: string;
}

function statementHeader(capture: unknown): SantanderStatementHeader | undefined {
  return (
    capture as {
      DATA?: {
        AS_TIB_WM02_CONEstCtaNacional_Response?: {
          OUTPUT?: { RESPUESTA?: SantanderStatementHeader };
        };
      };
    }
  )?.DATA?.AS_TIB_WM02_CONEstCtaNacional_Response?.OUTPUT?.RESPUESTA;
}

/** Entero en pesos; el banco los manda con ceros a la izquierda. */
function statementAmount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return undefined;
  const value = parseInt(digits, 10);
  return raw.trim().endsWith("-") ? -value : value;
}

/**
 * Cupos y estado de cuenta de una tarjeta, leidos del encabezado del extracto.
 *
 * Es la unica fuente que trae cupo, deuda facturada, pago minimo y las tres
 * fechas del ciclo. El portal las muestra, pero solo si se le pide el extracto.
 */
export function buildSantanderCreditCard(
  card: SantanderCard,
  billedCapture: unknown,
  unbilled: BankMovement[],
): CreditCardBalance {
  const header = statementHeader(billedCapture);
  const total = statementAmount(header?.CupoPesos) ?? card.limitClp;
  const used = statementAmount(header?.MontoUtilizado);
  const available = statementAmount(header?.CupoDisponible);
  const billedAmount = statementAmount(header?.DeudaTotalFact);
  const billingDate = header?.FechaFactActual ? normalizeDate(header.FechaFactActual) : undefined;
  const dueDate = header?.FechaVenc ? normalizeDate(header.FechaVenc) : undefined;
  const minimumPayment = statementAmount(header?.PagoMinimo);
  const periodExpenses = unbilled
    .filter((m) => m.amount < 0)
    .reduce((sum, m) => sum + Math.abs(m.amount), 0);

  return {
    label: card.label,
    ...(total !== undefined && used !== undefined && available !== undefined
      ? { national: { used, available, total } }
      : {}),
    ...(header?.FechaProxFact ? { nextBillingDate: normalizeDate(header.FechaProxFact) } : {}),
    ...(periodExpenses > 0 ? { periodExpenses } : {}),
    ...(billingDate && dueDate && billedAmount !== undefined
      ? {
          lastStatement: {
            billingDate,
            billedAmount,
            dueDate,
            ...(minimumPayment !== undefined ? { minimumPayment } : {}),
          },
        }
      : {}),
  };
}

/** Reemplaza las coordenadas de tarjeta en el cuerpo grabado de una peticion. */
export function withCardCoordinates(
  template: unknown,
  card: SantanderCard,
  extra: Record<string, string> = {},
): unknown {
  if (!template || typeof template !== "object") return template;
  const clone = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;
  // Los tres endpoints nombran los mismos campos de forma distinta.
  const equivalents: Record<string, string> = {
    entidad: card.entity,
    codent: card.entity,
    codentidad: card.entity,
    centro: card.center,
    centalt: card.center,
    centroalt: card.center,
    cuenta: card.account,
    ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key.toLowerCase(), value])),
  };

  const patch = (node: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") {
        patch(value as Record<string, unknown>);
        continue;
      }
      const replacement = equivalents[key.toLowerCase()];
      if (replacement !== undefined) node[key] = replacement;
    }
  };
  patch(clone);
  return clone;
}

// Sidebar menu IDs — generated by Santander's Angular framework, may change
const SIDEBAR = {
  cuentas: "#menu-uid-0410",
  movimientos: "#menu-uid-0413",
  tarjetas: "#menu-uid-0420",
  misTc: ["#menu-uid-0421", "#menu-uid-042182"],
  maxX: 300,
};

const LOGIN_SELECTORS = {
  rutSelectors: ["#rut"],
  passwordSelectors: ["#pass"],
  rutFormat: "clean" as const,
};

const TWO_FACTOR_CONFIG = {
  timeoutEnvVar: "SANTANDER_2FA_TIMEOUT_SEC",
  frameFn: async (page: Page) => {
    const handle = await page.$("iframe#login-frame");
    return handle ? await handle.contentFrame() : null;
  },
};

// ─── Santander-specific helpers ──────────────────────────────────────

type MovementAccount = { index: number; label: string };

async function getLoginFrame(page: Page): Promise<Frame | null> {
  const handle = await page.$("iframe#login-frame");
  return handle ? await handle.contentFrame() : null;
}

async function listMovementAccounts(page: Page): Promise<MovementAccount[]> {
  return await page.evaluate(() => {
    const slides = Array.from(document.querySelectorAll("#tabs-carousel-movs .swiper-slide"));
    const out: Array<{ index: number; label: string }> = [];
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i] as HTMLElement;
      const text = slide.innerText?.replace(/\s+/g, " ").trim() || "";
      if (!text) continue;
      const typeMatch = text.match(/Cuenta\s+(Corriente|Vista)/i);
      const numberMatch = text.match(/\d(?:[\s.]\d+){3,}/);
      const type = typeMatch ? `Cuenta ${typeMatch[1]}` : "Cuenta";
      const number = numberMatch ? numberMatch[0].replace(/\s+/g, " ").trim() : `#${i + 1}`;
      out.push({ index: i, label: `${type} ${number}`.trim() });
    }
    return out;
  });
}

async function selectMovementAccount(page: Page, index: number): Promise<boolean> {
  const clicked = await page.evaluate((targetIndex: number) => {
    const byAria = document.querySelector(
      `#tabs-carousel-movs [aria-label='Go to slide ${targetIndex + 1}']`,
    ) as HTMLElement | null;
    if (byAria) { byAria.click(); return true; }

    const dots = Array.from(document.querySelectorAll("#tabs-carousel-movs .swiper-pagination-bullet"));
    if (dots[targetIndex]) { (dots[targetIndex] as HTMLElement).click(); return true; }

    const slides = Array.from(document.querySelectorAll("#tabs-carousel-movs .swiper-slide"));
    if (slides[targetIndex]) {
      const slide = slides[targetIndex] as HTMLElement;
      const clickable =
        (slide.querySelector(".container-account, .container-account-ccc, .container-image") as HTMLElement | null) ||
        slide;
      clickable.click();
      return true;
    }
    return false;
  }, index);

  if (!clicked) return false;
  await delay(1200);

  // Verify the correct slide activated
  const verify = async () =>
    page.evaluate(() => {
      const slides = Array.from(document.querySelectorAll("#tabs-carousel-movs .swiper-slide"));
      return slides.findIndex((s) => (s as HTMLElement).className.includes("swiper-slide-active"));
    });

  if ((await verify()) === index) return true;
  await delay(1800);
  return (await verify()) === index;
}

async function navigateToMovements(page: Page, debugLog: string[]): Promise<void> {
  // Try sidebar: Cuentas → Movimientos
  const cuentasClicked = await clickSidebarItem(
    page, [SIDEBAR.cuentas], ["cuentas"], SIDEBAR.maxX,
  );
  if (cuentasClicked) {
    debugLog.push("  Sidebar: Cuentas");
    await delay(2000);
  }

  const movClicked = await clickSidebarItem(
    page, [SIDEBAR.movimientos], ["movimientos"], SIDEBAR.maxX,
  );
  if (movClicked) {
    debugLog.push("  Sidebar: Movimientos");
    await delay(4500);
    return;
  }

  // Fallback: click account widget on dashboard
  const widgetSel = await clickWidget(page, [
    "#cuentas .box-product",
    "#cuentas .mat-ripple.box-product",
    "#cuentas .datos",
    "#cuentas .product-container .mat-ripple",
  ], 4500);
  if (widgetSel) {
    debugLog.push(`  Account widget: ${widgetSel}`);
    return;
  }

  // Last resort: TC movements widget
  const tcWidget = await clickWidget(page, [
    "#tarjetas-creditos .movement",
    "#tarjetas-creditos .menu-popup .movement",
    "#tarjetas-creditos .container-hover .movement",
  ], 4500);
  if (tcWidget) {
    debugLog.push(`  TC widget: ${tcWidget}`);
  } else {
    debugLog.push("  No direct movement entry point found from dashboard.");
  }
}

async function navigateToCreditCardSection(page: Page, debugLog: string[]): Promise<boolean> {
  // Open Tarjetas submenu
  const tarjetasClicked = await clickSidebarItem(
    page, [SIDEBAR.tarjetas], ["tarjetas"], SIDEBAR.maxX,
  );
  if (tarjetasClicked) {
    debugLog.push("  Tarjetas menu opened");
    await delay(1500);
  }

  // Click "Mis Tarjetas de Crédito"
  const tcClicked = await clickSidebarItem(
    page, SIDEBAR.misTc, ["mis tarjetas de crédito", "mis tarjetas de credito"], SIDEBAR.maxX,
  );
  if (tcClicked) {
    debugLog.push("  Opened 'Mis Tarjetas de Credito'");
    await delay(3500);
  }

  if (page.url().toLowerCase().includes("saldos_tc")) return true;

  // Fallback: dashboard TC widget
  const widget = await clickWidget(page, [
    "#tarjetas-creditos .movement",
    "#tarjetas-creditos .container-hover .movement",
    "#tarjetas-creditos .menu-popup .movement",
  ]);
  if (widget) {
    debugLog.push("  Opened TC from dashboard widget");
  }

  return page.url().toLowerCase().includes("saldos_tc");
}

/**
 * Movimientos y cupos de **todas** las tarjetas, no solo la que el portal abre.
 *
 * La interfaz muestra una tarjeta a la vez y el scraper solo veia esa: en una
 * cuenta con tres tarjetas, dos quedaban invisibles enteras -y con ellas sus
 * compras, sus cuotas y su deuda-. Cambiar de tarjeta en el carrusel no es
 * viable: depende de selectores que el banco cambia sin avisar.
 *
 * En vez de eso se repite la peticion que la propia pagina acaba de hacer,
 * cambiandole las coordenadas de la tarjeta. La sesion y las cabeceras son las
 * suyas, asi que el banco responde lo mismo que si el usuario hubiera hecho el
 * clic. Por cada tarjeta hacen falta tres: los no facturados, la lista de
 * extractos -el numero es obligatorio para pedir lo facturado- y el extracto.
 *
 * Si no hay plantilla que repetir devuelve vacio, y el scraper se queda con lo
 * que capturo de la tarjeta visible.
 */
async function collectAllCards(
  interceptor: Interceptor,
  cards: SantanderCard[],
  debugLog: string[],
  progress: (step: string) => void,
): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  const movements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  const unbilledTemplate = interceptor.lastRequestBody("santander-credit-card-unbilled");
  if (cards.length === 0 || unbilledTemplate === undefined) {
    debugLog.push(
      `  Multi-tarjeta: sin ${cards.length === 0 ? "lista de tarjetas" : "plantilla de consulta"}.`,
    );
    return { movements, creditCards };
  }

  const statementsTemplate = interceptor.lastRequestBody("santander-cc-statements");
  const billedTemplate = interceptor.lastRequestBody("santander-credit-card-billed");
  debugLog.push(`  Multi-tarjeta: ${cards.length} tarjeta(s) por consultar.`);

  for (const card of cards) {
    progress(`Extrayendo tarjeta ****${card.mask}...`);

    const unbilledCapture = await interceptor.replay(
      "santander-credit-card-unbilled",
      withCardCoordinates(unbilledTemplate, card),
    );
    const unbilled = unbilledCapture
      ? normalizeSantanderUnbilledApiMovements([unbilledCapture], card.mask)
      : [];
    movements.push(...unbilled);

    let billedCapture: unknown;
    if (statementsTemplate !== undefined && billedTemplate !== undefined) {
      const statements = await interceptor.replay(
        "santander-cc-statements",
        withCardCoordinates(statementsTemplate, card),
      );
      const statementNumber = statements ? latestStatementNumber(statements) : undefined;
      if (statementNumber) {
        billedCapture = await interceptor.replay(
          "santander-credit-card-billed",
          withCardCoordinates(billedTemplate, card, { NumExtracto: statementNumber }),
        );
        if (billedCapture) {
          movements.push(...normalizeSantanderBilledApiMovements([billedCapture]));
        }
      }
    }

    creditCards.push(buildSantanderCreditCard(card, billedCapture, unbilled));
    debugLog.push(
      `  ****${card.mask}: ${unbilled.length} por facturar, ` +
        `${billedCapture ? "extracto leido" : "sin extracto"}.`,
    );
  }

  return { movements, creditCards };
}

// ─── Main scrape function ────────────────────────────────────────────

async function scrapeSantander(
  session: BrowserSession,
  options: ScraperOptions,
): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots, onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const bank = "santander";
  const progress = onProgress || (() => {});

  // Install API interceptor before first page.goto()
  const interceptor = await createInterceptor(page, [
    { id: "santander-checking", urlPrefix: SANTANDER_CHECKING_API_PREFIX },
    { id: "santander-credit-card-unbilled", urlPrefix: SANTANDER_CC_API_PREFIX },
    { id: "santander-credit-card-billed", urlPrefix: SANTANDER_CC_BILLED_API_PREFIX },
    { id: "santander-cards", urlPrefix: SANTANDER_CARDS_API_PREFIX },
    { id: "santander-cc-statements", urlPrefix: SANTANDER_CC_STATEMENTS_API_PREFIX },
  ]);

  // 1. Navigate
  debugLog.push("1. Navigating to Santander...");
  progress("Abriendo sitio del banco...");
  await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);
  await dismissBanners(page);
  await doSave(page, "01-homepage");

  // 2. Open login
  debugLog.push("2. Opening login form...");
  const loginOpened =
    (await page.$eval("#btnIngresar", (el) => {
      (el as HTMLElement).click();
      return true;
    }).catch(() => false)) ||
    (await clickByText(page, [
      "ingresar", "acceso clientes", "banco en linea", "iniciar sesión", "iniciar sesion",
    ]));

  if (!loginOpened) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró el botón de ingreso.", screenshot: ss as string, debug: debugLog.join("\n") };
  }

  await delay(3500);
  await doSave(page, "02-login");

  // Detect login iframe
  const loginFrame = await getLoginFrame(page);
  const ctx = loginFrame || page;
  if (loginFrame) {
    debugLog.push("  Login iframe detectado.");
  }

  // Wait for login inputs
  try {
    await ctx.waitForSelector("#rut", { timeout: 15000 });
    await ctx.waitForSelector("#pass", { timeout: 15000 });
  } catch {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No cargaron los campos de login (#rut/#pass).", screenshot: ss as string, debug: debugLog.join("\n") };
  }

  // 3-5. Login
  debugLog.push("3. Filling RUT...");
  progress("Ingresando RUT...");
  const rutOk = await fillRut(ctx, rut, LOGIN_SELECTORS);
  if (!rutOk) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de RUT.", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(3500);

  debugLog.push("4. Filling password...");
  const passOk = await fillPassword(ctx, password, LOGIN_SELECTORS);
  if (!passOk) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de clave.", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(700);

  debugLog.push("5. Submitting login...");
  progress("Iniciando sesión...");
  await clickSubmit(ctx, page, LOGIN_SELECTORS);
  await delay(7000);
  await doSave(page, "03-post-login");

  // 2FA check
  if (await detect2FA(page, TWO_FACTOR_CONFIG)) {
    const approved = await waitFor2FA(page, debugLog, TWO_FACTOR_CONFIG);
    await doSave(page, "03b-after-2fa");
    if (!approved) {
      const ss = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, accounts: [], error: "Timeout esperando aprobación de 2FA.", screenshot: ss as string, debug: debugLog.join("\n") };
    }
  }

  // Login error check
  const loginError = await detectLoginError(page, await getLoginFrame(page));
  if (loginError) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: `Error del banco: ${loginError}`, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  debugLog.push("6. Login OK.");
  progress("Sesión iniciada correctamente");
  await closePopups(page);

  // 7. Navigate to movements
  debugLog.push("7. Navigating to movements...");
  progress("Extrayendo movimientos de cuenta...");
  await navigateToMovements(page, debugLog);
  await delay(4000);
  await doSave(page, "04-movements");

  // Multi-account handling
  const accounts = await listMovementAccounts(page);
  if (accounts.length > 0) {
    debugLog.push(`  Accounts: ${accounts.map((a) => a.label).join(" | ")}`);
  }

  let movements: BankMovement[] = [];

  // Try API interception for checking account
  const checkingCaptures = await interceptor.waitFor("santander-checking", 10_000);
  if (checkingCaptures.length > 0) {
    debugLog.push(`  Checking API: ${checkingCaptures.length} response(s) captured`);
    const apiMovements = normalizeSantanderCheckingApiMovements(checkingCaptures);
    debugLog.push(`  Checking API movements: ${apiMovements.length}`);
    if (apiMovements.length > 0) {
      movements.push(...apiMovements);
    }
  }

  if (movements.length === 0) {
    debugLog.push("  Checking API: no data, falling back to HTML extraction");
    if (accounts.length <= 1) {
      movements = await paginateAndExtract(page, extractAccountMovements, debugLog);
    } else {
      for (const account of accounts) {
        const switched = await selectMovementAccount(page, account.index);
        if (!switched) {
          debugLog.push(`  Could not switch to ${account.label}`);
          continue;
        }
        const acctMovements = await paginateAndExtract(page, extractAccountMovements, debugLog);
        movements.push(...acctMovements);
        debugLog.push(`  ${account.label}: ${acctMovements.length} movement(s)`);
      }
    }
  }
  movements = deduplicateMovements(movements);

  // 7b. Credit card movements
  debugLog.push("7b. Navigating to credit card movements...");
  progress("Extrayendo movimientos de tarjeta de crédito...");
  const tcReady = await navigateToCreditCardSection(page, debugLog);
  let creditCards: CreditCardBalance[] = [];
  if (tcReady) {
    // Las dos pestanas se visitan igual que antes, pero no por sus datos: de
    // aca salen las plantillas de peticion -URL, cabeceras y cuerpo- que
    // despues se repiten para cada tarjeta.
    const unbilledCaptures = (await clickTcTab(page, "movimientos por facturar"))
      ? await interceptor.waitFor("santander-credit-card-unbilled", 10_000)
      : [];
    const billedCaptures = (await clickTcTab(page, "movimientos facturados"))
      ? await interceptor.waitFor("santander-credit-card-billed", 10_000)
      : [];

    const cards = cardAccounts(parseSantanderCards(interceptor.getAll("santander-cards")));
    const perCard = await collectAllCards(interceptor, cards, debugLog, progress);

    if (perCard.movements.length > 0) {
      movements.push(...perCard.movements);
      creditCards = perCard.creditCards;
    } else {
      // Sin plantilla o sin lista de tarjetas queda lo de siempre: la tarjeta
      // que el portal muestre por omision.
      if (unbilledCaptures.length > 0) {
        const unbilled = normalizeSantanderUnbilledApiMovements(unbilledCaptures);
        movements.push(...unbilled);
        debugLog.push(`  CC API (unbilled): ${unbilled.length} movement(s)`);
      } else {
        debugLog.push("  CC API (unbilled): no data, falling back to HTML extraction");
        movements.push(...(await extractCreditCardMovements(page, "unbilled")));
      }
      if (billedCaptures.length > 0) {
        const billed = normalizeSantanderBilledApiMovements(billedCaptures);
        movements.push(...billed);
        debugLog.push(`  CC API (billed): ${billed.length} movement(s)`);
      } else {
        debugLog.push("  CC API (billed): no data, falling back to HTML extraction");
        movements.push(...(await extractCreditCardMovements(page, "billed")));
      }
    }
  } else {
    debugLog.push("  Could not open credit card section.");
  }
  movements = deduplicateMovements(movements);

  // 8. Balance
  let balance: number | undefined;
  const withBalance = movements.find((m) => m.balance > 0);
  if (withBalance) {
    balance = withBalance.balance;
    debugLog.push(`  Balance from movements: $${balance.toLocaleString("es-CL")}`);
  }
  if (balance === undefined || balance === 0) {
    balance = await extractBalance(page);
  }

  debugLog.push(`8. Extracted ${movements.length} movement(s)`);
  progress(`Listo — ${movements.length} movimientos totales`);
  debugLog.push(balance !== undefined ? `9. Balance: $${balance.toLocaleString("es-CL")}` : "9. Balance not found");

  await doSave(page, "05-final");
  const ss = doScreenshots ? ((await page.screenshot({ encoding: "base64", fullPage: true })) as string) : undefined;

  return {
    success: true,
    bank,
    accounts: [{ balance, movements }],
    ...(creditCards.length > 0 ? { creditCards } : {}),
    screenshot: ss,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────────

const santander: BankScraper = {
  id: "santander",
  name: "Banco Santander",
  url: BANK_URL,
  scrape: (options) => runScraper("santander", options, {}, scrapeSantander),
};

export default santander;
