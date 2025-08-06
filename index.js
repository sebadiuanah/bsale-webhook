require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 🔁 Función retry para obtener la orden
async function fetchOrderWithRetry(order_id, retries = 5, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', order_id)
      .single();

    if (data && !error) return data;

    console.log(`⌛ Intento ${i + 1}: Orden no disponible aún, esperando ${delay}ms...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error('Orden no encontrada tras varios intentos');
}

app.post('/api/bsale', async (req, res) => {
  const { order_id } = req.body;

  if (!order_id) {
    console.log(⚠️ Falta order_id');
    return res.status(400).json({ error: 'Falta order_id' });
  }

  console.log(`✅ Recibido pedido con ID: ${order_id}`);

  let order;
  try {
    order = await fetchOrderWithRetry(order_id);
  } catch (err) {
    console.error('❌ No se pudo obtener la orden:', err.message);
    return res.status(404).json({ error: 'Orden no encontrada' });
  }

  console.log('📦 Orden obtenida:', order);

  if (order.status !== 'pending') {
    console.log('⚠️ Orden no está pendiente');
    return res.status(400).json({ error: 'Orden no está pendiente' });
  }

  const { data: items, error: itemsError } = await supabase
    .from('order_items')
    .select('quantity, unit_price, discount_percentage, products(sku)')
    .eq('order_id', order_id);

  if (itemsError || !items.length) {
    console.log('❌ Error al obtener ítems:', itemsError);
    return res.status(400).json({ error: 'No se encontraron ítems' });
  }

  console.log('🧾 Ítems obtenidos:', items);

  const products = items.map(item => ({
    quantity: item.quantity,
    price: item.unit_price,
    discount: item.discount_percentage,
    code: item.products?.sku || ''
  }));

  console.log('🛍️ Productos preparados para Bsale:', products);

  try {
    const response = await axios.post('https://api.bsale.cl/v1/documents.json', {
      document_type_id: 1,
      office_id: 1,
      client: {
        activity: 'Venta al por mayor',
        company: 'Mayorista Cliente',
        identification: '99999999-9'
      },
      details: products
    }, {
      headers: {
        Authorization: `Bearer ${process.env.BSALE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ Bsale respondió:', response.data);

    await supabase
      .from('orders')
      .update({ status: 'enviada' })
      .eq('id', order_id);

    return res.status(200).json({
      message: 'Nota enviada a Bsale',
      bsale_response: response.data
    });

  } catch (error) {
    console.error('❌ Error al enviar a Bsale:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Error al enviar a Bsale' });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});

