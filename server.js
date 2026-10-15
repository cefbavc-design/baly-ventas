// Baly · Seguimiento de ventas
// Servidor mínimo sin dependencias: sirve la página y guarda ventas y archivos.
//
// Variables de entorno:
//   PORT                     Puerto (Railway lo pone solo)
//   DATA_DIR                 Carpeta de datos. En Railway tiene que estar dentro del Volume (ej. /data)
//   APP_PASSWORD             Si se define, la página pide usuario y contraseña (el usuario puede ser cualquiera)
//   PERMITIR_DISCO_TEMPORAL  Solo para pruebas: "1" deja arrancar en Railway sin Volume (NO usar en producción)

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const VOLUMEN_RAILWAY = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || VOLUMEN_RAILWAY || path.join(__dirname, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'archivos');
const BACKUP_DIR = path.join(DATA_DIR, 'respaldos');
const VENTAS_FILE = path.join(DATA_DIR, 'ventas.json');
const META_FILE = path.join(DATA_DIR, 'almacen.json');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const PASSWORD = process.env.APP_PASSWORD || '';
const MAX_JSON = 2 * 1024 * 1024;        // 2 MB por venta
const MAX_FILE = 25 * 1024 * 1024;       // 25 MB por archivo (igual que la página)
const ID_RE = /^[a-z0-9_-]{1,64}$/i;
const RESPALDO_CADA_MS = 60 * 60 * 1000; // una copia por hora como máximo
const RESPALDOS_A_GUARDAR = 400;         // ~2 semanas de copias horarias

function fatal(msg) {
  console.error('\n' + '='.repeat(70) + '\n✖ ' + msg + '\n' + '='.repeat(70) + '\n');
  process.exit(1);
}

/* ---------- ¿Los datos van a un disco permanente? ---------- */
// Un Volume aparece como un punto de montaje propio. Si DATA_DIR no está dentro de uno,
// los datos viven en el disco temporal del contenedor y se borran en cada deploy.
function puntoDeMontaje(dir) {
  try {
    // Cada línea: ... <punto de montaje> ... - <tipo> <origen> ...  (se ignoran discos en memoria)
    const TEMPORALES = new Set(['tmpfs', 'ramfs', 'overlay', 'proc', 'sysfs', 'devtmpfs', 'devpts', 'mqueue', 'cgroup', 'cgroup2']);
    const montajes = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean)
      .map(l => { const [izq, der = ''] = l.split(' - '); return { m: (izq.split(' ')[4] || '').replace(/\\040/g, ' '), tipo: der.split(' ')[0] }; })
      .filter(x => x.m && x.m !== '/' && !TEMPORALES.has(x.tipo))
      .map(x => x.m);
    return montajes
      .filter(m => dir === m || dir.startsWith(m.endsWith('/') ? m : m + '/'))
      .sort((a, b) => b.length - a.length)[0] || '';
  } catch (e) { return ''; }
}
const EN_RAILWAY = Object.keys(process.env).some(k => k.startsWith('RAILWAY_'));
const MONTAJE = puntoDeMontaje(DATA_DIR);
const DENTRO_DEL_VOLUMEN = VOLUMEN_RAILWAY &&
  (DATA_DIR === path.resolve(VOLUMEN_RAILWAY) || DATA_DIR.startsWith(path.resolve(VOLUMEN_RAILWAY) + path.sep));
const PERSISTENTE = EN_RAILWAY ? Boolean(MONTAJE || DENTRO_DEL_VOLUMEN) : true;

if (EN_RAILWAY && !PERSISTENTE && process.env.PERMITIR_DISCO_TEMPORAL !== '1') {
  fatal(`Los datos irían a ${DATA_DIR}, que NO es un disco permanente: se borrarían en el próximo deploy.\n` +
        `  Solución: en Railway agregá un Volume montado en /data y la variable DATA_DIR=/data.\n` +
        `  El servidor no arranca para no perder ventas.`);
}

fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

