require('dotenv').config();
const express = require('express');
const axios = require('axios');
const dns = require('node:dns').promises;
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ============ ENV ============
const RAW_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = RAW_URL.replace(/\/+$/, '');
const SUPABASE_HOST = (() => { try { return new URL(SUPABASE_URL).host; } catch { return '(URL inválida)'; } })();
const SERVICE_ROLE = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').trim();

const BSALE_API_BASE = (process.env.BSALE_API_BASE || 'https://api.bsale.cl').replace(/\/+$/, '');
const BSALE_TOKEN = (process.env.BSALE_TOKEN || '').trim();
const BSALE_OFFICE_ID = (process.env.BSALE_OFFICE_ID || '1').toString();

const SUPABASE_STOCK_TABLE   = process.env.SUPABASE_STOCK_TABLE   || 'stock';
const SUPABASE_STOCK_SKU_COL = process.env.SUPABASE_STOCK_SKU_COL || 'sku';
const SUPABASE_STOCK_QTY_COL = process.env.SUPABASE_STOCK_QTY_COL || 'quantity';

const SUPABASE_ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || 'orders';
const SUPABASE_ORDER_ITEMS_TABLE = process.env.SUPABASE_ORDER_ITEMS_TABLE || 'order_items';
const SUPABASE_ORDER_PK = process.env.SUPABASE_ORDER_PK || 'id';
const SUPABASE_ORDER_ITEMS_ORDER_FK = process.env.SUPABASE_ORDER_ITEMS_ORDER_FK || 'order_id';
const SUPABASE_ORDER_ITEMS_SKU_COL = process.env.SUPABASE_ORDER_ITEMS_SKU_COL || 'sku';
const SUPABASE_ORDER_ITEMS_QTY_COL = process.env.SUPABASE_ORDER_ITEMS_QTY_COL || 'quantity';

const START_DELAY_MS   = Number(process.env.START_DELAY_MS || 10000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 300000);
const MAX_PAGES_STOCK  = Number(process.env.MAX_PAGES_STOCK || 50);

