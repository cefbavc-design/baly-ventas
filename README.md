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

## Cómo se protegen los datos

- **El servidor no arranca sin disco permanente.** En Railway, si `DATA_DIR` no está dentro de un Volume, el deploy falla a propósito en lugar de guardar en un disco que se borra.
- **Respaldos automáticos**: una copia por hora de `ventas.json` en `respaldos/` dentro del Volume (se guardan ~2 semanas). Si `ventas.json` se daña, el servidor arranca desde el último respaldo.
- **Guardado confirmado**: la página muestra *Guardado* / *Guardando…* / *Sin guardar*. Si el servidor no confirma, el cambio queda en cola en el navegador y se reintenta solo, incluso después de cerrar y volver a abrir. No deja cerrar la pestaña con cambios sin guardar.
- **Copia espejo en cada navegador** (ventas y adjuntos). Si el servidor llega a perder datos, la página lo detecta y ofrece *Restaurar ahora*.
- `GET /api/estado` muestra dónde se guarda, si el disco es permanente, cuántas ventas hay y el último respaldo.

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
