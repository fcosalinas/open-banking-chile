import { describe, it, expect } from "vitest";
import { MOVEMENT_SOURCE } from "../types.js";
import {
  buildSantanderCreditCard,
  cardAccounts,
  isSaldoInicial,
  latestStatementNumber,
  maskOfPan,
  normalizeSantanderCheckingApiMovements,
  normalizeSantanderUnbilledApiMovements,
  normalizeSantanderBilledApiMovements,
  parseSantanderCards,
  withCardCoordinates,
} from "./santander.js";

// ─── isSaldoInicial ──────────────────────────────────────────────

describe("isSaldoInicial", () => {
  it("matches exact casing", () => {
    expect(isSaldoInicial("Saldo Inicial")).toBe(true);
  });

  it("matches lower case", () => {
    expect(isSaldoInicial("saldo inicial")).toBe(true);
  });

  it("matches upper case", () => {
    expect(isSaldoInicial("SALDO INICIAL")).toBe(true);
  });

  it("matches with extra whitespace between words", () => {
    expect(isSaldoInicial("saldo  inicial")).toBe(true);
  });

  it("does not match regular transactions", () => {
    expect(isSaldoInicial("Compra supermercado")).toBe(false);
    expect(isSaldoInicial("Pago tarjeta")).toBe(false);
    expect(isSaldoInicial("saldo disponible")).toBe(false);
  });
});

// ─── normalizeSantanderCheckingApiMovements ──────────────────────

describe("normalizeSantanderCheckingApiMovements", () => {
  it("returns empty array for empty captures", () => {
    expect(normalizeSantanderCheckingApiMovements([])).toEqual([]);
  });

  it("skips captures without a movements array", () => {
    expect(normalizeSantanderCheckingApiMovements([{ other: "data" }])).toEqual([]);
    expect(normalizeSantanderCheckingApiMovements([null])).toEqual([]);
  });

  it("parses a debit movement (chargePaymentFlag=D)", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-01-15",
          movementAmount: "00000300000",
          chargePaymentFlag: "D",
          observation: "Supermercado Lider",
          expandedCode: "",
        },
      ],
    };
    const result = normalizeSantanderCheckingApiMovements([capture]);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBeLessThan(0);
    expect(result[0].description).toBe("Supermercado Lider");
    expect(result[0].source).toBe(MOVEMENT_SOURCE.account);
    // normalizeDate doesn't handle YYYY-MM-DD (no regex match), passes through as-is
    expect(result[0].date).toBe("2026-01-15");
  });

  it("parses a credit movement (chargePaymentFlag=H)", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-02-10",
          movementAmount: "00000500000",
          chargePaymentFlag: "H",
          observation: "Depósito sueldo",
          expandedCode: "",
        },
      ],
    };
    const result = normalizeSantanderCheckingApiMovements([capture]);
    expect(result[0].amount).toBeGreaterThan(0);
  });

  it("detects debit from trailing minus sign when flag is missing", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-03-01",
          movementAmount: "00000100000-",
          chargePaymentFlag: "H", // contradictory — trailing minus wins via original logic
          observation: "Cargo",
          expandedCode: "",
        },
      ],
    };
    const result = normalizeSantanderCheckingApiMovements([capture]);
    // The trailing '-' takes precedence in the original logic
    expect(result[0].amount).toBeLessThan(0);
  });

  it("converts centavos to pesos (divides by 100)", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-01-01",
          movementAmount: "00000500000", // 500000 centavos = 5000 pesos
          chargePaymentFlag: "D",
          observation: "Test",
          expandedCode: "",
        },
      ],
    };
    const result = normalizeSantanderCheckingApiMovements([capture]);
    expect(result[0].amount).toBe(-5000);
  });

  it("extracts balance from newBalance field", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-01-01",
          movementAmount: "00000100000",
          chargePaymentFlag: "D",
          observation: "Test",
          expandedCode: "",
          newBalance: "10000000", // 10_000_000 centavos = 100_000 pesos
        },
      ],
    };
    const result = normalizeSantanderCheckingApiMovements([capture]);
    // 10_000_000 centavos / 100 = 100_000 pesos
    expect(result[0].balance).toBe(100000);
  });

  it("falls back to expandedCode when observation is empty", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-01-01",
          movementAmount: "00000100000",
          chargePaymentFlag: "D",
          observation: "",
          expandedCode: "Descripción expandida",
        },
      ],
    };
    const result = normalizeSantanderCheckingApiMovements([capture]);
    expect(result[0].description).toBe("Descripción expandida");
  });

  it("skips movements with zero or invalid amount", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-01-01",
          movementAmount: "00000000000",
          chargePaymentFlag: "D",
          observation: "Zero",
          expandedCode: "",
        },
      ],
    };
    expect(normalizeSantanderCheckingApiMovements([capture])).toHaveLength(0);
  });

  it("accumulates movements across multiple captures", () => {
    const makeCapture = (obs: string) => ({
      movements: [
        { transactionDate: "2026-01-01", movementAmount: "00000100000", chargePaymentFlag: "D", observation: obs, expandedCode: "" },
      ],
    });
    const result = normalizeSantanderCheckingApiMovements([makeCapture("A"), makeCapture("B")]);
    expect(result).toHaveLength(2);
  });
});

