// server.js
import express from 'express';
import morgan from 'morgan';
import { chromium } from 'playwright';

const app = express();

/* =======================
   CONFIGURACIÓN BÁSICA
   ======================= */
const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL || 'https://estado-integraciones.dev.tracktec.cl/';
const ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://assermind.cl,https://www.assermind.cl')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

// Cache en memoria (por patente)
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || (10 * 60 * 1000)); // 10 min por defecto
const cache = new Map(); // patente -> { t, data }

/* =======================
   MIDDLEWARES
   ======================= */
app.use(morgan('tiny'));
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/* =======================
   NAVEGADOR COMPARTIDO + COLA
   ======================= */
// Concurrencia máxima (en instancias pequeñas, 1 es lo más seguro)
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);
// Reciclar el navegador cada N usos (previene fugas)
const RESTART_EVERY = Number(process.env.RESTART_EVERY || 50);

let sharedBrowser = null;
let useCount = 0;

async function getBrowser() {
  if (!sharedBrowser) {
    sharedBrowser = await chromium.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
      // headless true por defecto
    });
    useCount = 0;
  }
  return sharedBrowser;
}

async function maybeRecycleBrowser() {
  useCount++;
  if (useCount >= RESTART_EVERY) {
    try { await sharedBrowser?.close(); } catch {}
    sharedBrowser = null;
    useCount = 0;
  }
}

// Cola muy simple para limitar concurrencia
const queue = [];
let active = 0;
function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runNext();
  });
}
function runNext() {
  if (active >= CONCURRENCY || queue.length === 0) return;
  const { fn, resolve, reject } = queue.shift();
  active++;
  fn()
    .then(resolve)
    .catch(reject)
    .finally(() => { active--; runNext(); });
}

/* =======================
   SCRAPER
   ======================= */
async function runScrape(patente, debug = false) {
  return enqueue(async () => {
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
      viewport: { width: 1200, height: 800 }
    });
    const page = await ctx.newPage();

    // Bloquear recursos pesados para ahorrar memoria/ancho de banda
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (['image', 'media', 'font'].includes(t)) return route.abort();
      route.continue();
    });

    try {
      // 1) Ir al sitio
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // 2) Input patente (probamos varios selectores)
      const inputSelectors = [
        'input[placeholder*="Patente" i]',
        'input[name*="patent" i]',
        'input[id*="patent" i]',
        'input[type="text"]'
      ];
      let okInput = false;
      for (const sel of inputSelectors) {
        const el = await page.$(sel);
        if (el) { await el.fill(patente); okInput = true; break; }
      }
      if (!okInput) throw new Error('No se encontró el input de patente');

      // 3) Click en “Buscar”
      const btnSelectors = ['button:has-text("Buscar")', 'text=Buscar', 'input[type="submit"]'];
      let okBtn = false;
      for (const sel of btnSelectors) {
        const el = await page.$(sel);
        if (el) { await el.click(); okBtn = true; break; }
      }
      if (!okBtn) throw new Error('No se encontró el botón Buscar');

      // 3.1) Espera al sitio
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});

      // 4) Esperar algún indicador de resultados
      const waitSelectors = ['text=Estado Sello', '.ant-descriptions', '.table', '.card', '.resultados', '.resultado'];
      let okWait = false;
      for (const sel of waitSelectors) {
        try { await page.waitForSelector(sel, { timeout: 15000 }); okWait = true; break; } catch {}
      }
      if (!okWait) await page.waitForTimeout(2000);

      // 5) Extraer pares clave/valor (dirigido + filtros + link Ubicación)
      const datos = await page.evaluate(() => {
        const out = {};

        const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
        const add = (k, v) => {
          const key = norm(k);
          const val = norm(v);
          if (!key || !val) return;
          // descarta claves con pinta de fecha/hora o sin letras
          if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(key)) return;
          if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(key)) return; // 31/10/2025
          if (/^\d{1,2}:\d{2}$/.test(key)) return;             // 07:49
          out[key] = val;
        };

        // 0) Capturar “Ubicación” con href (si existe)
        document.querySelectorAll('*, * *').forEach(el => {
          const text = norm(el.textContent || '');
          if (!text) return;
          if (/^ubicación\b/i.test(text) || /\bubicación:/i.test(text)) {
            const a = el.querySelector('a[href]') || el.nextElementSibling?.querySelector?.('a[href]') || el.parentElement?.querySelector?.('a[href]');
            if (a?.href) out['Ubicación'] = a.href;
          }
        });

        // a) Ant Design Descriptions
        document.querySelectorAll('.ant-descriptions-item').forEach(item => {
          const k = item.querySelector('.ant-descriptions-item-label')?.textContent || '';
          const v = item.querySelector('.ant-descriptions-item-content')?.textContent || '';
          if (/ubicación/i.test(k)) {
            const a = item.querySelector('a[href]');
            add(k, a?.href || v);
          } else {
            add(k, v);
          }
        });

        // b) Tablas <tr><th>Campo</th><td>Valor</td>
        document.querySelectorAll('table').forEach(tbl => {
          tbl.querySelectorAll('tr').forEach(tr => {
            const cells = Array.from(tr.querySelectorAll('th,td')).map(c => norm(c.innerText)).filter(Boolean);
            if (cells.length >= 2) {
              const m = cells[0].match(/^(.+?):\s*(.+)$/);
              if (m && m[1] && m[2]) add(m[1], m[2]);
              else add(cells[0], cells.slice(1).join(' | '));
            }
          });
        });

        // c) Definition lists
        document.querySelectorAll('dl').forEach(dl => {
          const dts = dl.querySelectorAll('dt'); const dds = dl.querySelectorAll('dd');
          for (let i = 0; i < Math.min(dts.length, dds.length); i++) add(dts[i].innerText, dds[i].innerText);
        });

        // d) Párrafos / líneas “<strong>Campo:</strong> Valor” o “Campo: Valor”
        document.querySelectorAll('p, li, div').forEach(node => {
          const strong = node.querySelector('strong, b');
          if (strong) {
            const label = norm(strong.textContent || '');
            if (/:$/.test(label)) {
              const key = label.replace(/:$/, '');
              let val = norm(node.textContent || '').replace(label, '');
              if (/ubicación/i.test(key)) {
                const a = node.querySelector('a[href]');
                if (a?.href) val = a.href;
              }
              if (val) add(key, val);
            }
          } else {
            const t = norm(node.textContent || '');
            const m = t.match(/^(.+?):\s+(.+)$/);
            if (m && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(m[1]) && m[1].length <= 60) add(m[1], m[2]);
          }
        });

        // e) Si “Ubicación” quedó como texto, intenta href global
        if (out['Ubicación'] && !/^https?:\/\//i.test(out['Ubicación'])) {
          const a = document.querySelector('a[href*="maps.google"], a[href*="google.com/maps"], a[href*="maps.app.goo"]');
          if (a?.href) out['Ubicación'] = a.href;
        }

        return out;
      });

      // 6) Normalizar “Estado Sello” (clave fija + MAYÚSCULAS)
      const keySello = Object.keys(datos).find(k => k.toLowerCase().includes('estado') && k.toLowerCase().includes('sello'));
      if (keySello) {
        const valor = String(datos[keySello]).trim().toUpperCase();
        datos['Estado Sello'] = valor;
        if (keySello !== 'Estado Sello') delete datos[keySello];
      }

      // 6.bis) Asegurar patente
      if (!datos['Patente']) datos['Patente'] = patente;

      // 7) Debug opcional
      if (debug) {
        // evita screenshots en producción para ahorrar RAM/IO
        // await page.screenshot({ path: 'debug.png', fullPage: true });
      }

      return datos;

    } finally {
      // cierre SIEMPRE (evita fugas de memoria)
      try { await page.close(); } catch {}
      try { await ctx.close(); } catch {}
      await maybeRecycleBrowser();
    }
  });
}

