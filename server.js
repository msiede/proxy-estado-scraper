import express from 'express';
import morgan from 'morgan';
import { chromium } from 'playwright';

const app = express();

/* ===================== CONFIG ===================== */
const PORT = process.env.PORT || 3000;
const TARGET_URL =
  process.env.TARGET_URL || 'https://estado-integraciones.dev.tracktec.cl/';
const ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ||
    'https://assermind.cl,https://www.assermind.cl')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

// 10 minutos de caché
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || (10 * 60 * 1000));
const cache = new Map(); // patente -> { t, data }

/* =================== MIDDLEWARES =================== */
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

/* ====================== SCRAPER ===================== */
async function runScrape(patente, debug = false) {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
    viewport: { width: 1366, height: 900 }
  });
  const page = await ctx.newPage();

  // Evitar peso extra
  await page.route('**/*', route => {
    const t = route.request().resourceType();
    if (['image', 'media', 'font'].includes(t)) return route.abort();
    route.continue();
  });

  try {
    // 1) Navegar
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 2) Input (“Ingresa Patente”)
    const inputSelectors = [
      'input[placeholder*="Ingresa Patente" i]',
      'input[placeholder*="Patente" i]',
      'input[name*="patent" i]',
      'input[id*="patent" i]',
      'input[type="text"]'
    ];
    let $input = null;
    for (const sel of inputSelectors) {
      $input = await page.$(sel);
      if ($input) break;
    }
    if (!$input) throw new Error('No se encontró el input de patente');
    await $input.fill(patente.toUpperCase());

    // 3) Botón Buscar
    const btnSelectors = [
      'button:has-text("Buscar")',
      'button[type="submit"]',
      'text=Buscar'
    ];
    let $btn = null;
    for (const sel of btnSelectors) {
      const el = await page.$(sel);
      if (el) {
        $btn = el;
        break;
      }
    }
    if (!$btn) throw new Error('No se encontró el botón "Buscar"');
    await $btn.click();

    // 4) Esperar resultados (según capturas: bloque .success-message / textos “Patente:” …)
    const waiters = [
      'div.success-message',
      '#result',
      'text=Patente:',
      'text=Transportista:',
      'text=Estado Sello:'
    ];
    let ready = false;
    for (const sel of waiters) {
      try {
        await page.waitForSelector(sel, { timeout: 15000 });
        ready = true;
        break;
      } catch {}
    }
    if (!ready) {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }

    // 5) Extraer datos exactamente como en tu HTML
    const payload = await page.evaluate(() => {
      const out = {};
      const reds = [];

      const isRed = (rgb) => {
        const m = rgb && rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (!m) return false;
        const r = +m[1], g = +m[2], b = +m[3];
        return r >= 170 && g <= 90 && b <= 90; // rojo notorio
      };

      const nearestLabel = (el) => {
        let cur = el;
        for (let i = 0; i < 4 && cur; i++) {
          const bySel = cur.querySelector?.('strong, b, label, .label, th, h3, h4');
          if (bySel && bySel.textContent.trim()) return bySel.textContent.trim();
          let p = cur.previousElementSibling;
          while (p) {
            const t = p.textContent?.trim();
            if (t && t.length <= 120) return t;
            p = p.previousElementSibling;
          }
          cur = cur.parentElement;
        }
        return el.textContent?.trim() || 'Indicador rojo';
      };

      // a) Patrón <p><strong>Etiqueta: </strong> Valor [emoji]</p>
      document.querySelectorAll('p').forEach(p => {
        const strong = p.querySelector('strong, b');
        if (!strong) return;
        const keyRaw = strong.textContent || '';
        const key = keyRaw.replace(/\s*:\s*$/, '').trim();
        if (!key) return;

        // Valor = texto del p menos el <strong>
        let val = '';
        const nodes = Array.from(p.childNodes);
        const idx = nodes.indexOf(strong);
        const after = nodes
          .slice(idx + 1)
          .map(n => (n.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' ')
          .trim();
        if (after) val = after;

        // Guardar
        if (val) out[key] = val;

        // Si contiene emoji rojo o palabra “rojo” => marcar
        if (/🔴|🟥|⛔|❌/u.test(val) || /\brojo\b/i.test(val)) {
          reds.push(key);
        }
      });

      // b) Bloques internos “acreditación” (ya quedan cubiertos por (a) porque también son <p><strong>…)
      // c) Ubicación -> link "Ver en mapa"
      const a = Array.from(document.querySelectorAll('a')).find(x =>
        /ver en mapa/i.test(x.textContent || '')
      );
      if (a && a.href) out['Ubicación'] = a.href;

      // d) Bolitas de color (span/div chicos)
      const all = Array.from(document.querySelectorAll('*'));
      all.forEach(el => {
        const cs = getComputedStyle(el);
        const small =
          (parseFloat(cs.width) <= 20 && parseFloat(cs.height) <= 20) ||
          (el.textContent && el.textContent.trim().length <= 2);
        if (small && (isRed(cs.color) || isRed(cs.backgroundColor))) {
          const label = nearestLabel(el);
          if (label) reds.push(label.replace(/\s*:\s*$/, ''));
        }
      });

      // Normalizar claves importantes
      const selloKey = Object.keys(out).find(k => /estado\s*sello/i.test(k));
      if (selloKey) out[selloKey] = String(out[selloKey]).trim();

      const dbmsKey = Object.keys(out).find(k => /^dbms$/i.test(k));
      if (dbmsKey) out[dbmsKey] = String(out[dbmsKey]).trim();

      return { out, reds: Array.from(new Set(reds)) };
    });

    const datos = payload.out || {};
    const alertas = new Set(payload.reds || []);

    // Reglas adicionales:
    // - DBMS: No acreditado
    const kDbms = Object.keys(datos).find(k => /^dbms$/i.test(k));
    if (kDbms && /no\s*acreditado/i.test(String(datos[kDbms]))) {
      alertas.add('DBMS');
    }

    // - Estado Sello ≠ ACTIVO
    const kSello = Object.keys(datos).find(k => /estado\s*sello/i.test(k));
    if (kSello && String(datos[kSello]).trim().toUpperCase() !== 'ACTIVO') {
      alertas.add('Estado Sello');
    }

    if (debug) await page.screenshot({ path: 'debug.png', fullPage: true });

    await browser.close();

    if (alertas.size) datos.__alertas_rojas = Array.from(alertas);
    return datos;
  } catch (e) {
    await browser.close();
    throw e;
  }
}

/* ====================== RUTAS ====================== */
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