// ─── normalizeSantanderUnbilledApiMovements ──────────────────────

describe("normalizeSantanderUnbilledApiMovements", () => {
  it("returns empty array for empty captures", () => {
    expect(normalizeSantanderUnbilledApiMovements([])).toEqual([]);
  });

  it("parses a debit CC movement (IndicadorDebeHaber=D)", () => {
    const capture = {
      DATA: {
        MatrizMovimientos: [
          { Fecha: "15/01/2026", Comercio: "Netflix", Descripcion: "", Importe: "15.990", IndicadorDebeHaber: "D" },
        ],
      },
    };
    const result = normalizeSantanderUnbilledApiMovements([capture]);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(-15990);
    expect(result[0].description).toBe("Netflix");
    expect(result[0].source).toBe(MOVEMENT_SOURCE.credit_card_unbilled);
    expect(result[0].date).toBe("15-01-2026");
    expect(result[0].balance).toBe(0);
  });

  it("parses a credit movement (IndicadorDebeHaber=H)", () => {
    const capture = {
      DATA: {
        MatrizMovimientos: [
          { Fecha: "20/01/2026", Comercio: "Nota crédito", Descripcion: "", Importe: "5.000", IndicadorDebeHaber: "H" },
        ],
      },
    };
    const result = normalizeSantanderUnbilledApiMovements([capture]);
    expect(result[0].amount).toBeGreaterThan(0);
  });

  it("falls back to Descripcion when Comercio is empty", () => {
    const capture = {
      DATA: {
        MatrizMovimientos: [
          { Fecha: "01/02/2026", Comercio: "", Descripcion: "Pago online", Importe: "1.000", IndicadorDebeHaber: "D" },
        ],
      },
    };
    const result = normalizeSantanderUnbilledApiMovements([capture]);
    expect(result[0].description).toBe("Pago online");
  });

  it("filters out Saldo Inicial rows", () => {
    const capture = {
      DATA: {
        MatrizMovimientos: [
          { Fecha: "01/01/2026", Comercio: "Saldo Inicial", Descripcion: "", Importe: "100.000", IndicadorDebeHaber: "D" },
          { Fecha: "02/01/2026", Comercio: "Tienda", Descripcion: "", Importe: "5.000", IndicadorDebeHaber: "D" },
        ],
      },
    };
    const result = normalizeSantanderUnbilledApiMovements([capture]);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("Tienda");
  });

  it("skips captures with missing or malformed DATA path", () => {
    expect(normalizeSantanderUnbilledApiMovements([{}])).toEqual([]);
    expect(normalizeSantanderUnbilledApiMovements([{ DATA: {} }])).toEqual([]);
    expect(normalizeSantanderUnbilledApiMovements([{ DATA: { MatrizMovimientos: null } }])).toEqual([]);
  });

  it("skips movements with zero amount", () => {
    const capture = {
      DATA: {
        MatrizMovimientos: [
          { Fecha: "01/01/2026", Comercio: "Zero", Descripcion: "", Importe: "0", IndicadorDebeHaber: "D" },
        ],
      },
    };
    expect(normalizeSantanderUnbilledApiMovements([capture])).toHaveLength(0);
  });
});

