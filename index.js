// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());

// ===========================
// Supabase
// ===========================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

// ===========================
// Config
// ===========================
const START_DELAY_MS            = Number(process.env.START_DELAY_MS || 10000);
const POLL_INTERVAL_MS          = Number(process.env.POLL_INTERVAL_MS || 30000);
const MAX_BATCH                 = Number(process.env.MAX_BATCH || 5);

// Bsale (documentos / ventas)
const BSALE_BASE_URL            = (process.env.BSALE_BASE_URL || 'https://api.bsale.cl').replace(/\/+$/,'');
const BSALE_TOKEN               = process.env.BSALE_TOKEN;
const BSALE_DOCUMENT_TYPE_ID    = Number(process.env.BSALE_DOCUMENT_TYPE_ID || 21); // Nota de Venta (revisa en tu cuenta)
const BSALE_OFFICE_ID           = Number(process.env.BSALE_OFFICE_ID || 1);
const BSALE_SELLER_ID           = Number(process.env.BSALE_SELLER_ID || 1);
const BSALE_PRICE_LIST_ID       = Number(process.env.BSALE_PRICE_LIST_ID || 1);

// Stock sync
const BSALE_WAREHOUSE_ID        = Number(process.env.BSALE_WAREHOUSE_ID || 1);
const STOCK_SYNC_INTERVAL_MS    = Number(process.env.STOCK_SYNC_INTERVAL_MS || 5 * 60 * 1000); // 5 min por defecto

// ===========================
// Helpers
// ===========================
const log    = (...a) => console.log(...a);
const warn   = (...a) => console.warn(...a);
const errlog = (...a) => console.error(...a);
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));

// ===========================
// Sanity / ping al iniciar
// ===========================
(async () => {
  log('Sanity → URL fija:', process.env.SUPABASE_URL,
      '\nSanity → tiene service_role:', !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY));

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
    .in('status', ['pending','processing','error'])
    .is('processed_at', null);

  log('Supabase OK. orders count estimado:', count ?? 0);
})();

// ===========================
// Mapeo orden → payload Bsale
// ===========================
function mapOrderToBsalePayload(order, items) {
  const details = (items || []).map(it => {
    const d = {
      quantity: Number(it.quantity || 1),
      net_unit_value: it.unit_price_net != null ? Number(it.unit_price_net) : Number(it.unit_price || 0),
      discount: Number(it.discount || 0),
      tax_id: it.tax_id != null ? Number(it.tax_id) : 1, // 1 = IVA 19%
    };
    if (it.product_id)   d.product_id = Number(it.product_id);
    if (it.sku)          d.code       = String(it.sku);
    if (it.description)  d.description= String(it.description);
    return d;
  });

  const client = {
    name:         order.client_name   || 'Cliente Integración',
    identification: order.client_rut  || '11111111-1',
    email:        order.client_email  || 'cliente@example.com',
    phone:        order.client_phone  || '+56900000000',
    city:         order.client_city   || 'Santiago',
    address:      order.client_address|| 'Dirección s/n',
  };

  return {
    document_type_id: BSALE_DOCUMENT_TYPE_ID,
    emission_date: new Date().toISOString().substring(0,10), // YYYY-MM-DD
    office_id: BSALE_OFFICE_ID,
    seller_id: BSALE_SELLER_ID,
    price_list_id: BSALE_PRICE_LIST_ID,
    coin_id: 1,
    automatic_print: false,
    reference: order.order_number || order.id,
    observations: order.notes || 'Pedido generado automáticamente desde Supabase',
    client,
    details,
  };
}

// ===========================
// Crear Nota de Venta en Bsale
// ===========================
async function crearNotaBsale(order, items) {
  const url = `${BSALE_BASE_URL}/v1/documents.json`;
  try {
    const payload = mapOrderToBsalePayload(order, items);
    log('→ POST Bsale', url, 'reference:', payload.reference);

    const resp = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'access_token': BSALE_TOKEN,
      },
      timeout: 20000,
      validateStatus: () => true,
    });

    const status = resp.status;
    const body = resp.data;
    const noteId = body?.id ?? body?.document?.id ?? null;

    if (status >= 200 && status < 300 && noteId) {
      log(`✓ Bsale OK (#${noteId}) para orden ${order.id}`);
      return { ok: true, noteId, raw: body, status };
    }

    warn('× Bsale rechazó la creación:', status, body);
    return { ok: false, noteId: null, raw: body, status };
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data || e?.message;
    errlog('× Error HTTP al crear en Bsale:', status, data);
    return { ok: false, noteId: null, raw: data, status: status || 0 };
  }
}

