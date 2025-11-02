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
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });
  const page = await ctx.newPage();

  // Bloquear recursos pesados
  await page.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    route.continue();
  });

  try {
    // 1) Ir al sitio
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 2) Escribir patente
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

    // 3) Click en "Buscar"
    const btnSelectors = [
      'button:has-text("Buscar")',
      'text=Buscar',
      'input[type="submit"]'
    ];
    let okBtn = false;
    for (const sel of btnSelectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); okBtn = true; break; }
    }
    if (!okBtn) throw new Error('No se encontró el botón Buscar');

    // 4) Esperar resultados
    const waitSelectors = [
      'text="Estado Sello"', 'text=Estado Sello', '.resultado, .resultados, .card, .table'
    ];
    let okWait = false;
    for (const sel of waitSelectors) {
      try { await page.waitForSelector(sel, { timeout: 15000 }); okWait = true; break; } catch {}
    }
    if (!okWait) await page.waitForTimeout(3000);

    // 5) Extraer datos y “puntos rojos”
    const payload = await page.evaluate(() => {
      const out = {};
      const reds = [];

      const isRed = (rgb) => {
        const m = rgb && rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (!m) return false;
        const r = +m[1], g = +m[2], b = +m[3];
        return r >= 170 && g <= 70 && b <= 70; // rojo visible
      };
      const nearestLabel = (el) => {
        let cur = el;
        for (let i = 0; i < 4 && cur; i++) {
          const bySel = cur.querySelector?.('label, .label, strong, b, h3, h4, th');
          if (bySel && bySel.textContent.trim()) return bySel.textContent.trim();
          let p = cur.previousElementSibling;
          while (p) {
            const t = p.textContent?.trim();
            if (t && t.length <= 120) return t;
            p = p.previousElementSibling;
          }
          cur = cur.parentElement;
        }
        const selfText = el.textContent?.trim();
        return selfText || 'Indicador rojo';
      };

      // a) Texto “Campo: Valor”
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node; const textSnips = [];
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
          if (/🔴|🟥|⛔|❌/u.test(val) || /\brojo\b/i.test(val)) reds.push(key);
        }
      });

      // b) Tablas
      document.querySelectorAll('table').forEach(tbl => {
        tbl.querySelectorAll('tr').forEach(tr => {
          const cells = Array.from(tr.querySelectorAll('th,td')).map(c => c.innerText.trim());
          if (cells.length >= 2) {
            const key = cells[0];
            const val = cells.slice(1).join(' | ');
            if (key && val) {
              out[key] = val;
              if (/🔴|🟥|⛔|❌/u.test(val) || /\brojo\b/i.test(val)) reds.push(key);
            }
          }
        });
      });

      // c) Tarjetas label + valor
      document.querySelectorAll('label, .label, strong, b').forEach(lbl => {
        const key = lbl.innerText?.trim();
        if (!key) return;
        const parent = lbl.parentElement;
        let val = '';
        if (parent) {
          const span = parent.querySelector('span, .value, .dato, p, div');
          if (span && span !== lbl) val = span.innerText?.trim() || '';
        }
        if (key && val) {
          out[key] = val;
          if (/🔴|🟥|⛔|❌/u.test(val) || /\brojo\b/i.test(val)) reds.push(key);
        }
      });

      // d) Puntos/bolitas coloreadas por CSS
      const all = Array.from(document.querySelectorAll('*'));
      all.forEach(el => {
        const cs = getComputedStyle(el);
        const looksDot = el.textContent?.trim() === '•' || el.textContent?.trim() === '●' || /dot|status|badge/i.test(el.className || '');
        if (looksDot || isRed(cs.color) || isRed(cs.backgroundColor)) {
          const label = nearestLabel(el);
          if (label && !reds.includes(label)) reds.push(label);
        }
      });

      // Normalizar Estado Sello
      const keySello = Object.keys(out).find(k => k.toLowerCase().includes('estado') && k.toLowerCase().includes('sello'));
      if (keySello) out[keySello] = String(out[keySello]).trim();

      return { out, reds: Array.from(new Set(reds)) };
    });

    const datos = payload.out || {};
    const alertasRojas = new Set(payload.reds || []);

    // --- Regla explícita: DBMS NO ACREDITADO ---
    const dbmsKey = Object.keys(datos).find(k => k.toLowerCase().trim() === 'dbms');
    if (dbmsKey) {
      const dbmsVal = String(datos[dbmsKey] || '');
      if (/no\s*acreditado/i.test(dbmsVal)) {
        alertasRojas.add('DBMS: NO ACREDITADO');
      }
    }

    if (debug) await page.screenshot({ path: 'debug.png', fullPage: true });

    await browser.close();

    if (alertasRojas.size) {
      datos.__alertas_rojas = Array.from(alertasRojas);
    }
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
