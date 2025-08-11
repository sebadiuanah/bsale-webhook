require('dotenv').config();
const express = require('express');
const axios = require('axios');
const dns = require('node:dns').promises;
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// === ENV & sanity ===
const RAW_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = RAW_URL.replace(/\/+$/, ''); // sin slash final
const SUPABASE_HOST = (() => {
  try { return new URL(SUPABASE_URL).host; } catch { return '(URL inválida)'; }
})();
const SERVICE_ROLE = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').trim();

console.log('Sanity ➔ SUPABASE_URL:', SUPABASE_URL || '(vacío)');
console.log('Sanity ➔ host:', SUPABASE_HOST);
console.log('Sanity ➔ service_role set:', Boolean(SERVICE_ROLE));

if (!SUPABASE_URL || !/^https:\/\/.+\.supabase\.co$/i.test(SUPABASE_URL)) {
  console.error('⚠️  SUPABASE_URL inválida. Debe ser https://<ref>.supabase.co (sin slash final, sin comillas).');
}
if (!SERVICE_ROLE) {
  console.error('⚠️  Falta SUPABASE_SERVICE_ROLE_KEY.');
}

// === Supabase client (no persiste sesión en servidor)
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// === Helpers ===
async function pingSupabase(maxTries = 4) {
  const healthURL = `${SUPABASE_URL}/auth/v1/health`;
  let lastErr;
  for (let i = 1; i <= maxTries; i++) {
    try {
      // 1) DNS lookup del host
      const dnsInfo = await dns.lookup(SUPABASE_HOST);
      console.log(`DNS ➔ ${SUPABASE_HOST} -> ${dnsInfo.address}`);

      // 2) Health check HTTP
      const r = await axios.get(healthURL, { timeout: 5000 });
      if (r.status >= 200 && r.status < 300) {
        console.log('✓ Ping Supabase OK');
        return true;
      }
      throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      lastErr = err;
      const code = err.code || (err.response && err.response.status);
      console.error(`✗ Intento ${i}/${maxTries} ping falló (${code || err.message})`);
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
  console.error('✗ Ping Supabase falló:', lastErr && (lastErr.code || lastErr.message));
  return false;
}

// === Endpoints de diagnóstico ===
app.get('/debug/env', (_req, res) => {
  res.json({
    SUPABASE_URL,
    SUPABASE_HOST,
    SERVICE_ROLE_present: Boolean(SERVICE_ROLE),
  });
});

app.get('/debug/ping', async (_req, res) => {
  const ok = await pingSupabase(1);
  res.status(ok ? 200 : 500).json({ ok });
});

app.get('/', (_req, res) => {
  res.send('OK');
});

// === Arranque ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`Server up on :${PORT}`);
  const ok = await pingSupabase();
  if (!ok) {
    console.log('Sugerencia: revisa EXACTITUD de SUPABASE_URL y que no tenga espacios ni comillas.');
  }
});

