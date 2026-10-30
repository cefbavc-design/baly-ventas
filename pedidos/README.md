# Baly · Tomador de pedidos

Catálogo visual para que distribuidores armen su pedido (en packs) y lo manden por WhatsApp al +54 9 11 5666-2931.
No muestra precios ni stock.

- `server.js`: servidor estático sin dependencias (`npm start`, usa `PORT`).
- `public/index.html`: la app (catálogo en la constante `P`, número en `WPP`).
- `public/img/`: fotos de cada lata y botella.

En Railway se despliega como un servicio aparte con **Root Directory = `/pedidos`**.