console.log('Sanity ➔ SUPABASE_URL:', SUPABASE_URL || '(vacío)');
console.log('Sanity ➔ host:', SUPABASE_HOST);
console.log('Sanity ➔ service_role set:', Boolean(SERVICE_ROLE));
console.log('StockSync ➔ cron cada', POLL_INTERVAL_MS/1000, 's (officeId=' + BSALE_OFFICE_ID + ')');
console.log('Bsale ➔ base:', BSALE_API_BASE);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// ============ HEALTH ============
async function pingSupabaseAuth(maxTries = 3) {
  const url = `${SUPABASE_URL}/auth/v1/settings`;
  for (let i = 1; i <= maxTries; i++) {
    try {
      const dnsInfo = await dns.lookup(SUPABASE_HOST);
      console.log(`DNS ➔ ${SUPABASE_HOST} -> ${dnsInfo.address}`);
      const r = await axios.get(url, {
        timeout: 8000,
        headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
        maxRedirects: 0, validateStatus: () => true,
      });
      console.log(`HTTP ➔ GET ${url} -> ${r.status}`);
      if (r.status === 200) { console.log('✓ Ping Supabase (auth settings) OK'); return true; }
      throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      console.error(`✗ Ping intento ${i}/${maxTries} falló (${err?.response?.status || err?.code || err?.message})`);
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
  return false;
}

// ============ STOCK SYNC ============
function bsaleHeaders() {
  if (!BSALE_TOKEN) throw new Error('Falta BSALE_TOKEN en env');
  return { 'access_token': BSALE_TOKEN };
}

function stocksUrl(page = 1, noOffice = false) {
  const base = `${BSALE_API_BASE}/v1/stocks.json`;
  const qp = new URLSearchParams({
    page: String(page), limit: '200', expand: 'variant', ...(noOffice ? {} : { officeId: BSALE_OFFICE_ID }),
  });
  return `${base}?${qp.toString()}`;
}

async function fetchBsaleStockPage(page = 1, noOffice = false) {
  const url = stocksUrl(page, noOffice);
  const r = await axios.get(url, { headers: bsaleHeaders(), timeout: 15000, validateStatus: () => true });
  console.log(`HTTP ➔ GET ${url} -> ${r.status}`);
  if (r.status !== 200) {
    const body = typeof r.data === 'string' ? r.data.slice(0, 300) : JSON.stringify(r.data || {}).slice(0, 300);
    throw new Error(`Bsale stocks HTTP ${r.status} body=${body}`);
  }
  return r.data;
}

// **Ajustado**: robusto y con fallback
function mapStocksToSkuQty(items = []) {
  return items.map((it) => {
    const sku =
      (it?.variant?.code ?? it?.variant?.sku ?? it?.code ?? '').toString().trim();
    // puedes alternar a 'quantityAvailable' si prefieres:
    const qty = Number(it?.quantity ?? it?.quantityAvailable ?? 0);
    return { sku, quantity: isFinite(qty) ? qty : 0 };
  }).filter(x => x.sku);
}

async function upsertStockBatch(rows) {
  if (!rows.length) return { upserted: 0 };
  const payload = rows.map(r => ({
    [SUPABASE_STOCK_SKU_COL]: r.sku,
    [SUPABASE_STOCK_QTY_COL]: r.quantity,
    updated_at: new Date().toISOString(),
  }));
  const { data, error } = await supabase
    .from(SUPABASE_STOCK_TABLE)
    .upsert(payload, { onConflict: SUPABASE_STOCK_SKU_COL });

  if (error) {
    // Re-lanza con detalles claros
    const errInfo = {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      table: SUPABASE_STOCK_TABLE,
      columns: { sku: SUPABASE_STOCK_SKU_COL, quantity: SUPABASE_STOCK_QTY_COL },
    };
    throw new Error(`Supabase upsert failed: ${JSON.stringify(errInfo)}`);
  }
  return { upserted: rows.length };
}

async function runStockSync() {
  console.log('⏳ StockSync: iniciando…');
  let total = 0;
  try {
    let useNoOffice = false;
    for (let page = 1; page <= MAX_PAGES_STOCK; page++) {
      let data;
      try {
        data = await fetchBsaleStockPage(page, useNoOffice);
      } catch (e) {
        const status = e?.response?.status || /HTTP (\d{3})/.exec(e?.message || '')?.[1];
        if (!useNoOffice && page === 1 && ['401','403','404'].includes(String(status))) {
          console.warn(`⚠️ StockSync: status ${status} con officeId=${BSALE_OFFICE_ID}. Reintentando sin officeId…`);
          useNoOffice = true;
          data = await fetchBsaleStockPage(page, true);
        } else { throw e; }
      }

      const raw = data.items || data || [];
      console.log(`StockSync: página ${page} -> items crudos: ${raw.length}`);
      if (raw[0]) console.log('StockSync: ejemplo item[0]:', JSON.stringify(raw[0]).slice(0, 400));

      const rows = mapStocksToSkuQty(raw);
      console.log(`StockSync: mapeados=${rows.length}${rows[0] ? ` ejemplo=${JSON.stringify(rows[0])}` : ''}`);
      if (!rows.length) { console.log('StockSync: no hay filas mapeadas, fin.'); break; }

      const { upserted } = await upsertStockBatch(rows);
      total += upserted;

      const hasMore = Boolean(data.next && raw.length > 0);
      console.log(`StockSync: página ${page} -> ${upserted} upserts${hasMore ? ' (hay más)' : ''}`);
      if (!hasMore) break;
    }
    console.log(`✅ StockSync: completado. Total upserts: ${total}`);
  } catch (err) {
    console.error('❌ StockSync error:', {
      message: err?.message,
      status: err?.response?.status,
      body: typeof err?.response?.data === 'string'
        ? err.response.data.slice(0, 400)
        : JSON.stringify(err?.response?.data || {}).slice(0, 400),
      headers: err?.response?.headers,
    });
  }
}

// ============ /api/bsale (queda igual por ahora) ============
async function getOrderWithItems(orderId) {
  const { data: order, error: e1 } = await supabase
    .from(SUPABASE_ORDERS_TABLE).select('*').eq(SUPABASE_ORDER_PK, orderId).single();
  if (e1) throw e1; if (!order) throw new Error('Orden no encontrada');

  const { data: items, error: e2 } = await supabase
    .from(SUPABASE_ORDER_ITEMS_TABLE).select('*').eq(SUPABASE_ORDER_ITEMS_ORDER_FK, orderId);
  if (e2) throw e2;
  return { order, items: items || [] };
}

function buildBsaleDocumentPayload({ order, items }) {
  const details = items.map(it => ({
    code: it[SUPABASE_ORDER_ITEMS_SKU_COL],
    quantity: Number(it[SUPABASE_ORDER_ITEMS_QTY_COL] || 1),
  }));
  return {
    emission_date: new Date().toISOString().slice(0, 10),
    details,
    ...(BSALE_OFFICE_ID ? { office_id: Number(BSALE_OFFICE_ID) } : {}),
  };
}

async function sendBsaleDocument(payload) {
  const url = `${BSALE_API_BASE}/v1/documents.json`;
  const r = await axios.post(url, payload, {
    headers: { ...bsaleHeaders(), 'Content-Type': 'application/json' },
    timeout: 20000, validateStatus: () => true,
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`Bsale documento HTTP ${r.status} - ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  return r.data;
}

// ============ ROUTES ============
app.get('/', (_req, res) => res.send('OK'));
app.get('/debug/env', (_req, res) => {
  res.json({
    SUPABASE_URL, SUPABASE_HOST, SERVICE_ROLE_present: Boolean(SERVICE_ROLE),
    BSALE_API_BASE, BSALE_OFFICE_ID, BSALE_TOKEN_present: Boolean(BSALE_TOKEN),
    SUPABASE_STOCK_TABLE, SUPABASE_STOCK_SKU_COL, SUPABASE_STOCK_QTY_COL,
  });
});
app.get('/debug/ping', async (_req, res) => {
  const ok = await pingSupabaseAuth(1);
  res.status(ok ? 200 : 500).json({ ok });
});
app.get('/debug/stock', async (req, res) => {
  try {
    const page = Number(req.query.page || '1');
    const noOffice = req.query.noOffice === '1';
    const data = await fetchBsaleStockPage(page, noOffice);
    const mapped = mapStocksToSkuQty(data.items || data);
    res.json({ page, count: (data.items || data || []).length, sample: mapped.slice(0, 5), next: data.next || null });
  } catch (err) {
    res.status(500).json({
      message: err?.message, status: err?.response?.status, body: err?.response?.data || null,
    });
  }
});

app.post('/api/bsale', async (req, res) => {
  try {
    const { order_id } = req.body || {};
    if (!order_id) return res.status(400).json({ error: 'Falta order_id' });
    const data = await getOrderWithItems(order_id);
    const payload = buildBsaleDocumentPayload(data);
    const resp = await sendBsaleDocument(payload);
    return res.status(201).json({ ok: true, bsale: resp });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'Error' });
  }
});

// ============ STARTUP ============
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`Server up on :${PORT}`);
  await pingSupabaseAuth();

  setTimeout(() => {
    runStockSync(); // primera pasada
    setInterval(runStockSync, POLL_INTERVAL_MS);
  }, START_DELAY_MS);
});
