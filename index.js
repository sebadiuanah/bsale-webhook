require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());

// Supabase (usar SERVICE ROLE en backend)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

// Config poller
const START_DELAY_MS   = Number(process.env.START_DELAY_MS || 10000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const MAX_BATCH        = Number(process.env.MAX_BATCH || 5);

// Bsale config
const BSALE_BASE_URL        = process.env.BSALE_BASE_URL || 'https://api.bsale.cl';
const BSALE_TOKEN           = process.env.BSALE_TOKEN; // access_token
const BSALE_DOCUMENT_TYPE_ID= Number(process.env.BSALE_DOCUMENT_TYPE_ID || 21); // Nota de Venta (ajusta según tu cuenta)
const BSALE_OFFICE_ID       = Number(process.env.BSALE_OFFICE_ID || 1);
const BSALE_SELLER_ID       = Number(process.env.BSALE_SELLER_ID || 1);
const BSALE_PRICE_LIST_ID   = Number(process.env.BSALE_PRICE_LIST_ID || 1);

// Helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(...args) {
  console.log(...args);
}

function warn(...args) {
  console.warn(...args);
}

function errlog(...args) {
  console.error(...args);
}

/**
 * Mapea la orden + items a payload de Bsale
 * Ajusta los nombres de columnas de order_items si difieren.
 */
function mapOrderToBsalePayload(order, items) {
  // items: esperados con campos: product_id? sku? description? quantity, unit_price_net?, tax_id?
  const details = items.map(it => {
    const quantity = Number(it.quantity || 1);

    // Valor neto: si guardas bruto en it.unit_price, conviértelo si quieres;
    // por defecto usamos it.unit_price_net si existe, si no, caemos a it.unit_price
    const netUnit = it.unit_price_net != null
      ? Number(it.unit_price_net)
      : Number(it.unit_price || 0);

    const d = {
      quantity,
      net_unit_value: netUnit,
      discount: Number(it.discount || 0),
      tax_id: it.tax_id != null ? Number(it.tax_id) : 1, // 1 = IVA 19% (ajusta si exento)
    };

    // Identificación de producto
    if (it.product_id) d.product_id = Number(it.product_id);
    if (it.sku) d.code = String(it.sku);
    if (it.description) d.description = String(it.description);

    return d;
  });

  // Cliente básico: si ya tienes cliente_id en Bsale, puedes enviarlo;
  // de lo contrario, Bsale creará/hará match por identificación+nombre.
  const client = {
    name: order.client_name || 'Cliente Integración',
    identification: order.client_rut || '11111111-1',
    email: order.client_email || 'cliente@example.com',
    phone: order.client_phone || '+56900000000',
    city: order.client_city || 'Santiago',
    address: order.client_address || 'Dirección s/n',
  };

  const payload = {
    document_type_id: BSALE_DOCUMENT_TYPE_ID,
    emission_date: new Date().toISOString().substring(0,10), // YYYY-MM-DD
    office_id: BSALE_OFFICE_ID,
    seller_id: BSALE_SELLER_ID,
    price_list_id: BSALE_PRICE_LIST_ID,
    coin_id: 1, // CLP
    automatic_print: false,
    reference: order.order_number || order.id, // aparece como referencia en Bsale
    observations: order.notes || 'Pedido generado automáticamente desde Supabase',
    client,
    details,
  };

  return payload;
}

/**
 * Llama a la API de Bsale para crear Nota de Venta
 * Retorna { ok, noteId, raw, status }
 */
async function crearNotaBsale(order, items) {
  const url = `${BSALE_BASE_URL.replace(/\/+$/,'')}/v1/documents.json`;

  try {
    const payload = mapOrderToBsalePayload(order, items);
    log('→ POST Bsale', url, 'reference:', payload.reference);

    const resp = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'access_token': BSALE_TOKEN,
      },
      timeout: 20000,
      validateStatus: () => true, // manejamos manualmente
    });

    const status = resp.status;
    const body = resp.data;

    // Bsale suele responder 200/201 con { id: <numero> } o { document: { id } }
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