// ===========================
// Procesar una orden
// ===========================
async function procesarOrden(order) {
  // 1) Items
  const { data: items, error: eItems } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', order.id);

  if (eItems) {
    errlog('× Error cargando items de orden', order.id, eItems);
    await supabase.from('orders')
      .update({ status: 'error', last_error: `items: ${eItems.message}` })
      .eq('id', order.id);
    return;
  }

  // 2) Crear en Bsale
  const res = await crearNotaBsale(order, items || []);

  // 3) Actualizar estado según resultado
  if (res.ok && res.noteId) {
    await supabase.from('orders').update({
      status: 'processed',
      processed_at: new Date().toISOString(),
      bsale_note_id: String(res.noteId),
      bsale_response: res.raw,
      last_error: null,
    }).eq('id', order.id);

    log(`✓ Orden procesada: ${order.id} → Nota Bsale #${res.noteId}`);
  } else {
    await supabase.from('orders').update({
      status: 'error',
      bsale_note_id: null,
      bsale_response: res.raw ?? null,
      last_error: `bsale(${res.status})`,
    }).eq('id', order.id);

    warn(`× Orden ${order.id} quedó en error (bsale ${res.status}). Ver last_error/bsale_response.`);
  }
}

// ===========================
// Poller de órdenes
// ===========================
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
        message: error.message, details: error.details, hint: error.hint, code: error.code
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
        await supabase.from('orders')
          .update({ status: 'error', last_error: `exception: ${e?.message || e}` })
          .eq('id', o.id);
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

// ===========================
// SYNC STOCK: Bsale → Supabase
// ===========================
const BSALE = axios.create({
  baseURL: `${BSALE_BASE_URL}/v1`,
  headers: { 'access_token': BSALE_TOKEN }
});

async function fetchAllProductsWithStock({ page = 1, acc = [] } = {}) {
  const { data } = await BSALE.get('/products.json', {
    params: { page, limit: 200, expand: 'stock' },
    validateStatus: () => true,
  });

  if (data?.items) acc.push(...data.items);

  const hasNext = !!(data?.href?.next || data?.next);
  if (hasNext) return fetchAllProductsWithStock({ page: page + 1, acc });
  return acc;
}

function stockInWarehouse(product, warehouseId) {
  const rows = product?.stock?.items || [];
  const row = rows.find(it => Number(it?.office?.id) === Number(warehouseId));
  return row ? Number(row.quantity) : 0;
}

async function syncStockOnce() {
  log('StockSync → iniciando...');
  try {
    const products = await fetchAllProductsWithStock();
    if (!products?.length) {
      warn('StockSync → 0 productos recibidos de Bsale');
      return;
    }

    const upserts = products.map(p => ({
      sku: (p.code || String(p.id)).trim(),
      bsale_product_id: Number(p.id),
      warehouse_id: Number(BSALE_WAREHOUSE_ID),
      stock_qty: stockInWarehouse(p, BSALE_WAREHOUSE_ID),
      updated_at: new Date().toISOString()
    }));

    // Upsert por sku
    const { error } = await supabase
      .from('inventory')
      .upsert(upserts, { onConflict: 'sku' });

    if (error) {
      errlog('× StockSync → error upsert Supabase:', error);
      return;
    }

    log(`StockSync → OK. SKUs sincronizados: ${upserts.length}`);
  } catch (e) {
    errlog('× StockSync → error:', e?.response?.data || e.message || e);
  }
}

// Cron interno
function startStockSync() {
  log(`StockSync → cada ${Math.round(STOCK_SYNC_INTERVAL_MS/1000)}s. Bodega: ${BSALE_WAREHOUSE_ID}`);
  // primer arranque con pequeña espera para no competir con el boot
  setTimeout(() => {
    syncStockOnce();
    setInterval(syncStockOnce, STOCK_SYNC_INTERVAL_MS);
  }, Math.min(15000, START_DELAY_MS + 5000));
}

// Endpoint manual para disparar el sync (útil para pruebas)
app.post('/api/stock/sync', async (_req, res) => {
  try {
    await syncStockOnce();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'sync error' });
  }
});

// ===========================
// Arranques
// ===========================
setTimeout(() => {
  pollerTick();
  setInterval(pollerTick, POLL_INTERVAL_MS);
}, START_DELAY_MS);

startStockSync();

// Endpoint manual para encolar una orden (poller la tomará)
app.post('/api/bsale', async (req, res) => {
  const { order_id } = req.body || {};
  if (!order_id) return res.status(400).json({ error: 'Falta order_id' });

  log('/api/bsale recibido:', order_id, '→ poller ejecutará en 10000 ms');

  await supabase.from('orders').update({
    status: 'pending',
    processed_at: null
  }).eq('id', order_id);

  setTimeout(() => { pollerTick(); }, 10000);
  res.status(200).json({ ok: true, message: 'Se encoló para procesamiento' });
});

// Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  log(`Server up on :${PORT}`);
});