/* ---------- Identificador del almacén ---------- */
// Cambia solo si el disco de datos es nuevo o se vació. La página lo usa para detectar
// que el servidor perdió datos y ofrecer restaurarlos desde la copia del navegador.
let almacen;
try { almacen = JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch (e) {}
if (!almacen || !almacen.id) {
  almacen = { id: crypto.randomBytes(9).toString('hex'), creado: new Date().toISOString() };
  fs.writeFileSync(META_FILE, JSON.stringify(almacen));
}

/* ---------- Ventas: en memoria + archivo JSON (escritura atómica y en cola) ---------- */
function ultimoRespaldo() {
  try {
    const f = fs.readdirSync(BACKUP_DIR).filter(n => /^ventas-.*\.json$/.test(n)).sort().pop();
    return f ? path.join(BACKUP_DIR, f) : '';
  } catch (e) { return ''; }
}

let ventas = new Map();
{
  let texto = null;
  try { texto = fs.readFileSync(VENTAS_FILE, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') fatal(`No se pudo leer ${VENTAS_FILE}: ${e.message}`); }
  if (texto !== null) {
    let arr;
    try { arr = JSON.parse(texto); if (!Array.isArray(arr)) throw new Error('no es una lista'); }
    catch (e) {
      // Archivo dañado: NO arrancar vacío (eso pisaría los datos). Se recupera del último respaldo.
      const r = ultimoRespaldo();
      fs.copyFileSync(VENTAS_FILE, VENTAS_FILE + '.danado-' + Date.now());
      if (!r) fatal(`${VENTAS_FILE} está dañado y no hay respaldos. Se guardó una copia del archivo dañado.`);
      console.error(`⚠ ${VENTAS_FILE} estaba dañado; se recupera desde ${r}`);
      arr = JSON.parse(fs.readFileSync(r, 'utf8'));
    }
    arr.forEach(v => v && ID_RE.test(v.id) && ventas.set(v.id, v));
  }
}

let ultimaCopia = 0;
try { const r = ultimoRespaldo(); if (r) ultimaCopia = fs.statSync(r).mtimeMs; } catch (e) {}

async function respaldar(forzar = false) {
  if (!forzar && Date.now() - ultimaCopia < RESPALDO_CADA_MS) return;
  if (!ventas.size) return;
  const nombre = 'ventas-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  await fsp.copyFile(VENTAS_FILE, path.join(BACKUP_DIR, nombre));
  ultimaCopia = Date.now();
  const viejos = (await fsp.readdir(BACKUP_DIR)).filter(n => /^ventas-.*\.json$/.test(n)).sort();
  for (const n of viejos.slice(0, Math.max(0, viejos.length - RESPALDOS_A_GUARDAR))) {
    await fsp.rm(path.join(BACKUP_DIR, n), { force: true });
  }
}

// Escribe ventas.json de forma atómica. Si falla, el error llega a quien guardó
// (la página muestra "Sin guardar" y reintenta) en lugar de responder OK.
let cola = Promise.resolve();
function persistir() {
  const tarea = cola.then(async () => {
    const tmp = VENTAS_FILE + '.tmp';
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(JSON.stringify([...ventas.values()])); await fh.sync(); }
    finally { await fh.close(); }
    await fsp.rename(tmp, VENTAS_FILE);
    try { await respaldar(); } catch (e) { console.error('No se pudo hacer el respaldo:', e.message); }
  });
  cola = tarea.catch(() => {});
  return tarea;
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

  if (p === '/health') return enviar(res, 200, { ok: true, persistente: PERSISTENTE });

  if (!autorizado(req)) {
    return enviar(res, 401, 'Se necesita contraseña', { 'WWW-Authenticate': 'Basic realm="Baly ventas", charset="UTF-8"' });
  }

  // Página
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const html = await fsp.readFile(INDEX_FILE);
    return enviar(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  }

  // Estado del almacenamiento (la página muestra una alarma si no es permanente)
  if (p === '/api/estado' && req.method === 'GET') {
    let respaldos = 0;
    try { respaldos = (await fsp.readdir(BACKUP_DIR)).filter(n => /^ventas-/.test(n)).length; } catch (e) {}
    return enviar(res, 200, {
      almacen: almacen.id, persistente: PERSISTENTE, enRailway: EN_RAILWAY,
      carpeta: DATA_DIR, montaje: MONTAJE || VOLUMEN_RAILWAY || null,
      ventas: ventas.size, respaldos, ultimoRespaldo: ultimaCopia ? new Date(ultimaCopia).toISOString() : null,
    }, { 'X-Data-Id': almacen.id });
  }

  // Ventas
  if (p === '/api/ventas' && req.method === 'GET') {
    return enviar(res, 200, [...ventas.values()], { 'X-Data-Id': almacen.id });
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
      const anterior = ventas.get(id);
      ventas.set(id, venta);
      try { await persistir(); }
      catch (e) {
        if (anterior) ventas.set(id, anterior); else ventas.delete(id);
        console.error('Error guardando ventas:', e);
        return enviar(res, 507, { error: 'No se pudo guardar en disco' });
      }
      return enviar(res, 200, venta, { 'X-Data-Id': almacen.id });
    }
    if (req.method === 'DELETE') {
      const anterior = ventas.get(id);
      ventas.delete(id);
      try { await persistir(); }
      catch (e) {
        if (anterior) ventas.set(id, anterior);
        console.error('Error guardando ventas:', e);
        return enviar(res, 507, { error: 'No se pudo guardar en disco' });
      }
      return enviar(res, 200, { ok: true }, { 'X-Data-Id': almacen.id });
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

const servidor = http.createServer((req, res) => {
  manejar(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) enviar(res, 500, { error: 'Error del servidor' });
    else res.end();
  });
}).listen(PORT, () => {
  console.log(`Baly ventas escuchando en el puerto ${PORT}`);
  console.log(`Datos en: ${DATA_DIR} · ${PERSISTENTE ? 'disco permanente' + (MONTAJE ? ` (${MONTAJE})` : '') : '⚠ DISCO TEMPORAL'}` +
              ` · ${ventas.size} ventas · almacén ${almacen.id}`);
  console.log(PASSWORD ? 'Con contraseña' : 'SIN contraseña (definí APP_PASSWORD)');
  respaldar(true).catch(e => console.error('No se pudo hacer el respaldo inicial:', e.message));
});

// Al apagar (deploy nuevo), terminar de escribir lo pendiente antes de salir
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    servidor.close();
    cola.finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
