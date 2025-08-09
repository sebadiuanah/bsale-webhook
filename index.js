"use strict";

/**
 * BSALE WEBHOOK / POLLER
 * - Lee órdenes "pending" desde Supabase y las procesa en un loop.
 * - Endpoint POST /api/bsale para recibir la señal de nueva orden.
 * - Usa SERVICE ROLE en backend (NUNCA publiques esa key en el código/repo).
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios"); // placeholder si quieres llamar a Bsale
const { createClient } = require("@supabase/supabase-js");

// =====================
// Configuración general
// =====================
const app = express();
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

// Variables de entorno requeridas
const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://<tu-proyecto>.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

// Nombres de tabla y tiempos
const ORDERS_TABLE = process.env.ORDERS_TABLE || "orders";
const START_DELAY_MS = Number(process.env.START_DELAY_MS || 10000); // 10s
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000); // 30s
const MAX_BATCH = Number(process.env.MAX_BATCH || 5);

// =====================
// Supabase client
// =====================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// =====================
// Helpers
// =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPendientes(limit = MAX_BATCH) {
  try {
    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .select("id, order_number, status")
      .eq("status", "pending")
      .order("id", { ascending: true })
      .limit(limit);

    if (error) throw error;
    return data || [];
  } catch (e) {
    console.error("Poller select error:", e.message || e);
    return [];
  }
}

async function marcarStatus(id, status, extra = {}) {
  const { error } = await supabase
    .from(ORDERS_TABLE)
    .update({ status, ...extra })
    .eq("id", id);
  if (error) {
    console.error(`No se pudo actualizar status de ${id} → ${status}:`, error);
  }
}

// Placeholder: aquí iría tu llamada real a Bsale
async function enviarABsale(order) {
  // Ejemplo ficticio:
  // const resp = await axios.post("https://bsale.tu-endpoint/api/nota-venta", { ...payload });
  // return resp.data;
  await sleep(500); // simular latencia
  return { ok: true };
}

async function procesarOrden(order) {
  console.log("→ Procesando orden:", order.id, order.order_number);

  // (opcional) marca en "processing" para evitar duplicados si el poller corre en paralelo
  await marcarStatus(order.id, "processing");

  try {
    const resp = await enviarABsale(order);

    if (!resp || resp.ok !== true) {
      throw new Error("Respuesta inválida de Bsale");
    }

    // Si todo OK
    await marcarStatus(order.id, "processed", {
      processed_at: new Date().toISOString(),
    });
    console.log("✔ Orden procesada:", order.id);
  } catch (e) {
    console.error("✖ Error procesando orden", order.id, e.message || e);
    await marcarStatus(order.id, "error", {
      error_message: String(e.message || e),
      error_at: new Date().toISOString(),
    });
  }
}

async function procesarPendientes() {
  const pendientes = await getPendientes();
  if (!pendientes.length) {
    return;
  }
  for (const ord of pendientes) {
    await procesarOrden(ord);
  }
}

// =====================
// Poller loop
// =====================
async function startPoller() {
  console.log("Poller arrancando en", START_DELAY_MS, "ms");
  await sleep(START_DELAY_MS);

  setInterval(async () => {
    console.log("Poller tick", new Date().toISOString());
    await procesarPendientes();
  }, POLL_INTERVAL_MS);
}

// =====================
// Rutas HTTP
// =====================
app.get("/", (_req, res) => {
  res.status(200).json({ ok: true, message: "bsale-webhook alive" });
});

app.post("/api/bsale", async (req, res) => {
  const { order_id } = req.body || {};
  console.log(
    "/api/bsale recibido:",
    order_id,
    "→ poller ejecutará en",
    START_DELAY_MS,
    "ms"
  );
  // No procesamos sincrónicamente aquí para no bloquear la respuesta
  res.status(200).json({ ok: true });
});

// =====================
// Precheck de conexión
// =====================
(async () => {
  const hasUrl = !!SUPABASE_URL;
  const hasKey = !!SUPABASE_SERVICE_ROLE_KEY;
  console.log("SB precheck → url:", hasUrl, " key:", hasKey, " node:", process.version);

  try {
    const { error, count } = await supabase
      .from(ORDERS_TABLE)
      .select("id", { head: true, count: "exact" });

    if (error) {
      console.error("SB reachable pero error de Supabase:", error);
    } else {
      console.log(`SB reachable, ${ORDERS_TABLE} count estimado:`, count);
    }
  } catch (e) {
    console.error("SB network error (causa 'fetch failed'):", e?.message || e);
  }
})();

// =====================
// Server bootstrap
// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server up on :${PORT}`);
  startPoller();
});
