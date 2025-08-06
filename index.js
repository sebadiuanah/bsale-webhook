require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());

app.post('/api/bsale', async (req, res) => {
  const { order_id } = req.body;

  if (!order_id) {
    return res.status(400).json({ error: 'Falta order_id' });
  }

  console.log(` Recibido pedido con ID: ${order_id}`);

  // Aquí irá la lógica con Supabase y Bsale

  res.status(200).json({ message: 'Recibido' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(` Servidor escuchando en http://localhost:${PORT}`);
});
