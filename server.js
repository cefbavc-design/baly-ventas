// Baly · Seguimiento de ventas
// Servidor mínimo sin dependencias: sirve la página y guarda ventas y archivos.
//
// Variables de entorno:
//   PORT          Puerto (Railway lo pone solo)
//   DATA_DIR      Carpeta donde se guardan los datos (en Railway: el Volume, ej. /data)
//   APP_PASSWORD  Si se define, la página pide usuario y contraseña (el usuario puede ser cualquiera)

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'archivos');
const VENTAS_FILE = path.join(DATA_DIR, 'ventas.json');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const PASSWORD = process.env.APP_PASSWORD || '';
const MAX_JSON = 2 * 1024 * 1024;        // 2 MB por venta
const MAX_FILE = 25 * 1024 * 1024;       // 25 MB por archivo (igual que la página)
const ID_RE = /^[a-z0-9_-]{1,64}$/i;

fs.mkdirSync(FILES_DIR, { recursive: true });

/* ---------- Ventas: en memoria + archivo JSON (escritura atómica y en cola) ---------- */
let ventas = new Map();
try {
  const arr = JSON.parse(fs.readFileSync(VENTAS_FILE, 'utf8'));
  if (Array.isArray(arr)) arr.forEach(v => v && ID_RE.test(v.id) && ventas.set(v.id, v));
} catch (e) { /* primera vez: no hay archivo */ }

let cola = Promise.resolve();
function persistir() {
  cola = cola.then(async () => {
    const tmp = VENTAS_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify([...ventas.values()]));
    await fsp.rename(tmp, VENTAS_FILE);
  }).catch(err => console.error('Error guardando ventas:', err));
  return cola;
}

/* ---------- Utilidades HTTP ---------- */
function enviar(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function leerCuerpo(req, limite) {
  return new Promise((resolve, reject) => {
    const partes = []; let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > limite) { reject(Object.assign(new Error('Demasiado grande'), { status: 413 })); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

function autorizado(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Tipos que se pueden abrir en el navegador; el resto se descarga (evita ejecutar HTML/SVG subidos)
const INLINE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/plain)$/i;

/* ---------- Rutas ---------- */
async function manejar(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/health') return enviar(res, 200, { ok: true });

  if (!autorizado(req)) {
    return enviar(res, 401, 'Se necesita contraseña', { 'WWW-Authenticate': 'Basic realm="Baly ventas", charset="UTF-8"' });
  }

  // Página
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const html = await fsp.readFile(INDEX_FILE);
    return enviar(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  }

  // Ventas
  if (p === '/api/ventas' && req.method === 'GET') {
    return enviar(res, 200, [...ventas.values()]);
  }
  let m = p.match(/^\/api\/ventas\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!ID_RE.test(id)) return enviar(res, 400, { error: 'ID inválido' });
    if (req.method === 'PUT') {
      let venta;
      try { venta = JSON.parse((await leerCuerpo(req, MAX_JSON)).toString('utf8')); }
      catch (e) { return enviar(res, e.status || 400, { error: e.status ? 'Demasiado grande' : 'JSON inválido' }); }
      if (!venta || typeof venta !== 'object' || Array.isArray(venta)) return enviar(res, 400, { error: 'Venta inválida' });
      venta.id = id;
      ventas.set(id, venta);
      await persistir();
      return enviar(res, 200, venta);
    }
    if (req.method === 'DELETE') {
      ventas.delete(id);
      await persistir();
      return enviar(res, 200, { ok: true });
    }
  }

  // Archivos
  if (p === '/api/archivos' && req.method === 'POST') {
    const id = crypto.randomBytes(12).toString('hex');
    let nombre = 'archivo';
    try { nombre = decodeURIComponent(req.headers['x-filename'] || 'archivo'); } catch (e) {}
    nombre = path.basename(nombre).slice(0, 200) || 'archivo';
    const tipo = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100);
    const destino = path.join(FILES_DIR, id);
    let tam = 0;
    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(destino);
        req.on('data', c => {
          tam += c.length;
          if (tam > MAX_FILE) { req.unpipe(out); out.destroy(); req.destroy(); reject(Object.assign(new Error('grande'), { status: 413 })); }
        });
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        req.on('error', reject);
      });
    } catch (e) {
      await fsp.rm(destino, { force: true });
      return enviar(res, e.status || 500, { error: e.status === 413 ? 'El archivo supera 25 MB' : 'No se pudo guardar' });
    }
    await fsp.writeFile(destino + '.json', JSON.stringify({ nombre, tipo, tam, fecha: new Date().toISOString() }));
    return enviar(res, 200, { id, url: `/api/archivos/${id}` });
  }
  m = p.match(/^\/api\/archivos\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!ID_RE.test(id)) return enviar(res, 400, { error: 'ID inválido' });
    const ruta = path.join(FILES_DIR, id);
    if (req.method === 'GET') {
      let meta;
      try { meta = JSON.parse(await fsp.readFile(ruta + '.json', 'utf8')); }
      catch (e) { return enviar(res, 404, { error: 'No existe' }); }
      const inline = INLINE.test(meta.tipo);
      res.writeHead(200, {
        'Content-Type': inline ? meta.tipo : 'application/octet-stream',
        'Content-Length': meta.tam,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.nombre)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=86400',
      });
      return fs.createReadStream(ruta).pipe(res);
    }
    if (req.method === 'DELETE') {
      await fsp.rm(ruta, { force: true });
      await fsp.rm(ruta + '.json', { force: true });
      return enviar(res, 200, { ok: true });
    }
  }

  return enviar(res, 404, { error: 'No encontrado' });
}

http.createServer((req, res) => {
  manejar(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) enviar(res, 500, { error: 'Error del servidor' });
    else res.end();
  });
}).listen(PORT, () => {
  console.log(`Baly ventas escuchando en el puerto ${PORT}`);
  console.log(`Datos en: ${DATA_DIR}${PASSWORD ? ' · con contraseña' : ' · SIN contraseña (definí APP_PASSWORD)'}`);
});