// ─── normalizeSantanderBilledApiMovements ────────────────────────

describe("normalizeSantanderBilledApiMovements", () => {
  const makeCapture = (overrides: object[]) => ({
    DATA: {
      AS_TIB_WM02_CONEstCtaNacional_Response: {
        OUTPUT: {
          Matriz: overrides,
        },
      },
    },
  });

  it("returns empty array for empty captures", () => {
    expect(normalizeSantanderBilledApiMovements([])).toEqual([]);
  });

  it("parses a regular purchase (negative amount)", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-01-20", NombreComercio: "Farmacia Cruz Verde", MontoTxs: "0000025000", NumeroCuotas: "00", TotalCuotas: "00" },
    ]);
    const result = normalizeSantanderBilledApiMovements([capture]);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(-25000);
    expect(result[0].description).toBe("Farmacia Cruz Verde");
    expect(result[0].source).toBe(MOVEMENT_SOURCE.credit_card_billed);
    // normalizeDate doesn't handle YYYY-MM-DD (no regex match), passes through as-is
    expect(result[0].date).toBe("2026-01-20");
    expect(result[0].balance).toBe(0);
  });

  it("treats 'Monto Cancelado' as a positive payment", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-01-25", NombreComercio: "Monto Cancelado", MontoTxs: "0000200000", NumeroCuotas: "00", TotalCuotas: "00" },
    ]);
    const result = normalizeSantanderBilledApiMovements([capture]);
    expect(result[0].amount).toBeGreaterThan(0);
    expect(result[0].amount).toBe(200000);
  });

  it("parses Chilean thousands format (dots as separators)", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-02-01", NombreComercio: "Compra", MontoTxs: "50.000", NumeroCuotas: "00", TotalCuotas: "00" },
    ]);
    const result = normalizeSantanderBilledApiMovements([capture]);
    expect(result[0].amount).toBe(-50000);
  });

  it("includes installments field when TotalCuotas > 0", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-01-10", NombreComercio: "Notebook", MontoTxs: "0000100000", NumeroCuotas: "01", TotalCuotas: "06" },
    ]);
    const result = normalizeSantanderBilledApiMovements([capture]);
    expect(result[0].installments).toBe("01/06");
  });

  it("omits installments field when TotalCuotas is 0", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-01-10", NombreComercio: "Café", MontoTxs: "0000003500", NumeroCuotas: "00", TotalCuotas: "00" },
    ]);
    const result = normalizeSantanderBilledApiMovements([capture]);
    expect(result[0].installments).toBeUndefined();
  });

  it("filters out Saldo Inicial rows", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-01-01", NombreComercio: "Saldo Inicial", MontoTxs: "0000050000", NumeroCuotas: "00", TotalCuotas: "00" },
      { FechaTxs: "2026-01-05", NombreComercio: "Amazon", MontoTxs: "0000029990", NumeroCuotas: "00", TotalCuotas: "00" },
    ]);
    const result = normalizeSantanderBilledApiMovements([capture]);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("Amazon");
  });

  it("skips movements with zero amount", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-01-01", NombreComercio: "Zero", MontoTxs: "0000000000", NumeroCuotas: "00", TotalCuotas: "00" },
    ]);
    expect(normalizeSantanderBilledApiMovements([capture])).toHaveLength(0);
  });

  it("skips captures with missing nested path", () => {
    expect(normalizeSantanderBilledApiMovements([{}])).toEqual([]);
    expect(normalizeSantanderBilledApiMovements([{ DATA: {} }])).toEqual([]);
  });
});


// ─── Saldo negativo de la cuenta corriente ───────────────────────