/**
 * Procesa una orden:
 * - carga items
 * - intenta crear nota en Bsale
 * - si OK, marca processed + guarda bsale_note_id/raw
 * - si error, marca error + guarda last_error/raw
 */
async function procesarOrden(order) {
  // Cargar items
  const { data: items, error: eItems } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', order.id);

  if (eItems) {
    errlog('× Error cargando items de orden', order.id, eItems);
    await supabase
      .from('orders')
      .update({
        status: 'error',
        last_error: `items: ${eItems.message}`,
      })
      .eq('id', order.id);
    return;
  }

  // Crear en Bsale
  const res = await crearNotaBsale(order, items || []);

  if (res.ok && res.noteId) {
    await supabase
      .from('orders')
      .update({
        status: 'processed',
        processed_at: new Date().toISOString(),
        bsale_note_id: String(res.noteId),
        bsale_response: res.raw,
        last_error: null,
      })
      .eq('id', order.id);

    log(`✓ Orden procesada: ${order.id} → Nota Bsale #${res.noteId}`);
  } else {
    await supabase
      .from('orders')
      .update({
        status: 'error',
        bsale_note_id: null,
        bsale_response: res.raw ?? null,
        last_error: `bsale(${res.status})`,
      })
      .eq('id', order.id);

    warn(`× Orden ${order.id} quedó en error (bsale ${res.status}). Ver last_error/bsale_response.`);
  }
}

/**
 * Poller:
 * - toma órdenes sin processed_at en estados pending/processing/error (para reintentos)
 * - procesa de a MAX_BATCH
 */
async function pollerTick() {
  log('Poller tick', new Date().toISOString());

  const { data: pendientes, error } = await supabase
    .from('orders')
    .select('*')
    .in('status', ['pending', 'processing', 'error'])
    .is('processed_at', null)
    .limit(MAX_BATCH);

  if (error) {
    errlog('× Error consultando órdenes pendientes:', error);
    return;
  }

  if (!pendientes || pendientes.length === 0) return;

  for (const o of pendientes) {
    try {
      log('→ Procesando orden:', o.id, o.order_number || '');
      // marca en processing antes de enviar
      await supabase.from('orders').update({ status: 'processing' }).eq('id', o.id);
      await procesarOrden(o);
    } catch (e) {
      errlog('× Excepción procesando orden', o.id, e);
      await supabase
        .from('orders')
        .update({ status: 'error', last_error: `exception: ${e?.message || e}` })
        .eq('id', o.id);
    }
  }
}

// Arranque del poller
setTimeout(() => {
  pollerTick();
  setInterval(pollerTick, POLL_INTERVAL_MS);
}, START_DELAY_MS);

// Endpoint manual para disparar por ID
app.post('/api/bsale', async (req, res) => {
  const { order_id } = req.body || {};
  if (!order_id) return res.status(400).json({ error: 'Falta order_id' });

  log('/api/bsale recibido:', order_id, '→ poller ejecutará en 10000 ms');

  // Marcamos en pending/processing y dejamos que el poller la tome
  await supabase
    .from('orders')
    .update({ status: 'pending', processed_at: null })
    .eq('id', order_id);

  // pequeña espera y un tick aislado para este caso
  setTimeout(() => {
    pollerTick();
  }, 10000);

  res.status(200).json({ ok: true, message: 'Se encoló para procesamiento' });
});

// Sanity check
(async () => {
  const urlOk = !!process.env.SUPABASE_URL;
  const svcOk = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);
  log('Sanity → URL fija:', process.env.SUPABASE_URL, '\nSanity → tiene service_role:', svcOk);

  const { count } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .in('status', ['pending', 'processing', 'error'])
    .is('processed_at', null);

  log('Supabase OK. orders count estimado:', count ?? 0);
})();

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  log(`Server up on :${PORT}`);
});
