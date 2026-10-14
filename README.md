# Baly · Seguimiento de ventas

Tablero para que el equipo comercial de Baly (César, Sandro y Valentín) siga cada venta en 4 etapas:

1. **Posreunión** · cotizar
2. **Cotizado** · seguimiento y persistencia
3. **Pendiente** · se confirma con pago
4. **Pagado** · derivar a Operaciones

Cada venta puede tener cliente, teléfono, pallets, ciudad, origen (WPP/CRM), quién la lleva, cotización, notas y archivos. Ningún campo es obligatorio.

## Cómo está armado

- `public/index.html` — la página (todo en un solo archivo).
- `server.js` — servidor Node sin dependencias. Guarda las ventas en `ventas.json` y los archivos en la carpeta `archivos/`, dentro de `DATA_DIR`.

Si la página se abre sin servidor (doble clic en el HTML), funciona igual pero guarda todo solo en ese navegador.

## Correrlo en tu compu

```bash
npm start
# abrir http://localhost:3000
```

## Variables de entorno

| Variable | Para qué | Ejemplo |
|---|---|---|
| `DATA_DIR` | Carpeta donde se guardan ventas y archivos | `/data` |
| `APP_PASSWORD` | Si está, la página pide contraseña (el usuario puede ser cualquiera) | `una-clave-larga` |
| `PORT` | Puerto (Railway lo define solo) | `3000` |

## Deploy en Railway

1. **New Project → Deploy from GitHub repo** → elegir `baly-ventas`.
2. En el servicio: **Settings → Volumes → Add Volume**, montado en `/data`.
   Sin volumen, las ventas y archivos se borran en cada deploy.
3. **Variables**: `DATA_DIR=/data` y `APP_PASSWORD=<la clave del equipo>`.
4. **Settings → Networking → Generate Domain** para tener la URL.

Arriba a la derecha de la página tiene que decir **● Compartido**: eso confirma que está guardando en el servidor.
