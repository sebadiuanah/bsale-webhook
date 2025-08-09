"use strict";

/**
 * BSALE WEBHOOK / POLLER (URL HARDCODEADA)
 * - URL de Supabase fija para aislar problemas de env.
 * - La SERVICE_ROLE se toma de env (Render/locaL).
 */

const express = require("express");
const cors = require("cors");
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

// =====================
// Supabase (URL fija)
// =====================
const SUPABASE_URL = "https://fuuhzmhzzljprrhcsjbw.supabase.co"; // <- HARDCODE
const SUPABASE_SERVICE_ROLE_KEY =
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "").trim();

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Falta SUPABASE_SERVICE_ROLE_KEY en env. Cárgala en Render antes de continuar."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// =====================
// Parámetros del poller
// =====================
const ORDERS_TABLE = process.env.ORDERS_TABLE || "orders";
const START_DELAY_MS = Number(process.env.START_DELAY_MS || 10000); // 10s
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000); // 30s
const MAX_BATCH = Number(process.env.MAX_BATCH || 5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =====================
// Lógica de negocio
// =====================
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

// Placeholder: aquí iría tu integración real con Bsale
async function enviarABsale(order) {
  // TODO: llamada real a tu endpoint de Bsale
  await sleep(300); // simular latencia
  return { ok: true };
}

async function procesarOrden(order) {
  console.log("→ Procesando orden:", order.id, order.order_number);
  await marcarStatus(order.id, "processing");

  try {
    const resp = await enviarABsale(order);
    if (!resp || resp.ok !== true) throw new Error("Respuesta inválida de Bsale");

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
  if (!pendientes.length) return;
  for (const ord of pendientes) {
    await procesarOrden(ord);
  }
}

// =====================
// Poller
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
  console.log("/api/bsale recibido:", order_id, "→ poller ejecutará en", START_DELAY_MS, "ms");
  res.status(200).json({ ok: true });
});

// =====================
// Sanity check inicial
// =====================
(async () => {
  console.log("Sanity → URL fija:", SUPABASE_URL);
  console.log("Sanity → tiene service_role:", !!SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { error, count } = await supabase
      .from(ORDERS_TABLE)
      .select("id", { head: true, count: "exact" });

    if (error) {
      console.error("Supabase reachable pero error:", error);
    } else {
      console.log(`Supabase OK. ${ORDERS_TABLE} count estimado:`, count);
    }
  } catch (e) {
    console.error("Supabase network error:", e?.message || e);
  }
})();

// =====================
// Server
// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server up on :${PORT}`);
  startPoller();
});
