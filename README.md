# Captura Chess ♞

Toma una foto de una partida de ajedrez (tablero real o pantalla de Lichess, Chess.com, libro, TV…).
La app reconoce la posición, te deja corregirla y sigues jugando contra **Stockfish** dentro del celular.

## Cómo se usa
1. **📷 Tomar foto** (o **🖼️ Elegir foto o captura**).
2. Claude lee la posición. Revisa el tablero: toca una pieza de la paleta y luego la casilla para
   corregir; 🗑️ borra. Elige **a quién le toca**.
3. **Jugar desde esta posición**: eliges con qué color juegas y el nivel (1 a 8).
   Tienes 💡 Pista (mejor jugada), ↩️ Deshacer, barra de ventaja y copiar FEN/PGN.

La partida se guarda en el celular; con **Continuar partida guardada** la retomas.

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
- `vendor/stockfish.js`: Stockfish 10 (GPLv3, ver `vendor/STOCKFISH-LICENCIA.txt`).
- `vendor/chess.js`: reglas del ajedrez (licencia BSD).
- `vendor/anthropic.js`: SDK oficial de Anthropic para JavaScript, empaquetado para el navegador.
- Reconocimiento: modelo `claude-opus-5-5` con salida estructurada (8 filas → FEN) y
  respaldo automático a otro modelo si el primero se niega.
