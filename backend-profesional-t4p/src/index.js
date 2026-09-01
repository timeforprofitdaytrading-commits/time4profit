// ============================================================================
// T4P News Backend — Cloudflare Worker
// ============================================================================
// Qué hace:
//  1. Cada 10 min (cron), descarga RSS de varias fuentes financieras.
//  2. Para cada noticia NUEVA (no vista antes), llama a la API de Claude para
//     traducirla al español, clasificarla por activo, calcular impacto,
//     sentimiento y confianza — todo en una sola llamada.
//  3. Guarda el resultado en la base de datos D1.
//  4. Expone un endpoint GET /api/news que tu web consulta para pintar las
//     6 casillas, ya con el HYPE de cada activo calculado al vuelo.
// ============================================================================

// Los 6 activos exactos que muestra la web.
const ASSETS = [
  "EURUSD", "GBPUSD", "SP500",
  "NAS100", "BTC", "XAU",
];

// Fuentes RSS. OJO: las URLs de RSS cambian con el tiempo — si una deja de
// funcionar, ese feed simplemente no aportará noticias ese día (no rompe nada).
const RSS_FEEDS = [
  { source: "FXStreet", url: "https://www.fxstreet.com/rss/news" },
  { source: "Investing.com", url: "https://www.investing.com/rss/news_301.rss" },
  { source: "DailyFX", url: "https://www.dailyfx.com/feeds/all" },
  { source: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
  // Bloomberg no ofrece RSS público gratuito con contenido completo (ver aviso
  // en la conversación) — MarketWatch lo sustituye como fuente seria y accesible.
];

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

async function sha1(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Parser de RSS muy simple, basado en regex. Sirve para feeds RSS 2.0 estándar.
function parseRSS(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    if (title && link) {
      items.push({
        title: decodeEntities(title),
        link: link.trim(),
        publishedAt: pubDate ? Date.parse(pubDate) : Date.now(),
      });
    }
  }
  return items;
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

// ---------------------------------------------------------------------------
// Clasificación con Claude: traduce + asigna activos + impacto + sentimiento
// ---------------------------------------------------------------------------

async function classifyWithClaude(env, title, sourceUrl) {
  const prompt = `Eres un analista financiero. Analiza este titular de noticia financiera y responde ÚNICAMENTE con un JSON válido, sin texto adicional, con este formato exacto:

{
  "title_es": "título traducido al español, natural y conciso",
  "summary_es": "resumen de una frase en español",
  "assets": ["lista de códigos de activo afectados, solo de esta lista: EURUSD, GBPUSD, SP500, NAS100, BTC, XAU"],
  "impact": "ALTO, MEDIO o BAJO",
  "sentiment": "ALCISTA, BAJISTA o NEUTRAL",
  "confidence": número entre 0 y 1
}

Reglas:
- "assets" puede tener varios códigos si la noticia afecta a varios (ej: una noticia de la Fed suele afectar a EURUSD, GBPUSD, SP500, NAS100, BTC, XAU).
- Si la noticia no afecta a ninguno de estos 6 activos, devuelve "assets": [].

Titular original: "${title}"`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Claude API error: ${res.status}`);
  }
  const data = await res.json();
  const text = data.content.map((b) => b.text || "").join("");
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ---------------------------------------------------------------------------
// Cron: se ejecuta cada 10 minutos
// ---------------------------------------------------------------------------

async function handleScheduled(env) {
  // Limpieza automática: borra noticias con más de 24h para no acumular datos.
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
  await env.DB.prepare("DELETE FROM articles WHERE published_at < ?").bind(cutoff).run();

  for (const feed of RSS_FEEDS) {
    let items = [];
    try {
      const res = await fetch(feed.url, { headers: { "user-agent": "Mozilla/5.0" } });
      if (!res.ok) continue; // fuente caída: se salta, no rompe el resto
      const xml = await res.text();
      items = parseRSS(xml);
    } catch (err) {
      // Una fuente caída no debe romper el resto del proceso.
      console.log(`Fuente caída: ${feed.source} — ${err.message}`);
      continue;
    }

    for (const item of items.slice(0, 15)) {
      const id = await sha1(item.link);

      const existing = await env.DB
        .prepare("SELECT id FROM articles WHERE id = ?")
        .bind(id)
        .first();
      if (existing) continue; // ya la teníamos, evita duplicados

      let classified;
      try {
        classified = await classifyWithClaude(env, item.title, item.link);
      } catch (err) {
        console.log(`Error clasificando "${item.title}": ${err.message}`);
        continue; // si falla la IA en esta noticia, se intenta con la siguiente
      }

      if (!classified.assets || classified.assets.length === 0) continue; // no relevante

      await env.DB
        .prepare(
          `INSERT INTO articles
           (id, source, source_url, title_original, title_es, summary_es,
            published_at, fetched_at, assets, impact, sentiment, confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          feed.source,
          item.link,
          item.title,
          classified.title_es,
          classified.summary_es || "",
          Math.floor(item.publishedAt / 1000),
          Math.floor(Date.now() / 1000),
          JSON.stringify(classified.assets),
          classified.impact,
          classified.sentiment,
          classified.confidence
        )
        .run();
    }
  }
}

