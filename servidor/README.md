# Servidor compartido de Captura Chess

Pequeño servidor (Cloudflare Worker, gratis) que guarda **tu** clave de Claude y lee las fotos de
quienes usan la app **sin clave propia**, siempre con **Claude Haiku 5.5** (≈ 5–15 pesos por foto).

- Límite por persona: **20 fotos al día** (`LIMITE_POR_PERSONA`).
- Límite total: **300 fotos al día** (`LIMITE_TOTAL`). Peor caso ≈ 4.000 pesos diarios.
- Solo acepta peticiones de la app (`https://djsierra2020-design.github.io`).
- Las fotos no se guardan: pasan a Claude y se descartan.

## Publicarlo (una sola vez)
1. Crea una cuenta gratis en <https://dash.cloudflare.com/sign-up>.
2. **Workers & Pages → Create → Import a repository** → conecta GitHub y elige `Captura-Chess-`.
3. Nombre del proyecto: `captura-chess`. En opciones avanzadas, **Root directory: `servidor`**.
   Deja el comando de despliegue como viene (`npx wrangler deploy`) y pulsa **Deploy**.
4. Cuando termine: **Settings → Variables and Secrets → Add** → tipo **Secret**,
   nombre `ANTHROPIC_API_KEY`, valor: una clave de console.anthropic.com
   (mejor crea una nueva solo para esto, p. ej. «Captura Chess compartida»). Guarda.
5. Copia la dirección del Worker (`https://captura-chess.<tu-cuenta>.workers.dev`) y ponla en
   `SERVIDOR` al principio de `app.js`.

Cada cambio en `main` vuelve a publicar el servidor automáticamente.

## Recomendado
En console.anthropic.com → **Settings → Limits** pon un **tope de gasto mensual** (p. ej. 5 dólares).

## Cambiar los límites
Edita `[vars]` en `wrangler.toml` (o en Cloudflare: Settings → Variables and Secrets).

## Probar en el computador
```
npm install
printf 'ANTHROPIC_API_KEY=sk-ant-...\n' > .dev.vars
npx wrangler dev
```
