# T4P News Backend — guía de despliegue

Sistema que descarga noticias reales, las traduce al español, las clasifica
por activo y calcula el HYPE — para los 9 activos de Time 4 Profit.

## Antes de empezar

Necesitas:
1. Una cuenta gratuita en [cloudflare.com](https://cloudflare.com)
2. Node.js instalado en tu ordenador ([nodejs.org](https://nodejs.org), la versión LTS)
3. Una API key de Anthropic (la consigues en [console.anthropic.com](https://console.anthropic.com))

## Paso 1 — Instalar la herramienta de Cloudflare

Abre una terminal (en Mac: Terminal; en Windows: PowerShell) y escribe:

```bash
npm install -g wrangler
wrangler login
```

Esto abrirá tu navegador para que inicies sesión en Cloudflare.

## Paso 2 — Crear la base de datos

Dentro de la carpeta de este proyecto (`t4p-news-backend`), ejecuta:

```bash
wrangler d1 create t4p-news-db
```

Esto te dará un `database_id`. Cópialo y pégalo en el archivo `wrangler.toml`,
en la línea que dice `database_id = "PON_AQUI_TU_DATABASE_ID"`.

Después, crea las tablas:

```bash
wrangler d1 execute t4p-news-db --file=./schema.sql --remote
```

## Paso 3 — Añadir tu API key de Anthropic (de forma segura)

```bash
wrangler secret put ANTHROPIC_API_KEY
```

Te pedirá que pegues la clave — no se guarda en ningún archivo del proyecto,
queda cifrada dentro de Cloudflare.

## Paso 4 — Desplegar

```bash
wrangler deploy
```

Al terminar, te dará una URL parecida a:

```
https://t4p-news-backend.tu-usuario.workers.dev
```

Esa es la URL de tu backend. Guárdala.

## Paso 5 — Probarlo

- Visita `TU_URL/api/run-now` en el navegador una vez, para forzar la primera
  descarga de noticias (si no, tendrías que esperar hasta 10 minutos al primer cron).
- Después visita `TU_URL/api/news` — deberías ver un JSON con los 9 activos,
  su HYPE y sus noticias.

## Paso 6 — Conectarlo a tu web

Abre `frontend-snippet.html` (en esta misma carpeta), sigue las instrucciones
que trae arriba, y pega el bloque en tu página principal.

## Mantenimiento

- El cron corre solo cada 10 minutos, no tienes que hacer nada manualmente.
- Si alguna fuente RSS deja de funcionar (cambia de URL con el tiempo, es
  normal), edita la lista `RSS_FEEDS` en `src/index.js` y vuelve a hacer
  `wrangler deploy`.
- Para ver logs en vivo mientras algo falla: `wrangler tail`

## Coste esperado

- Cloudflare Workers + D1: gratis dentro de los límites normales de esta web.
- Anthropic API: depende del volumen de noticias nuevas por día — con 5
  fuentes y noticias nuevas cada 10 min, normalmente unos pocos euros al mes.

## Si algo se atasca

Dime exactamente qué comando ejecutaste y qué error te dio, y lo resolvemos
paso a paso.
