require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

// Configuración del poller
const START_DELAY_MS   = Number(process.env.START_DELAY_MS || 10000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const MAX_BATCH        = Number(process.env.MAX_BATCH || 5);

// Helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log   = (...args) => console.log(...args);
const warn  = (...args) => console.warn(...args);
const errlog= (...args) => console.error(...args);

// ====== Ping a Supabase al inicio ======
(async () => {
  const urlOk = !!process.env.SUPABASE_URL;
  const svcOk = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);
  log('Sanity → URL fija:', process.env.SUPABASE_URL, '\nSanity → tiene service_role:', svcOk);

  try {
    const rest = `${process.env.SUPABASE_URL.replace(/\/+$/,'')}/rest/v1/`;
    const r = await fetch(rest, {
      method: 'GET',
      headers: { apikey: (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY) }
    });
    log('Ping REST Supabase:', r.status, rest);
  } catch (e) {
    errlog('× No se pudo hacer ping a Supabase REST:', e?.cause?.code || e.message);
  }

  const { count } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .in('status', ['pending', 'processing', 'error'])
    .is('processed_at', null);

  log('Supabase OK. orders count estimado:', count ?? 0);
})();

// ====== Lógica de creación en Bsale (dummy para ejemplo) ======
async function procesarOrden(order) {
  // Cargar items
  const { data: items, error: eItems } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', order.id);

  if (eItems) {
    errlog('× Error cargando items:', eItems);
    await supabase.from('orders').update({
      status: 'error',
      last_error: `items: ${eItems.message}`
    }).eq('id', order.id);
    return;
  }

  // Aquí iría tu POST a Bsale
  log(`→ Simulando creación en Bsale para orden ${order.id}`);

  // Simulación de éxito:
  const noteId = 99999;

  await supabase.from('orders').update({
    status: 'processed',
    processed_at: new Date().toISOString(),
    bsale_note_id: String(noteId),
    bsale_response: { simulated: true },
    last_error: null,
  }).eq('id', order.id);

  log(`✓ Orden procesada: ${order.id} → Nota Bsale #${noteId}`);
}

// ====== Poller con manejo de errores ======
async function pollerTick() {
  log('Poller tick', new Date().toISOString());
  try {
    const { data: pendientes, error } = await supabase
      .from('orders')
      .select('*')
      .in('status', ['pending','processing','error'])
      .is('processed_at', null)
      .limit(MAX_BATCH);

    if (error) {
      errlog('× Error consultando órdenes pendientes (PostgREST):', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code
      });
      return;
    }

    if (!pendientes?.length) return;
    for (const o of pendientes) {
      try {
        log('→ Procesando orden:', o.id, o.order_number || '');
        await supabase.from('orders').update({ status: 'processing' }).eq('id', o.id);
        await procesarOrden(o);
      } catch (e) {
        errlog('× Excepción procesando orden', o.id, e);
        await supabase.from('orders').update({
          status: 'error',
          last_error: `exception: ${e?.message || e}`
        }).eq('id', o.id);
      }
    }
  } catch (e) {
    errlog('× Error consultando órdenes pendientes:', {
      message: String(e.message || e),
      cause_code: e?.cause?.code || '',
      cause_errno: e?.cause?.errno || '',
      url: process.env.SUPABASE_URL
    });
  }
}

// ====== Arranque del poller ======
setTimeout(() => {
  pollerTick();
  setInterval(pollerTick, POLL_INTERVAL_MS);
}, START_DELAY_MS);

// ====== Endpoint manual para disparar ======
app.post('/api/bsale', async (req, res) => {
  const { order_id } = req.body || {};
  if (!order_id) return res.status(400).json({ error: 'Falta order_id' });

  log('/api/bsale recibido:', order_id, '→ poller ejecutará en 10000 ms');

  await supabase.from('orders').update({
    status: 'pending',
    processed_at: null
  }).eq('id', order_id);

  setTimeout(() => {
    pollerTick();
  }, 10000);

  res.status(200).json({ ok: true, message: 'Se encoló para procesamiento' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  log(`Server up on :${PORT}`);
});