describe("normalizeSantanderCheckingApiMovements · saldo negativo", () => {
  it("conserva el signo del saldo cuando la cuenta queda en rojo", () => {
    // El banco marca el negativo con un guion al final, igual que en el monto.
    // Descartarlo dejaba una cuenta en rojo leyendose como si tuviera plata.
    const captures = [
      {
        movements: [
          {
            transactionDate: "2026-08-21",
            movementAmount: "00000002000000-",
            chargePaymentFlag: "D",
            newBalance: "00000002000000-",
            observation: "AMORTIZACION PERIODICA LCA",
            expandedCode: "",
          },
        ],
      },
    ];

    const [movement] = normalizeSantanderCheckingApiMovements(captures);
    expect(movement.amount).toBe(-20000);
    expect(movement.balance).toBe(-20000);
  });

  it("deja intacto el saldo positivo", () => {
    const captures = [
      {
        movements: [
          {
            transactionDate: "2026-09-07",
            movementAmount: "00000013706600-",
            chargePaymentFlag: "D",
            newBalance: "000000049104100",
            observation: "PAGO CUOTA CREDITO CONSUMO",
            expandedCode: "",
          },
        ],
      },
    ];

    expect(normalizeSantanderCheckingApiMovements(captures)[0].balance).toBe(491041);
  });
});

// ─── Atribucion por tarjeta ──────────────────────────────────────

describe("maskOfPan", () => {
  it("saca los ultimos cuatro digitos del PAN", () => {
    expect(maskOfPan("240004#375833608")).toBe("3608");
  });

  it("devuelve undefined si no hay PAN utilizable", () => {
    expect(maskOfPan(undefined)).toBeUndefined();
    expect(maskOfPan("###")).toBeUndefined();
  });
});

describe("normalizeSantanderBilledApiMovements · tarjeta", () => {
  it("atribuye cada movimiento al plastico que lo hizo", () => {
    const captures = [
      {
        DATA: {
          AS_TIB_WM02_CONEstCtaNacional_Response: {
            OUTPUT: {
              Matriz: [
                {
                  FechaTxs: "2026-07-27",
                  NombreComercio: "NORMALIZA S.A.",
                  MontoTxs: "0000363359",
                  NumeroCuotas: "00",
                  TotalCuotas: "00",
                  Pan: "240004#375833608",
                },
              ],
            },
          },
        },
      },
    ];

    const [movement] = normalizeSantanderBilledApiMovements(captures);
    expect(movement.card).toBe("3608");
    expect(movement.amount).toBe(-363359);
  });
});

describe("normalizeSantanderUnbilledApiMovements · tarjeta y titular", () => {
  const captures = [
    {
      DATA: {
        MatrizMovimientos: [
          {
            Fecha: "09/09/2026",
            Descripcion: "COMPRA NORMAL",
            Comercio: "EASY LA UNION",
            Importe: "51.274",
            IndicadorDebeHaber: "D",
            TipoBen: "Titular",
          },
          {
            Fecha: "08/09/2026",
            Descripcion: "COMPRA NORMAL",
            Comercio: "SANTA ISABEL LA",
            Importe: "61.282",
            IndicadorDebeHaber: "D",
            TipoBen: null,
          },
        ],
      },
    },
  ];

  it("marca la tarjeta consultada, porque el movimiento no la trae", () => {
    const movements = normalizeSantanderUnbilledApiMovements(captures, "3608");
    expect(movements.map((m) => m.card)).toEqual(["3608", "3608"]);
  });

  it("distingue titular de adicional solo cuando el banco lo dice", () => {
    const movements = normalizeSantanderUnbilledApiMovements(captures, "3608");
    expect(movements[0].owner).toBe("titular");
    expect(movements[1].owner).toBeUndefined();
  });
});

// ─── Lista de tarjetas ───────────────────────────────────────────

