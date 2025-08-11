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
const SUPABASE_HOST = (() => { try { return new URL(SUPABASE_URL).host; } catch { return '(URL inválida)'; } })();
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

// Cliente Supabase (por si lo necesitas más adelante)
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// === Ping: DNS + Auth Settings (requiere SERVICE_ROLE) ===
async function pingSupabaseAuth(maxTries = 4) {
  const url = `${SUPABASE_URL}/auth/v1/settings`;
  let lastErr;

  for (let i = 1; i <= maxTries; i++) {
    try {
      // 1) DNS lookup
      const dnsInfo = await dns.lookup(SUPABASE_HOST);
      console.log(`DNS ➔ ${SUPABASE_HOST} -> ${dnsInfo.address}`);

      // 2) Auth settings (200 esperado)
      const r = await axios.get(url, {
        timeout: 8000,
        headers: {
          apikey: SERVICE_ROLE,
          Authorization: `Bearer ${SERVICE_ROLE}`,
        },
        // Evita seguir redirects raros que manchen el status real
        maxRedirects: 0,
        validateStatus: () => true,
      });

      console.log(`HTTP ➔ GET ${url} -> ${r.status}`);
      if (r.status === 200 && r.data) {
        console.log('✓ Ping Supabase (auth settings) OK');
        return { ok: true, status: r.status };
      }

      throw Object.assign(new Error(`HTTP ${r.status}`), { response: r });
    } catch (err) {
      lastErr = err;
      const code = err.code || (err.response && err.response.status);
      const body = err.response && (typeof err.response.data === 'string'
        ? err.response.data.slice(0, 200)
        : JSON.stringify(err.response.data || {})).slice(0, 200);

      console.error(`✗ Intento ${i}/${maxTries} falló (${code || err.message})${body ? ` body=${body}` : ''}`);
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
  console.error('✗ Ping Supabase falló:', lastErr && (lastErr.code || lastErr.message));
  return { ok: false, error: lastErr && (lastErr.code || lastErr.message) };
}

// === Endpoints de debug ===
app.get('/debug/env', (_req, res) => {
  res.json({
    SUPABASE_URL,
    SUPABASE_HOST,
    SERVICE_ROLE_present: Boolean(SERVICE_ROLE),
  });
});

app.get('/debug/ping', async (_req, res) => {
  const r = await pingSupabaseAuth(1);
  res.status(r.ok ? 200 : 500).json(r);
});

app.get('/', (_req, res) => res.send('OK'));

// === Arranque ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`Server up on :${PORT}`);
  const r = await pingSupabaseAuth();
  if (!r.ok) {
    console.log('Sugerencia: valida URL exacta (Project URL) y SERVICE_ROLE_KEY. Sin comillas ni slash final.');
  }
});
