# Captura Chess ♞

Toma una foto de una partida de ajedrez (tablero real o pantalla de Lichess, Chess.com, libro, TV…).
La app reconoce la posición, te deja corregirla y sigues jugando contra **Stockfish** dentro del celular.

## Cómo se usa
1. **📷 Tomar foto** (o **🖼️ Elegir foto o captura**).
2. Con la clave de API puesta, Claude lee la posición y la app va **directo a la mejor jugada**.
   Si en la foto no se ve a quién le toca, lo calcula por el número de jugadas (botón 🔁 para
   cambiarlo). En «Ver la foto y comparar» → «Corregir» arreglas cualquier pieza mal leída.
3. **🔍 Analizar esta posición**: Stockfish a máxima fuerza muestra la evaluación (barra de ventaja),
   la mejor jugada marcada en el tablero y las 3 mejores líneas. Toca una línea para hacer su jugada o
   mueve piezas de cualquier bando para probar ideas; ◀ ▶ para ir y volver. «Abrir en Lichess» lleva
   la posición al análisis de Lichess.
4. **▶️ Jugar contra Stockfish**: eliges con qué color juegas y el nivel (1 a 8).
   Tienes 💡 Pista (mejor jugada), ↩️ Deshacer, barra de ventaja y copiar FEN/PGN.

La partida se guarda en el celular; con **Continuar partida guardada** la retomas.

## Sin clave de API: usar Claude Pro con «📋 Pegar FEN»
La suscripción Claude Pro no incluye la API, pero sirve igual:
1. En la app toca **📋 Pegar FEN** → **📝 Copiar pedido para Claude**.
2. En el chat de Claude adjunta la foto, pega el pedido y envía.
3. Copia la respuesta de Claude, vuelve a la app, toca **📋 Pegar** y luego **Usar**
   (puedes pegar la respuesta completa: la app encuentra el FEN dentro del texto).
4. Revisa la posición en el editor y juega.

## Clave de Claude (para el reconocimiento automático)
1. Entra a <https://console.anthropic.com>, carga saldo y crea una clave en **API Keys**.
2. En la app: **⚙️ Ajustes** → pega la clave → **Guardar**.

La clave queda guardada **solo en ese celular** y la app llama directo a Claude (no hay servidor).
Cada foto cuesta unos centavos de dólar. Sin clave, la app funciona igual: usas la foto como guía y
colocas las piezas a mano.

## Publicarla gratis (GitHub Pages)
En GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` /
`(root)` → Save**. En un par de minutos queda en
`https://<tu-usuario>.github.io/<nombre-del-repo>/`.

En el celular abre esa dirección y en el menú del navegador elige **Agregar a la pantalla de inicio**.
Después funciona sin internet (excepto el reconocimiento de fotos).

Si cambias archivos, sube el número de `VERSION` en `sw.js` para que los celulares bajen lo nuevo.

## Qué hay adentro
- `index.html`, `app.js`: la app (sin compilación).
- `vendor/stockfish-19-lite-single.*`: Stockfish 19 (red neuronal ligera, WASM de un hilo; GPLv3, ver
  `vendor/STOCKFISH-LICENCIA.txt`). El análisis también consulta la base de análisis en la nube de Lichess.
- `vendor/chess.js`: reglas del ajedrez (licencia BSD).
- `vendor/anthropic.js`: SDK oficial de Anthropic para JavaScript, empaquetado para el navegador.
- Reconocimiento: modelo `claude-opus-5-5` con salida estructurada (8 filas → FEN) y
  respaldo automático a otro modelo si el primero se niega.
