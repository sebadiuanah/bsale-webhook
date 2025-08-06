require('dotenv').config(); 
const express = require('express');
const cors = require('cors'); // ✅ importar cors
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ✅ habilitar CORS
app.use(cors());

// ✅ habilitar JSON
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.post('/api/bsale', async (req, res) => {
  const { order_id } = req.body;
  if (!order_id) {
    console.log('⚠️ Falta order_id');
    return res.status(400).json({ error: 'Falta order_id' });
  }

  console.log(`✅ Recibido pedido con ID: ${order_id}`);

  // 1. Obtener orden
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('*')
    .eq('id', order_id)
    .single();

  if (orderError || !order) {
    console.log('❌ Orden no encontrada o error:', orderError);
    return res.status(404).json({ error: 'Orden no encontrada' });
  }

  console.log('📦 Orden obtenida:', order);

  if (order.status !== 'pending') {
    console.log('⚠️ Orden no está pendiente');
    return res.status(400).json({ error: 'Orden no está pendiente' });
  }

  // 2. Obtener ítems con SKU desde productos
  const { data: items, error: itemsError } = await supabase
    .from('order_items')
    .select('quantity, unit_price, discount_percentage, products(sku)')
    .eq('order_id', order_id);

  if (itemsError || !items.length) {
    console.log('❌ Error al obtener ítems:', itemsError);
    return res.status(400).json({ error: 'No se encontraron ítems' });
  }

  console.log('📦 Ítems obtenidos:', items);

  // 3. Formatear productos
  const products = items.map(item => ({
    quantity: item.quantity,
    price: item.unit_price,
    discount: item.discount_percentage,
    code: item.products?.sku || ''
  }));

  console.log('🛍️ Productos formateados para Bsale:', products);

  // 4. Enviar a Bsale
  try {
    const response = await axios.post('https://api.bsale.cl/v1/documents.json', {
      document_type_id: 1, // Nota de venta
      office_id: 1, // Puedes modificarlo
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

    console.log('✅ Respuesta de Bsale:', response.data);

    // 5. Actualizar estado
    await supabase
      .from('orders')
      .update({ status: 'enviada' })
      .eq('id', order_id);

    return res.status(200).json({ message: 'Nota enviada a Bsale', bsale_response: response.data });

  } catch (error) {
    console.error('❌ Error al enviar a Bsale:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Error al enviar a Bsale' });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});

