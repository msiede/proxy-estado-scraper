import express from 'express';
import morgan from 'morgan';
import { chromium } from 'playwright';

const app = express();

// ======== CONFIG =========
const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL || 'https://estado-integraciones.dev.tracktec.cl/';
const ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://assermind.cl,https://www.assermind.cl')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

// Caché en memoria (10 minutos por patente)
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || (10 * 60 * 1000));
const cache = new Map(); // patente -> { t, data }

// ======== MIDDLEWARES ========
app.use(morgan('tiny'));

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ======== UTILS ========
async function runScrape(patente, debug = false) {
  // Lanzar Chromium
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });
  const page = await ctx.newPage();

  // Bloquear recursos pesados para acelerar
  await page.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    route.continue();
  });

  try {
    // 1) Ir al sitio
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 2) Escribir patente (probamos varios selectores)
    const inputSelectors = [
      'input[placeholder*="Patente" i]',
      'input[name*="patent" i]',
      'input[id*="patent" i]',
      'input[type="text"]'
    ];
    let okInput = false;
    for (const sel of inputSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.fill(patente);
        okInput = true;
        break;
      }
    }
    if (!okInput) throw new Error('No se encontró el input de patente');

    // 3) Click en "Buscar" (intenta por texto y por botón)
    const btnSelectors = [
      'button:has-text("Buscar")',
      'text=Buscar',
      'input[type="submit"]'
    ];
    let okBtn = false;
    for (const sel of btnSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        okBtn = true;
        break;
      }
    }
    if (!okBtn) throw new Error('No se encontró el botón Buscar');

    // 4) Esperar resultados
    // Idea: alguna etiqueta/label que suela aparecer. Ajusta si conoces la real.
    const waitSelectors = [
      'text="Estado Sello"',
      'text=Estado Sello',
      '.resultado, .resultados, .card, .table'
    ];
    let okWait = false;
    for (const sel of waitSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 15000 });
        okWait = true;
        break;
      } catch {}
    }
    if (!okWait) {
      // Último intento: espera cualquier cambio de red y un tiempo
      await page.waitForTimeout(3000);
    }

    // 5) Extraer pares clave: valor con varias estrategias
    const datos = await page.evaluate(() => {
      const out = {};

      // a) Pares “Campo: Valor” en texto simple
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node;
      const textSnips = [];
      while ((node = walker.nextNode())) {
        const t = (node.nodeValue || '').trim();
        if (t) textSnips.push(t);
      }
      textSnips.forEach(t => {
        const m = t.match(/^(.+?):\s*(.+)$/);
        if (m) {
          const key = m[1].trim();
          const val = m[2].trim();
          out[key] = val;
        }
      });

      // b) Tablas tipo <tr><th>Campo</th><td>Valor</td></tr> o <td>Campo</td><td>Valor</td>
      document.querySelectorAll('table').forEach(tbl => {
        tbl.querySelectorAll('tr').forEach(tr => {
          const cells = Array.from(tr.querySelectorAll('th,td')).map(c => c.innerText.trim());
          if (cells.length >= 2) {
            const key = cells[0];
            const val = cells.slice(1).join(' | ');
            if (key && val) out[key] = val;
          }
        });
      });

      // c) Tarjetas tipo <div><label>Campo</label><span>Valor</span>
      document.querySelectorAll('label, .label, strong').forEach(lbl => {
        const key = lbl.innerText?.trim();
        let val = '';
        if (!key) return;
        // busca un hermano cercano con el valor
        const parent = lbl.parentElement;
        if (parent) {
          const span = parent.querySelector('span, .value, .dato, p, div');
          if (span && span !== lbl) val = span.innerText?.trim() || '';
        }
        if (key && val) out[key] = val;
      });

      return out;
    });

   // 6) Normalizar la clave y el valor de “Estado Sello”
const keySello = Object.keys(datos).find(k => k.toLowerCase().includes('estado') && k.toLowerCase().includes('sello'));
if (keySello) {
  const valor = String(datos[keySello]).trim().toUpperCase();
  datos['Estado Sello'] = valor;
  if (keySello !== 'Estado Sello') delete datos[keySello];
}

    // 7) (Opcional) captura pantalla si debug
    if (debug) {
      await page.screenshot({ path: 'debug.png', fullPage: true });
    }

    await browser.close();
    return datos;
  } catch (e) {
    await browser.close();
    throw e;
  }
}

// ======== RUTAS ========
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/estado', async (req, res) => {
  const patente = String(req.query.patente || '').toUpperCase().trim();
  const debug = String(req.query.debug || '').toLowerCase() === '1';
  if (!patente) return res.status(400).json({ error: 'Patente requerida' });

  // Cache
  const hit = cache.get(patente);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) {
    return res.json(hit.data);
  }

  try {
    const data = await runScrape(patente, debug);

    // Si no se detectó nada, devolver algo útil
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

app.listen(PORT, () => console.log(`Scraper escuchando en :${PORT}`));
