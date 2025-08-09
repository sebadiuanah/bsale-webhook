"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const https = require("https");
const dns = require("node:dns").promises;

const app = express();
app.use(cors({ origin: true, methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.use(express.json());

// =====================
// ENV y configuración
// =====================
const SUPABASE_URL_RAW = process.env.SUPABASE_URL || "";
const SUPABASE_URL = SUPABASE_URL_RAW.trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "").trim();

const ORDERS_TABLE = process.env.ORDERS_TABLE || "orders";
const START_DELAY_MS = Number(process.env.START_DELAY_MS || 10000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const MAX_BATCH = Number(process.env.MAX_BATCH || 5);

// === Snippet para mostrar códigos ASCII ===
function dumpCharCodes(label, s) {
  const codes = Array.from(s).map(ch => ch.charCodeAt(0));
  console.log(`${label} length=${s.length}`);
  console.log(`${label} codes=`, codes.join(','));
}
dumpCharCodes("SUPABASE_URL raw", SUPABASE_URL_RAW);
dumpCharCodes("SUPABASE_URL trim", SUPABASE_URL);

// =====================
// Cliente Supabase
// =====================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  const { error } = await supabase.from(ORDERS_TABLE).update({ status, ...extra }).eq("id", id);
  if (error) console.error(`No se pudo actualizar ${id} → ${status}:`, error);
}

async function enviarABsale(order) {
  await sleep(300);
  return { ok: true };
}

async function procesarOrden(order) {
  console.log("→ Procesando orden:", order.id, order.order_number);
  await marcarStatus(order.id, "processing");
  try {
    const resp = await enviarABsale(order);
    if (!resp?.ok) throw new Error("Respuesta inválida de Bsale");
    await marcarStatus(order.id, "processed", { processed_at: new Date().toISOString() });
    console.log("✔ Orden procesada:", order.id);
  } catch (e) {
    console.error("✖ Error procesando orden", order.id, e.message || e);
    await marcarStatus(order.id, "error", { error_message: String(e.message || e), error_at: new Date().toISOString() });
  }
}

async function procesarPendientes() {
  const pendientes = await getPendientes();
  if (!pendientes.length) return;
  for (const ord of pendientes) await procesarOrden(ord);
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
// Rutas
// =====================
app.get("/", (_req, res) => res.status(200).json({ ok: true, message: "bsale-webhook alive" }));
app.post("/api/bsale", async (req, res) => {
  const { order_id } = req.body || {};
  console.log("/api/bsale recibido:", order_id, "→ poller ejecutará en", START_DELAY_MS, "ms");
  res.status(200).json({ ok: true });
});

// =====================
// Diagnóstico de red/URL
// =====================
(async () => {
  console.log("SB precheck → url:", !!SUPABASE_URL, " key:", !!SUPABASE_SERVICE_ROLE_KEY, " node:", process.version);
  console.log(`SUPABASE_URL raw: >${SUPABASE_URL_RAW}< len=${SUPABASE_URL_RAW.length}`);
  console.log(`SUPABASE_URL trim: >${SUPABASE_URL}< len=${SUPABASE_URL.length}`);

  try {
    const parsed = new URL(SUPABASE_URL);
    console.log("Parsed host:", JSON.stringify(parsed.hostname));
    try {
      const ip = await dns.lookup(parsed.hostname, { all: true });
      console.log("DNS lookup:", ip);
    } catch (e) {
      console.error("DNS lookup fail:", e.code, e.message);
    }
  } catch (e) {
    console.error("URL inválida (no parsea):", e.message);
  }

  const agent = new https.Agent({ keepAlive: true });
  const base = SUPABASE_URL.replace(/\/+$/, "");
  const health = `${base}/auth/v1/health`;

  try {
    const r1 = await fetch("https://www.google.com", { agent });
    console.log("NET google.com:", r1.status);
  } catch (e) {
    console.error("NET google.com fail:", e?.message, e?.cause?.code);
  }

  try {
    const r2 = await fetch(health, { agent });
    console.log("NET supabase health:", r2.status);
  } catch (e) {
    console.error("NET supabase fail:", e?.message, e?.cause?.code);
  }

  try {
    const { error, count } = await supabase.from(ORDERS_TABLE).select("id", { head: true, count: "exact" });
    if (error) console.error("SB reachable pero error de Supabase:", error);
    else console.log(`SB reachable, ${ORDERS_TABLE} count estimado:`, count);
  } catch (e) {
    console.error("SB network error (fetch failed):", e?.message, e?.cause?.code || "", e?.cause?.errno || "");
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