// ---------------------------------------------------------------------------
// Cálculo del HYPE (0-100) por activo, a partir de las noticias recientes
// ---------------------------------------------------------------------------

function computeHype(articles, windowHours) {
  if (articles.length === 0) return 0;

  const now = Date.now() / 1000;
  const impactWeight = { ALTO: 3, MEDIO: 2, BAJO: 1 };
  let score = 0;

  for (const a of articles) {
    const ageHours = (now - a.published_at) / 3600;
    const recencyFactor = Math.max(0, 1 - ageHours / windowHours); // decae con el tiempo
    score += (impactWeight[a.impact] || 1) * a.confidence * (0.4 + 0.6 * recencyFactor);
  }

  // Nº de fuentes distintas: más fuentes hablando de lo mismo = más atención real
  const sourceCount = new Set(articles.map((a) => a.source)).size;
  score *= 1 + Math.min(sourceCount - 1, 3) * 0.15;

  // Normalizado a 0-100 de forma aproximada (ajustable con el uso real)
  return Math.min(100, Math.round(score * 8));
}

function hypeLabel(score) {
  if (score >= 86) return "EXTREME";
  if (score >= 61) return "HIGH";
  if (score >= 31) return "MEDIUM";
  return "LOW";
}

// ---------------------------------------------------------------------------
// API pública: GET /api/news
// ---------------------------------------------------------------------------

async function handleApiNews(env) {
  const windowHours = Number(env.HYPE_WINDOW_HOURS || 24);
  const since = Math.floor(Date.now() / 1000) - windowHours * 3600;

  const { results } = await env.DB
    .prepare("SELECT * FROM articles WHERE published_at >= ? ORDER BY published_at DESC")
    .bind(since)
    .all();

  const byAsset = {};
  for (const asset of ASSETS) byAsset[asset] = [];

  for (const row of results) {
    const assets = JSON.parse(row.assets);
    for (const asset of assets) {
      if (byAsset[asset]) byAsset[asset].push(row);
    }
  }

  const response = {};
  for (const asset of ASSETS) {
    const list = byAsset[asset];
    const hype = computeHype(list, windowHours);
    response[asset] = {
      hype,
      hypeLabel: hypeLabel(hype),
      newsCount: list.length,
      news: list.slice(0, 3).map((a) => ({
        title: a.title_es,
        source: a.source,
        url: a.source_url,
        publishedAt: a.published_at,
        impact: a.impact,
        sentiment: a.sentiment,
      })),
    };
  }

  return response;
}

// ---------------------------------------------------------------------------
// Entradas del Worker
// ---------------------------------------------------------------------------

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "access-control-allow-origin": "*", // ajusta a tu dominio en producción
      "access-control-allow-methods": "GET",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/api/news") {
      const data = await handleApiNews(env);
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    // Endpoint manual para forzar una actualización mientras pruebas
    // (visítalo en el navegador: tu-worker.workers.dev/api/run-now)
    if (url.pathname === "/api/run-now") {
      await handleScheduled(env);
      return new Response("OK, ejecutado.", { headers: corsHeaders });
    }

    return new Response("T4P News Backend activo. Usa /api/news", { headers: corsHeaders });
  },
};