// Ruta de debug HTML (también pasa por la cola)
async function runDebugHTML(patente) {
  return enqueue(async () => {
    const browser = await getBrowser();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const inputSelectors = [
        'input[placeholder*="Patente" i]',
        'input[name*="patent" i]',
        'input[id*="patent" i]',
        'input[type="text"]'
      ];
      for (const sel of inputSelectors) { const el = await page.$(sel); if (el) { await el.fill(patente); break; } }
      const btnSelectors = ['button:has-text("Buscar")','text=Buscar','input[type="submit"]'];
      for (const sel of btnSelectors) { const el = await page.$(sel); if (el) { await el.click(); break; } }
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
      await page.waitForTimeout(800);
      return await page.content();
    } finally {
      try { await page.close(); } catch {}
      try { await ctx.close(); } catch {}
      await maybeRecycleBrowser();
    }
  });
}

/* =======================
   RUTAS
   ======================= */
app.get('/health', (req, res) => res.json({ ok: true }));

// Raíz amigable
app.get('/', (req, res) => {
  res.type('text/plain').send('OK - usa /health o /api/estado?patente=XXYY11');
});

// Endpoint principal (con cache)
app.get('/api/estado', async (req, res) => {
  const patente = String(req.query.patente || '').toUpperCase().trim();
  const debug = String(req.query.debug || '').toLowerCase() === '1';
  if (!patente) return res.status(400).json({ error: 'Patente requerida' });

  // cache simple en memoria
  const hit = cache.get(patente);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) {
    return res.json(hit.data);
  }

  try {
    const data = await runScrape(patente, debug);
    if (!data || Object.keys(data).length === 0) {
      return res.status(200).json({ Patente: patente, mensaje: 'Sin datos detectados. Ajustar selectores.' });
    }
    cache.set(patente, { t: Date.now(), data });
    res.json(data);
  } catch (e) {
    console.error('Scrape error:', e.message);
    res.status(500).json({ error: 'Fallo de scraping', detalle: e.message });
  }
});

// Diagnóstico: ver HTML tras la búsqueda (úsalo puntualmente)
app.get('/api/debug', async (req, res) => {
  const patente = String(req.query.patente || '').toUpperCase().trim();
  if (!patente) return res.status(400).send('patente requerida');
  try {
    const html = await runDebugHTML(patente);
    res.type('text/html').send(html);
  } catch (e) {
    res.status(500).send('debug error: ' + e.message);
  }
});

app.listen(PORT, () => console.log(`Scraper escuchando en :${PORT}`));