const CARD_DEVICES = [
  {
    output: [
      {
        debitOrCreditCard: "C",
        entityCode: "0035",
        emissionCenter: "0163",
        accountNumber: "800057682363",
        cardNumber: "240778#067766548",
        beneficiaryNumber: "00001",
        productComment: "Visa Platinum LATAM Pass",
        limitCenterPesos: "0000001000000",
        limitContractUSD: "000000000149000",
      },
      {
        debitOrCreditCard: "C",
        entityCode: "0035",
        emissionCenter: "0263",
        accountNumber: "800059383201",
        cardNumber: "240004#375830165",
        beneficiaryNumber: "00002",
        productComment: "WorldMember Limited Visa",
        limitCenterPesos: "0000010000000",
        limitContractUSD: "000000000500000",
      },
      {
        debitOrCreditCard: "C",
        entityCode: "0035",
        emissionCenter: "0263",
        accountNumber: "800059383201",
        cardNumber: "240004#375833608",
        beneficiaryNumber: "00001",
        productComment: "WorldMember Limited Visa",
        limitCenterPesos: "0000010000000",
        limitContractUSD: "000000000500000",
      },
      {
        debitOrCreditCard: "D",
        entityCode: "0035",
        emissionCenter: "0163",
        accountNumber: "000069489788",
        cardNumber: "111111#111111111",
        beneficiaryNumber: "00001",
        productComment: "Tarjeta de débito",
      },
    ],
  },
];

describe("parseSantanderCards", () => {
  it("lee las coordenadas con que se consulta cada tarjeta", () => {
    const cards = parseSantanderCards(CARD_DEVICES);
    expect(cards.map((c) => c.mask)).toEqual(["6548", "0165", "3608"]);
    expect(cards[2]).toMatchObject({
      entity: "0035",
      center: "0263",
      account: "800059383201",
      owner: "titular",
      limitClp: 10000000,
      limitUsd: 5000,
    });
  });

  it("deja fuera las tarjetas de débito", () => {
    expect(parseSantanderCards(CARD_DEVICES).some((c) => c.label.includes("débito"))).toBe(false);
  });

  it("no se cae con una captura vacía", () => {
    expect(parseSantanderCards([{}, null, { output: "no es lista" }])).toEqual([]);
  });
});

describe("cardAccounts", () => {
  it("consulta una vez por cuenta, no una vez por plástico", () => {
    // El titular y su adicional comparten cuenta: los movimientos vienen juntos
    // y pedirlos dos veces los duplicaría.
    const accounts = cardAccounts(parseSantanderCards(CARD_DEVICES));
    expect(accounts.map((c) => c.mask)).toEqual(["6548", "3608"]);
  });

  it("deja de cara al titular aunque el adicional venga primero", () => {
    const accounts = cardAccounts(parseSantanderCards(CARD_DEVICES));
    expect(accounts[1].owner).toBe("titular");
  });
});

// ─── Extractos ───────────────────────────────────────────────────

const STATEMENTS = {
  DATA: {
    AS_TIB_WM01_CONCuentasDisponibles: {
      OUTPUT: {
        MATRIZ: [
          { NUMEXT: "087", FECHAEXT: "2026-07-25", MONEDA: "152" },
          { NUMEXT: "088", FECHAEXT: "2026-08-25", MONEDA: "152" },
          { NUMEXT: "040", FECHAEXT: "2026-08-25", MONEDA: "840" },
        ],
      },
    },
  },
};

describe("latestStatementNumber", () => {
  it("elige el último extracto en pesos", () => {
    expect(latestStatementNumber(STATEMENTS)).toBe("088");
  });

  it("devuelve undefined si no hay extractos", () => {
    expect(latestStatementNumber({})).toBeUndefined();
  });
});

// ─── Cupos y estado de cuenta ────────────────────────────────────

