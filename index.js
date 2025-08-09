require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());

// ⚠️ Usa SERVICE ROLE en backend
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

// Configurables
const START_DELAY_MS   = 10000;   // espera antes de buscar la orden en /api/bsale
const POLL_INTERVAL_MS = 30000;   // frecuencia del poller (30s)
const MAX_BATCH        = 5;       // cuántas órdenes procesa por pasada el poller

// Helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function mapItemsToBsale(details) {
  return details.map(it => ({
    quantity: it.quantity,
    price: it.unit_price,
    discount: it.discount_percentage,
    code: it.products?.sku || ''
  }));
}

async function fetchOrderAndItems(orderId) {
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();

  if (orderErr || !order) throw new Error('Orden no encontrada');

  const { data: items, error: itemsErr } = await supabase
    .from('order_items')
    .select('quantity, unit_price, discount_percentage, products(sku)')
    .eq('order_id', orderId);

  if (itemsErr || !items?.length) throw new Error('No se encontraron ítems');

  return { order, items };
}

async function sendToBsale(items) {
  const payload = {
    document_type_id: 1,
    office_id: 1,
    client: {
      activity: 'Venta al por mayor',
      company: 'Mayorista Cliente',
      identification: '99999999-9',
    },
    details: mapItemsToBsale(items),
  };

  const resp = await axios.post('https://api.bsale.cl/v1/documents.json', payload, {
    headers: {
      Authorization: `Bearer ${process.env.BSALE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  return resp.data;
}

async function processSingleOrder(orderId) {
  const { order, items } = await fetchOrderAndItems(orderId);
  const bsaleResp = await sendToBsale(items);
  await supabase.from('orders').update({ status: 'enviada' }).eq('id', orderId);
  return bsaleResp;
}

/* =========================
   1) Endpoint con timer
   ========================= */
app.post('/api/bsale', async (req, res) => {
  const { order_id } = req.body || {};
  if (!order_id) return res.status(400).json({ error: 'Falta order_id' });

  // Respondemos rápido y procesamos con un pequeño delay
  res.status(202).json({ message: 'Recibido. Se procesará en breve.' });

  (async () => {
    try {
      console.log('📩 /api/bsale recibido:', order_id, `→ esperando ${START_DELAY_MS}ms`);
      await sleep(START_DELAY_MS);
      await processSingleOrder(order_id);
      console.log('✅ Orden enviada a Bsale (timer):', order_id);
    } catch (err) {
      console.error('❌ Error en timer /api/bsale:', order_id, err?.message || err);
      // opcional: marcar status='error'
      await supabase.from('orders').update({ status: 'error' }).eq('id', order_id);
    }
  })();
});

/* =========================
   2) Poller en background (con logs + primer tick inmediato)
   ========================= */
async function pollPendingOrders() {
  const startedAt = new Date().toISOString();
  console.log(`🔁 Poller tick @ ${startedAt}`);

  try {
    // Buscar órdenes en 'pending'
    const { data: pending, error } = await supabase
      .from('orders')
      .select('id,status')
      .eq('status', 'pending')
      .limit(MAX_BATCH);

    if (error) {
      console.error('❌ Poller select error:', error.message);
      return;
    }

    if (!pending || pending.length === 0) {
      console.log('ℹ️ Poller: no hay órdenes pending en este tick');
      return;
    }

    console.log(`📝 Poller: encontradas ${pending.length} órdenes`, pending.map(r => r.id));

    // Intentar tomar cada orden con lock optimista
    for (const row of pending) {
      const id = row.id;

      const { data: lockData, error: lockErr } = await supabase
        .from('orders')
        .update({ status: 'processing' })
        .eq('id', id)
        .eq('status', 'pending')
        .select('id')
        .single();

      if (lockErr || !lockData) {
        console.log(`↪️ Poller: orden ${id} no está pending (ya tomada o cambió de estado).`);
        continue;
      }

      try {
        console.log('🛠️ Poller procesando:', id);
        await processSingleOrder(id);
        console.log('✅ Poller OK:', id);
      } catch (err) {
        console.error('❌ Poller error:', id, err?.message || err);
        // Devuelve a pending para reintentar más tarde
        await supabase.from('orders').update({ status: 'pending' }).eq('id', id);
      }
    }
  } catch (e) {
    console.error('❌ Poller falló:', e?.message || e);
  }
}

// Primer tick inmediato y luego cada N segundos
pollPendingOrders();
setInterval(pollPendingOrders, POLL_INTERVAL_MS);

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});