describe("buildSantanderCreditCard", () => {
  const card = {
    entity: "0035",
    center: "0263",
    account: "800059383201",
    mask: "3608",
    label: "WorldMember Limited Visa ****3608",
    owner: "titular" as const,
    limitClp: 10000000,
  };

  const billed = {
    DATA: {
      AS_TIB_WM02_CONEstCtaNacional_Response: {
        OUTPUT: {
          RESPUESTA: {
            CupoPesos: "000010000000",
            MontoUtilizado: "00004000077",
            CupoDisponible: "00005999923",
            FechaFactActual: "2026-08-25",
            FechaVenc: "2026-09-09",
            FechaProxFact: "2026-09-24",
            DeudaTotalFact: "00004000077",
            PagoMinimo: "000001424700",
          },
        },
      },
    },
  };

  it("lee cupo, deuda y fechas del encabezado del extracto", () => {
    const result = buildSantanderCreditCard(card, billed, []);
    expect(result.national).toEqual({ used: 4000077, available: 5999923, total: 10000000 });
    // El banco manda estas fechas en ISO y normalizeDate deja el ISO como esta,
    // igual que hace con los movimientos de cuenta corriente.
    expect(result.nextBillingDate).toBe("2026-09-24");
    expect(result.lastStatement).toEqual({
      billingDate: "2026-08-25",
      billedAmount: 4000077,
      dueDate: "2026-09-09",
      minimumPayment: 1424700,
    });
  });

  it("suma los cargos por facturar como gasto del período", () => {
    const unbilled = normalizeSantanderUnbilledApiMovements(
      [
        {
          DATA: {
            MatrizMovimientos: [
              { Fecha: "09/09/2026", Descripcion: "COMPRA", Comercio: "EASY", Importe: "51.274", IndicadorDebeHaber: "D" },
              { Fecha: "05/09/2026", Descripcion: "PAGO", Comercio: "PAGO", Importe: "109.784", IndicadorDebeHaber: "H" },
            ],
          },
        },
      ],
      "3608",
    );
    // El abono no es gasto del período: solo se suman los cargos.
    expect(buildSantanderCreditCard(card, billed, unbilled).periodExpenses).toBe(51274);
  });

  it("sin extracto entrega la tarjeta igual, sin inventar cupos", () => {
    const result = buildSantanderCreditCard(card, undefined, []);
    expect(result.label).toBe("WorldMember Limited Visa ****3608");
    expect(result.national).toBeUndefined();
    expect(result.lastStatement).toBeUndefined();
  });
});

// ─── Repetir la consulta para otra tarjeta ───────────────────────

describe("withCardCoordinates", () => {
  const card = {
    entity: "0035",
    center: "0263",
    account: "800059383201",
    mask: "3608",
    label: "WorldMember Limited Visa ****3608",
    owner: "titular" as const,
  };

  it("cambia las coordenadas sin tocar el resto del cuerpo", () => {
    const template = {
      Cabecera: { RutCliente: "00011111111", HOST: { "CANAL-ID": "003" } },
      Entrada: { Entidad: "0035", Centro: "0163", Cuenta: "800058891141", Moneda: "CLP" },
    };

    expect(withCardCoordinates(template, card)).toEqual({
      Cabecera: { RutCliente: "00011111111", HOST: { "CANAL-ID": "003" } },
      Entrada: { Entidad: "0035", Centro: "0263", Cuenta: "800059383201", Moneda: "CLP" },
    });
  });

  it("entiende los otros nombres que el banco le da a los mismos campos", () => {
    const template = { INPUT: { CODENT: "0035", CENTALT: "0163", CUENTA: "800058891141", PAN: "" } };
    expect(withCardCoordinates(template, card)).toEqual({
      INPUT: { CODENT: "0035", CENTALT: "0263", CUENTA: "800059383201", PAN: "" },
    });
  });

  it("acepta campos extra, como el número de extracto", () => {
    const template = { INPUT: { CentAlt: "0163", Cuenta: "800058891141", NumExtracto: "088" } };
    expect(withCardCoordinates(template, card, { NumExtracto: "080" })).toEqual({
      INPUT: { CentAlt: "0263", Cuenta: "800059383201", NumExtracto: "080" },
    });
  });

  it("no muta la plantilla original", () => {
    const template = { Entrada: { Centro: "0163", Cuenta: "800058891141" } };
    withCardCoordinates(template, card);
    expect(template.Entrada.Centro).toBe("0163");
  });
});
