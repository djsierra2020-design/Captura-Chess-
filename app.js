// Captura Chess: foto -> posición (Claude) -> corregir -> jugar contra Stockfish (en el celular).
import { Anthropic } from "./vendor/anthropic.js";

const $ = (id) => document.getElementById(id);
const INICIAL = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const GLIFO = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const VS = "︎"; // fuerza el glifo de texto (evita el peón emoji en Android)
const MODELO = "claude-opus-5-5";

// ---------- almacenamiento local (puede fallar en modo privado) ----------
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const leer = (k, def) => { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } };

// ---------- utilidades de posición ----------
function fenAMatriz(fen) {
  return fen.split(" ")[0].split("/").map((fila) =>
    [...fila].flatMap((c) => (/\d/.test(c) ? Array(+c).fill(null) : [c])));
}
function matrizAFen(m, turno, contadores = "0 1") {
  const piezas = m.map((fila) => {
    let s = "", v = 0;
    for (const c of fila) { if (c) { if (v) { s += v; v = 0; } s += c; } else v++; }
    return s + (v || "");
  }).join("/");
  let enr = "";
  if (m[7][4] === "K") { if (m[7][7] === "R") enr += "K"; if (m[7][0] === "R") enr += "Q"; }
  if (m[0][4] === "k") { if (m[0][7] === "r") enr += "k"; if (m[0][0] === "r") enr += "q"; }
  return `${piezas} ${turno} ${enr || "-"} - ${contadores}`;
}
const nombreCasilla = (f, c) => "abcdefgh"[c] + (8 - f);

/** Devuelve un texto con el problema, o null si la posición se puede jugar. */
function problemaPosicion(fen) {
  const m = fenAMatriz(fen), todas = m.flat();
  const cuenta = (p) => todas.filter((x) => x === p).length;
  if (cuenta("K") !== 1 || cuenta("k") !== 1) return "Debe haber exactamente un rey blanco y un rey negro.";
  if ([...m[0], ...m[7]].some((x) => x === "P" || x === "p")) return "Hay peones en la primera u octava fila; eso no es posible.";
  if (cuenta("P") > 8 || cuenta("p") > 8) return "Hay más de 8 peones de un color.";
  const v = new Chess().validate_fen(fen);
  if (!v.valid) return "Posición inválida: " + v.error;
  // El bando que NO juega no puede estar en jaque.
  const partes = fen.split(" "); partes[1] = partes[1] === "w" ? "b" : "w";
  const otro = new Chess(partes.join(" "));
  if (otro.in_check()) return `El rey ${partes[1] === "w" ? "blanco" : "negro"} está en jaque pero no le toca jugar: revisa el turno o las piezas.`;
  return null;
}

// ---------- dibujo de tableros ----------
function dibujarTablero(el, matriz, { girado = false, clases = {}, alTocar } = {}) {
  el.innerHTML = "";
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const f = girado ? 7 - i : i, c = girado ? 7 - j : j;
    const cas = document.createElement("div");
    const sq = nombreCasilla(f, c);
    cas.className = "casilla " + ((f + c) % 2 ? "oscura" : "clara") + (clases[sq] ? " " + clases[sq] : "");
    const p = matriz[f][c];
    if (p) {
      const s = document.createElement("span");
      s.className = "pieza " + (p === p.toUpperCase() ? "b" : "n");
      s.textContent = GLIFO[p.toLowerCase()] + VS;
      cas.appendChild(s);
      if (clases[sq] && clases[sq].includes("destino")) cas.classList.add("ocupada");
    }
    if (j === 0) cas.insertAdjacentHTML("beforeend", `<span class="coord f">${8 - f}</span>`);
    if (i === 7) cas.insertAdjacentHTML("beforeend", `<span class="coord c">${"abcdefgh"[c]}</span>`);
    cas.addEventListener("click", () => alTocar && alTocar(sq, f, c));
    el.appendChild(cas);
  }
}

// ---------- vistas ----------
const VISTAS = ["vInicio", "vCargando", "vEditor", "vJugar", "vAnalisis"];
function mostrar(v) {
  if (v !== "vAnalisis") detenerAnalisis();
  VISTAS.forEach((x) => ($(x).hidden = x !== v)); window.scrollTo(0, 0);
}

// ---------- motor Stockfish (Web Worker) ----------
const PROFUNDIDAD_ANALISIS = 24;
const NIVELES = { // como los niveles 1-8 de Lichess, aproximado
  1: { skill: 0, depth: 1, ms: 80 },   2: { skill: 3, depth: 2, ms: 150 },
  3: { skill: 6, depth: 4, ms: 250 },  4: { skill: 9, depth: 6, ms: 400 },
  5: { skill: 12, depth: 8, ms: 700 }, 6: { skill: 15, depth: 11, ms: 1000 },
  7: { skill: 18, depth: 14, ms: 1500 }, 8: { skill: 20, depth: 20, ms: 2500 },
};
class Motor {
  constructor() {
    this.w = new Worker("vendor/stockfish-19-lite-single.js");
    this.oyente = null;
    this.w.onmessage = (e) => { const l = typeof e.data === "string" ? e.data : ""; this.oyente && this.oyente(l); };
    this.cola = this.esperar("uci", "uciok").then(() => this.esperar("isready", "readyok"));
  }
  esperar(cmd, fin) {
    return new Promise((ok) => { this.oyente = (l) => { if (l.startsWith(fin)) ok(); }; this.w.postMessage(cmd); });
  }
  /** Busca la mejor jugada. Devuelve {mejor, cp, mate} con la evaluación desde el lado de las blancas. */
  buscar(fen, { skill, depth, ms }) {
    const tarea = () => new Promise((ok) => {
      const blancas = fen.split(" ")[1] === "w";
      let cp = null, mate = null;
      this.oyente = (l) => {
        if (l.startsWith("info") && l.includes(" score ")) {
          const m = l.match(/score (cp|mate) (-?\d+)/);
          if (m) {
            const n = +m[2] * (blancas ? 1 : -1);
            if (m[1] === "cp") { cp = n; mate = null; } else { mate = n; cp = null; }
          }
        } else if (l.startsWith("bestmove")) {
          const mejor = l.split(" ")[1];
          ok({ mejor: mejor && mejor !== "(none)" ? mejor : null, cp, mate });
        }
      };
      this.w.postMessage(`setoption name Skill Level value ${skill}`);
      this.w.postMessage("setoption name MultiPV value 1");
      this.w.postMessage("ucinewgame");
      this.w.postMessage(`position fen ${fen}`);
      this.w.postMessage(`go depth ${depth} movetime ${ms}`);
    });
    const p = this.cola.then(tarea);
    this.cola = p.catch(() => {});
    return p;
  }
  /** Análisis a máxima fuerza con las 3 mejores líneas. alInfo recibe {n, depth, cp, mate, pv}
   *  (evaluación desde el lado de las blancas). Devuelve {detener}. */
  analizar(fen, alInfo, alTerminar) {
    let detenido = false, enCurso = false;
    const tarea = () => new Promise((ok) => {
      if (detenido) return ok();
      enCurso = true;
      const blancas = fen.split(" ")[1] === "w";
      this.oyente = (l) => {
        if (l.startsWith("info") && l.includes(" pv ") && !/bound/.test(l)) {
          const s = l.match(/score (cp|mate) (-?\d+)/);
          if (!s) return;
          const n = +(l.match(/ multipv (\d+)/)?.[1] || 1), depth = +(l.match(/ depth (\d+)/)?.[1] || 0);
          const v = +s[2] * (blancas ? 1 : -1);
          alInfo({ n, depth, cp: s[1] === "cp" ? v : null, mate: s[1] === "mate" ? v : null,
                   pv: l.split(" pv ")[1].trim().split(/\s+/) });
        } else if (l.startsWith("bestmove")) {
          enCurso = false; ok();
          if (!detenido && alTerminar) alTerminar();
        }
      };
      this.w.postMessage("setoption name Skill Level value 20");
      this.w.postMessage("setoption name MultiPV value 3");
      this.w.postMessage(`position fen ${fen}`);
      this.w.postMessage(`go depth ${PROFUNDIDAD_ANALISIS}`);
    });
    const p = this.cola.then(tarea);
    this.cola = p.catch(() => {});
    return { detener: () => { detenido = true; if (enCurso) this.w.postMessage("stop"); } };
  }
}
let motor = null;
const obtenerMotor = () => (motor ||= new Motor());

// ---------- estado ----------
const est = {
  foto: null,               // dataURL de la última foto
  ed: { m: fenAMatriz(INICIAL), turno: "w", girado: false, pieza: "P" },
  juego: null,              // instancia de Chess
  inicioFen: INICIAL,
  color: "w", nivel: leer("nivel", 4), girado: false,
  sel: null, ultima: null, pista: null, pensando: false, generacion: 0,
};

// ---------- inicio ----------
function actualizarInicio() {
  $("avisoClave").hidden = !!leer("clave", "");
  $("btnContinuar").hidden = !leer("partida", null);
}
$("btnCamara").onclick = () => $("inCamara").click();
$("btnGaleria").onclick = () => $("inGaleria").click();
$("inCamara").onchange = $("inGaleria").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) procesarFoto(f); };
$("btnManual").onclick = () => abrirEditor(INICIAL, { sinFoto: true });
$("btnInicial").onclick = () => empezarJuego(INICIAL);

// ---------- pegar FEN ----------
const PEDIDO_CLAUDE = `Mira la foto de este tablero de ajedrez y dame la posición en notación FEN, \
vista desde las blancas (fila 8 primero). Revisa casilla por casilla. Si no se sabe a quién le toca, \
pon "w". Responde solo con el FEN en una línea.`;

/** Busca un FEN dentro de cualquier texto (p. ej. la respuesta completa de Claude). */
function extraerFen(texto) {
  const limpio = String(texto || "").replace(/[`*]/g, " ");
  const re = /((?:[pnbrqkPNBRQK1-8]{1,8}\/){7}[pnbrqkPNBRQK1-8]{1,8})(?:\s+([wb])(?:\s+([KQkq]{1,4}|-))?(?:\s+([a-h][36]|-))?(?:\s+(\d+))?(?:\s+(\d+))?)?/;
  const m = limpio.match(re);
  if (!m) return { error: "No encontré un FEN en el texto. Debe verse así: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" };
  const filas = m[1].split("/");
  for (const [i, f] of filas.entries()) {
    const n = [...f].reduce((s, c) => s + (/\d/.test(c) ? +c : 1), 0);
    if (n !== 8) return { error: `La fila ${8 - i} del FEN no tiene 8 casillas (${f}). Revisa el texto o corrígelo en el editor.` };
  }
  const turno = m[2] || "w";
  const fen = `${m[1]} ${turno} ${m[3] || "-"} ${m[4] || "-"} ${m[5] || 0} ${m[6] || 1}`;
  return { fen, turnoConocido: !!m[2] };
}
function abrirPegarFen() {
  $("inFen").value = ""; $("errFen").hidden = true;
  $("dlgFen").showModal();
}
$("btnPegarFen").onclick = () => { est.foto = null; abrirPegarFen(); };
$("btnFenEd").onclick = abrirPegarFen;
$("btnCancelarFen").onclick = () => $("dlgFen").close();
$("btnCopiarPedido").onclick = (e) => copiar(PEDIDO_CLAUDE, e.target);
$("btnLeerPortapapeles").onclick = async () => {
  try { $("inFen").value = await navigator.clipboard.readText(); }
  catch { $("inFen").focus(); $("errFen").textContent = "No pude leer el portapapeles: mantén presionado el cuadro y elige «Pegar»."; $("errFen").hidden = false; }
};
$("btnUsarFen").onclick = () => {
  const r = extraerFen($("inFen").value);
  if (r.error) { $("errFen").textContent = r.error; $("errFen").hidden = false; return; }
  $("dlgFen").close();
  abrirEditor(r.fen, {
    notas: r.turnoConocido ? "Posición cargada del FEN. Revísala con la foto antes de jugar."
                           : "El FEN no dice a quién le toca: elígelo abajo.",
    preguntarTurno: !r.turnoConocido,
  });
};
$("btnContinuar").onclick = () => {
  const p = leer("partida", null); if (!p) return;
  est.color = p.color; empezarJuego(p.inicio, p.jugadas);
};
$("lnkAjustes").onclick = (e) => { e.preventDefault(); abrirAjustes(); };

// ---------- ajustes ----------
function abrirAjustes() { $("inClave").value = leer("clave", ""); $("dlgAjustes").showModal(); }
$("btnAjustes").onclick = abrirAjustes;
$("btnGuardarClave").onclick = () => { guardar("clave", $("inClave").value.trim()); $("dlgAjustes").close(); actualizarInicio(); };
$("btnBorrarClave").onclick = () => { guardar("clave", ""); $("inClave").value = ""; $("dlgAjustes").close(); actualizarInicio(); };

// ---------- foto y reconocimiento ----------
function reducirImagen(archivo, lado = 1568) {
  return new Promise((ok, mal) => {
    const url = URL.createObjectURL(archivo), img = new Image();
    img.onload = () => {
      const k = Math.min(1, lado / Math.max(img.width, img.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      ok(cv.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); mal(new Error("No se pudo abrir la imagen.")); };
    img.src = url;
  });
}

const INSTRUCCIONES = `Eres un experto en reconocer posiciones de ajedrez en imágenes.
La imagen puede ser una foto de un tablero físico (con perspectiva, sombras o reflejos) o una
captura o foto de la pantalla de Lichess, Chess.com u otra app, un libro o la TV.

Devuelve la posición SIEMPRE desde el punto de vista de las blancas: filas[0] es la fila 8
(a8..h8) y filas[7] es la fila 1 (a1..h1); dentro de cada fila, de la columna a a la h.
Si en la imagen las negras están abajo, gira la posición antes de escribirla.
Usa las coordenadas impresas en el tablero si se ven; si no, recuerda que h1 es una casilla clara.

Cada fila tiene exactamente 8 caracteres: K Q R B N P para piezas blancas, k q r b n p para
negras y "." para casilla vacía. Revisa casilla por casilla y comprueba que cada fila tenga 8.
En "turno" pon "w" o "b" solo si la imagen lo indica (reloj activo, última jugada resaltada,
texto de turno); si no se sabe, "?".
En "notas" explica en español, en una o dos frases cortas, cualquier duda (casillas tapadas,
piezas que no se distinguen). Si todo está claro, deja "notas" vacío.
Si la imagen no muestra un tablero de ajedrez, es_tablero = false.`;

const ESQUEMA = {
  type: "object",
  properties: {
    es_tablero: { type: "boolean" },
    filas: { type: "array", items: { type: "string" } },
    turno: { type: "string", enum: ["w", "b", "?"] },
    notas: { type: "string" },
  },
  required: ["es_tablero", "filas", "turno", "notas"],
  additionalProperties: false,
};

let controlRec = null;
async function reconocer(dataUrl, clave) {
  const client = new Anthropic({ apiKey: clave, dangerouslyAllowBrowser: true, maxRetries: 2 });
  controlRec = new AbortController();
  const r = await client.beta.messages.create({
    model: MODELO,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: { type: "json_schema", schema: ESQUEMA } },
    system: INSTRUCCIONES,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: dataUrl.split(",")[1] } },
        { type: "text", text: "¿Cuál es la posición de este tablero?" },
      ],
    }],
  }, { signal: controlRec.signal });
  if (r.stop_reason === "refusal") throw new Error("No se pudo analizar esta imagen.");
  const texto = r.content.find((b) => b.type === "text")?.text || "";
  let d;
  try { d = JSON.parse(texto); } catch { throw new Error("La respuesta llegó incompleta; intenta de nuevo."); }
  if (!d.es_tablero) throw new Error("No veo un tablero de ajedrez en la foto. " + (d.notas || ""));
  const filas = (d.filas || []).slice(0, 8);
  while (filas.length < 8) filas.push("........");
  const m = filas.map((f) => {
    const s = String(f).replace(/\s+/g, "").replace(/[1-8]/g, (n) => ".".repeat(+n));
    return [...(s + "........").slice(0, 8)].map((c) => ("KQRBNPkqrbnp".includes(c) ? c : null));
  });
  return { m, turno: d.turno, notas: d.notas || "", filasCompletas: (d.filas || []).length === 8 };
}

function mensajeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "La clave de Claude no es válida. Revísala en Ajustes ⚙️.";
  if (e instanceof Anthropic.PermissionDeniedError) return "La clave no tiene permiso para usar este modelo.";
  if (e instanceof Anthropic.RateLimitError) return "Demasiadas fotos seguidas o sin saldo; espera un momento.";
  if (e instanceof Anthropic.APIConnectionError) return "Sin conexión con Claude. Revisa tu internet.";
  if (e instanceof Anthropic.APIError) return `Claude respondió con un error (${e.status ?? "?"}).`;
  return e.message || String(e);
}

async function procesarFoto(archivo) {
  let dataUrl;
  try { dataUrl = await reducirImagen(archivo); } catch (e) { alert(e.message); return; }
  est.foto = dataUrl;
  const clave = leer("clave", "");
  if (!clave) { $("dlgSinClave").showModal(); return; }
  $("fotoCargando").src = dataUrl;
  mostrar("vCargando");
  try {
    const r = await reconocer(dataUrl, clave);
    if ($("vCargando").hidden) return; // el usuario canceló
    let notas = r.notas;
    if (!r.filasCompletas) notas = (notas ? notas + " " : "") + "No se leyeron todas las filas; revísalas.";
    if (r.turno === "?") notas = (notas ? notas + " " : "") + "No se sabe a quién le toca: elígelo abajo.";
    abrirEditor(matrizAFen(r.m, r.turno === "b" ? "b" : "w"), { notas, preguntarTurno: r.turno === "?" });
  } catch (e) {
    if ($("vCargando").hidden || e.name === "AbortError" || e instanceof Anthropic.APIUserAbortError) return;
    abrirEditor(INICIAL, { notas: mensajeError(e) + " Puedes armar la posición a mano.", esError: true });
  }
}
$("btnSkPegar").onclick = () => { $("dlgSinClave").close(); abrirPegarFen(); };
$("btnSkManual").onclick = () => { $("dlgSinClave").close(); abrirEditor(INICIAL, { notas: "Coloca las piezas mirando la foto (Vaciar deja el tablero en blanco)." }); };
$("btnSkClave").onclick = () => { $("dlgSinClave").close(); abrirAjustes(); };
$("btnSkCancelar").onclick = () => $("dlgSinClave").close();
$("btnCancelarRec").onclick = () => { controlRec?.abort(); abrirEditor(INICIAL); };

// ---------- editor ----------
function abrirEditor(fen, { notas = "", esError = false, sinFoto = false, preguntarTurno = false } = {}) {
  if (sinFoto) est.foto = null;
  est.ed.m = fenAMatriz(fen);
  est.ed.turno = fen.split(" ")[1] || "w";
  est.ed.contadores = fen.split(" ").slice(4, 6).join(" ") || "0 1";
  $("detFoto").hidden = !est.foto;
  if (est.foto) $("fotoEditor").src = est.foto;
  $("notasRec").hidden = !notas;
  $("notasRec").textContent = notas;
  $("notasRec").classList.toggle("error", esError);
  $("errEditor").hidden = true;
  $("segTurno").style.outline = preguntarTurno ? "3px solid #e0a800" : "";
  dibujarEditor();
  mostrar("vEditor");
}
function dibujarEditor() {
  dibujarTablero($("tabEditor"), est.ed.m, {
    girado: est.ed.girado,
    alTocar: (sq, f, c) => {
      const p = est.ed.pieza;
      est.ed.m[f][c] = p === "x" || est.ed.m[f][c] === p ? null : p;
      $("errEditor").hidden = true;
      dibujarEditor();
    },
  });
  marcarSegmentado("segTurno", est.ed.turno);
  [...$("paleta").children].forEach((b) => b.classList.toggle("activa", b.dataset.p === est.ed.pieza));
}
(function crearPaleta() {
  const orden = ["K", "Q", "R", "B", "N", "P", "x", "k", "q", "r", "b", "n", "p"];
  for (const p of orden) {
    const b = document.createElement("button");
    b.dataset.p = p;
    if (p === "x") { b.className = "borrar"; b.textContent = "🗑️"; b.setAttribute("aria-label", "Borrar"); }
    else b.innerHTML = `<span class="pieza ${p === p.toUpperCase() ? "b" : "n"}">${GLIFO[p.toLowerCase()]}${VS}</span>`;
    b.onclick = () => { est.ed.pieza = p; dibujarEditor(); };
    $("paleta").appendChild(b);
  }
  // 7 columnas: blancas + borrar en la primera fila, negras en la segunda
})();
function marcarSegmentado(id, v) { [...$(id).children].forEach((b) => b.classList.toggle("activa", b.dataset.v === v)); }
$("segTurno").onclick = (e) => { const v = e.target.dataset.v; if (v) { est.ed.turno = v; $("segTurno").style.outline = ""; dibujarEditor(); } };
$("btnGirarEd").onclick = () => { est.ed.girado = !est.ed.girado; dibujarEditor(); };
$("btnVaciar").onclick = () => { est.ed.m = fenAMatriz("8/8/8/8/8/8/8/8 w - - 0 1"); dibujarEditor(); };
$("btnPosInicial").onclick = () => { est.ed.m = fenAMatriz(INICIAL); est.ed.turno = "w"; dibujarEditor(); };
$("btnVolverInicio").onclick = () => { actualizarInicio(); mostrar("vInicio"); };
function fenDelEditor() {
  const fen = matrizAFen(est.ed.m, est.ed.turno, est.ed.contadores);
  const p = problemaPosicion(fen);
  if (p) { $("errEditor").textContent = p; $("errEditor").hidden = false; return null; }
  return fen;
}
$("btnJugarDesde").onclick = () => {
  const fen = fenDelEditor(); if (!fen) return;
  est.color = est.ed.turno; // por defecto juegas con el bando al que le toca
  empezarJuego(fen);
};
$("btnAnalizarDesde").onclick = () => { const fen = fenDelEditor(); if (fen) abrirAnalisis(fen); };

// ---------- análisis ----------
const an = { juego: null, futuro: [], lineas: [], ctrl: null, sel: null, girado: false, ultima: null, profundidad: 0, listo: false, dibujoPendiente: false };

function abrirAnalisis(fen) {
  an.juego = new Chess(fen); an.inicioFen = fen; an.futuro = []; an.sel = null; an.ultima = null;
  an.girado = fen.split(" ")[1] === "b";
  mostrar("vAnalisis");
  reanalizar();
}
function detenerAnalisis() { if (an.ctrl) { an.ctrl.detener(); an.ctrl = null; } }
function reanalizar() {
  detenerAnalisis();
  an.lineas = []; an.profundidad = 0; an.listo = false; an.nube = null;
  dibujarAnalisis();
  if (an.juego.game_over()) return;
  const fen = an.juego.fen();
  // Base de análisis profundo de Lichess (si la posición ya fue analizada allí, llega al instante).
  fetch("https://lichess.org/api/cloud-eval?multiPv=3&fen=" + encodeURIComponent(fen))
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d || !Array.isArray(d.pvs) || !d.pvs.length || an.juego.fen() !== fen) return;
      an.nube = { depth: d.depth, lineas: d.pvs.map((p, i) => ({
        n: i + 1, depth: d.depth, cp: p.cp ?? null, mate: p.mate ?? null, pv: String(p.moves).split(" ") })) };
      programarDibujo();
    })
    .catch(() => {});
  an.ctrl = obtenerMotor().analizar(fen, (i) => {
    if (an.juego.fen() !== fen) return;
    an.lineas[i.n - 1] = i;
    if (i.n === 1) an.profundidad = i.depth;
    programarDibujo();
  }, () => { if (an.juego.fen() === fen) { an.listo = true; programarDibujo(); } });
}
function programarDibujo() {
  if (an.dibujoPendiente) return;
  an.dibujoPendiente = true;
  requestAnimationFrame(() => { an.dibujoPendiente = false; dibujarAnalisis(); });
}
function textoEval(cp, mate) {
  if (mate != null) return (mate > 0 ? "+" : "−") + "M" + Math.abs(mate);
  if (cp == null) return "…";
  return (cp > 0 ? "+" : cp < 0 ? "−" : "") + (Math.abs(cp) / 100).toFixed(1);
}
/** Notación en español: R rey, D dama, T torre, A alfil, C caballo. */
const sanEs = (san) => san.replace(/[KQRBN]/g, (c) => ({ K: "R", Q: "D", R: "T", B: "A", N: "C" })[c]);
const NOMBRE = { p: "Peón", n: "Caballo", b: "Alfil", r: "Torre", q: "Dama", k: "Rey" };
/** Jugada UCI -> objeto para chess.js (acepta enroques escritos rey→torre, como los da Lichess). */
function uciAJugada(c, u) {
  let from = u.slice(0, 2), to = u.slice(2, 4);
  const p = c.get(from), dest = c.get(to);
  if (p && p.type === "k" && dest && dest.type === "r" && dest.color === p.color) to = (to[0] === "h" ? "g" : "c") + to[1];
  return { from, to, promotion: u[4] };
}
function describirJugada(m) {
  let t;
  if (m.flags.includes("k")) t = "Enroque corto";
  else if (m.flags.includes("q")) t = "Enroque largo";
  else t = `${NOMBRE[m.piece]} de ${m.from} ${m.captured ? "captura en" : "a"} ${m.to}`;
  if (m.promotion) t += `, corona ${NOMBRE[m.promotion].toLowerCase()}`;
  if (m.san.endsWith("#")) t += " — ¡jaque mate!"; else if (m.san.endsWith("+")) t += ", con jaque";
  return t;
}
function pvASan(fen, pv, max = 10) {
  const c = new Chess(fen), partes = [];
  let num = +fen.split(" ")[5] || 1, primero = true;
  for (const u of pv.slice(0, max)) {
    const blancas = c.turn() === "w";
    const m = c.move(uciAJugada(c, u));
    if (!m) break;
    const s = sanEs(m.san);
    if (blancas) partes.push(`${num}. ${s}`);
    else { partes.push(primero ? `${num}… ${s}` : s); num++; }
    primero = false;
  }
  return partes.join(" ");
}
function textoFinDePartida(g) {
  if (g.in_checkmate()) return `Jaque mate: ganan las ${g.turn() === "w" ? "negras" : "blancas"}.`;
  if (g.in_stalemate()) return "Tablas por ahogado.";
  if (g.insufficient_material()) return "Tablas: material insuficiente.";
  if (g.in_draw()) return "Tablas.";
  return null;
}
function dibujarAnalisis() {
  const g = an.juego, fen = g.fen(), clases = {};
  if (an.ultima) { clases[an.ultima.from] = "ultima"; clases[an.ultima.to] = "ultima"; }
  const usarNube = !!(an.nube && an.nube.depth > an.profundidad);
  const lineas = usarNube ? an.nube.lineas : an.lineas;
  const mejor = lineas[0]?.pv?.[0];
  if (mejor) { clases[mejor.slice(0, 2)] = "pista"; clases[mejor.slice(2, 4)] = "pista"; }
  if (g.in_check()) {
    fenAMatriz(fen).forEach((fila, f) => fila.forEach((p, c) => {
      if (p === (g.turn() === "w" ? "K" : "k")) { const sq = nombreCasilla(f, c); clases[sq] = (clases[sq] || "") + " jaque"; }
    }));
  }
  if (an.sel) {
    clases[an.sel] = (clases[an.sel] || "") + " sel";
    for (const mv of g.moves({ square: an.sel, verbose: true })) clases[mv.to] = (clases[mv.to] || "") + " destino";
  }
  dibujarTablero($("tabAnalisis"), fenAMatriz(fen), { girado: an.girado, clases, alTocar: tocarAnalisis });
  $("evalbarAn").classList.toggle("girada", an.girado);
  $("anTurno").textContent = `Juegan las ${g.turn() === "w" ? "blancas" : "negras"}`;
  $("origenAnalisis").innerHTML = textoOrigen(an.inicioFen, "Analizando") +
    (g.history().length ? `<small>${g.history().length} jugada(s) probadas desde ahí · ⏮ vuelve a la posición original</small>` : "");
  const fin = textoFinDePartida(g);
  $("anProfundidad").textContent = fin ? "" : usarNube ? `Lichess · profundidad ${an.nube.depth} ✓`
    : an.profundidad ? `Stockfish 19 · profundidad ${an.profundidad}${an.listo ? " ✓" : " · calculando…"}` : "Calculando…";
  const l1 = lineas[0];
  if (fin) {
    if (g.in_checkmate()) actualizarEval(null, g.turn() === "w" ? -1 : 1, "An"); else actualizarEval(0, null, "An");
    $("evalTextoAn").textContent = fin;
  }
  else if (l1) actualizarEval(l1.cp, l1.mate, "An");
  else { actualizarEval(null, null, "An"); $("evalTextoAn").textContent = ""; }
  // Tarjeta grande con la mejor jugada
  const tarjeta = $("anMejor");
  if (fin) tarjeta.hidden = true;
  else {
    tarjeta.hidden = false;
    const bando = g.turn() === "w" ? "blancas" : "negras";
    if (!l1) tarjeta.innerHTML = `<div class="et">Mejor jugada para las ${bando}</div><div class="san"><span class="girando"></span>calculando…</div>`;
    else {
      const m = new Chess(fen).move(uciAJugada(new Chess(fen), l1.pv[0]));
      const firme = usarNube || an.listo || an.profundidad >= 18;
      tarjeta.innerHTML = `<div class="et">Mejor jugada para las ${bando}</div>
        <div class="san"></div><div class="desc"></div><div class="conf"></div>`;
      tarjeta.querySelector(".san").textContent = m ? sanEs(m.san) : l1.pv[0];
      tarjeta.querySelector(".desc").textContent = m ? describirJugada(m) : "";
      tarjeta.querySelector(".conf").textContent = firme ? "✓ Análisis profundo" : "Aún calculando: puede cambiar en unos segundos.";
      tarjeta.classList.toggle("firme", firme);
    }
  }
  const cont = $("anLineas"); cont.innerHTML = "";
  lineas.forEach((l) => {
    if (!l) return;
    const b = document.createElement("button");
    b.className = "linea";
    b.innerHTML = `<span class="ev"></span><span class="pv"></span>`;
    b.querySelector(".ev").textContent = textoEval(l.cp, l.mate);
    b.querySelector(".pv").textContent = pvASan(fen, l.pv);
    b.onclick = () => jugarAnalisis(uciAJugada(an.juego, l.pv[0]));
    cont.appendChild(b);
  });
  $("anJugadas").textContent = sanEs(g.pgn().replace(/^\[.*\]\s*$/gm, "").trim()) || "(sin jugadas)";
  $("btnAnAtras").disabled = $("btnAnInicio").disabled = g.history().length === 0;
  $("btnAnAdelante").disabled = an.futuro.length === 0;
}
function tocarAnalisis(sq) {
  const g = an.juego;
  if (g.game_over()) return;
  if (an.sel) {
    const mv = g.moves({ square: an.sel, verbose: true }).filter((m) => m.to === sq);
    if (mv.length) {
      if (mv.some((m) => m.promotion)) elegirPromocion(g.turn()).then((pr) => pr && jugarAnalisis({ from: an.sel, to: sq, promotion: pr }));
      else jugarAnalisis({ from: an.sel, to: sq });
      return;
    }
  }
  const p = g.get(sq);
  an.sel = p && p.color === g.turn() ? sq : null;
  dibujarAnalisis();
}
function jugarAnalisis(m, { conservarFuturo = false } = {}) {
  const r = an.juego.move(m);
  if (!r) return;
  if (!conservarFuturo) an.futuro = [];
  an.ultima = r; an.sel = null;
  reanalizar();
}
function retrocederAnalisis() {
  const m = an.juego.undo(); if (!m) return false;
  an.futuro.push(m);
  const h = an.juego.history({ verbose: true }); an.ultima = h[h.length - 1] || null; an.sel = null;
  return true;
}
$("btnAnAtras").onclick = () => { if (retrocederAnalisis()) reanalizar(); };
$("btnAnInicio").onclick = () => { let x = false; while (retrocederAnalisis()) x = true; if (x) reanalizar(); };
$("btnAnAdelante").onclick = () => { const m = an.futuro.pop(); if (m) jugarAnalisis({ from: m.from, to: m.to, promotion: m.promotion }, { conservarFuturo: true }); };
$("btnAnGirar").onclick = () => { an.girado = !an.girado; dibujarAnalisis(); };
$("btnAnEditar").onclick = () => abrirEditor(an.juego.fen());
$("btnAnFoto").onclick = () => $("inCamara").click();
$("btnAnJugar").onclick = () => { const fen = an.juego.fen(); est.color = fen.split(" ")[1]; empezarJuego(fen); };
$("btnAnLichess").onclick = () => window.open("https://lichess.org/analysis/standard/" + an.juego.fen().replace(/ /g, "_"), "_blank", "noopener");
$("btnAnCopiarFen").onclick = (e) => copiar(an.juego.fen(), e.target);

// ---------- juego ----------
function empezarJuego(fen, jugadas = []) {
  est.inicioFen = fen;
  est.juego = new Chess(fen);
  for (const j of jugadas) est.juego.move({ from: j.slice(0, 2), to: j.slice(2, 4), promotion: j[4] });
  est.sel = null; est.pista = null; est.generacion++; est.verIdx = null;
  const hist = est.juego.history({ verbose: true });
  est.ultima = hist.length ? hist[hist.length - 1] : null;
  est.girado = est.color === "b";
  $("selNivel").value = String(est.nivel);
  actualizarEval(null, null);
  mostrar("vJugar");
  dibujarJuego();
  obtenerMotor();
  if (est.juego.turn() === est.color) { if ($("chkSiempre").checked) mostrarPista(); }
  else turnoMotorSiToca();
}
function guardarPartida() {
  guardar("partida", { inicio: est.inicioFen, color: est.color, jugadas: est.juego.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion || "")) });
}
/** Texto de origen: de dónde salió la posición inicial. */
function textoOrigen(fen, verbo) {
  if (fen === INICIAL) return `${verbo} desde la posición inicial`;
  const desde = est.foto ? "de la foto" : "elegida";
  return `${verbo} a partir de la posición ${desde}<small>Empezó jugando las ${fen.split(" ")[1] === "w" ? "blancas" : "negras"}</small>`;
}
/** Posición que se está viendo (con ◀ ▶ se pueden repasar las jugadas sin borrarlas). */
function juegoVisible() {
  if (est.verIdx == null) return est.juego;
  const c = new Chess(est.inicioFen), h = est.juego.history({ verbose: true });
  for (let i = 0; i < est.verIdx; i++) c.move({ from: h[i].from, to: h[i].to, promotion: h[i].promotion });
  return c;
}
function irA(idx) {
  const n = est.juego.history().length;
  idx = Math.max(0, Math.min(n, idx));
  est.verIdx = idx >= n ? null : idx;
  est.sel = null;
  dibujarJuego();
}
$("btnJInicio").onclick = () => irA(0);
$("btnJAtras").onclick = () => irA((est.verIdx ?? est.juego.history().length) - 1);
$("btnJAdelante").onclick = () => irA((est.verIdx ?? est.juego.history().length) + 1);
$("btnJFinal").onclick = () => irA(Infinity);
function dibujarJuego() {
  const g = juegoVisible(), clases = {}, total = est.juego.history().length, viendo = est.verIdx != null;
  const ultima = viendo ? (est.verIdx ? est.juego.history({ verbose: true })[est.verIdx - 1] : null) : est.ultima;
  $("origenJuego").innerHTML = textoOrigen(est.inicioFen, "Jugando");
  if (ultima) { clases[ultima.from] = "ultima"; clases[ultima.to] = "ultima"; }
  if (est.pista && !viendo) { clases[est.pista.slice(0, 2)] = "pista"; clases[est.pista.slice(2, 4)] = "pista"; }
  if (g.in_check()) {
    const m = fenAMatriz(g.fen()), rey = g.turn() === "w" ? "K" : "k";
    m.forEach((fila, f) => fila.forEach((p, c) => { if (p === rey) clases[nombreCasilla(f, c)] = (clases[nombreCasilla(f, c)] || "") + " jaque"; }));
  }
  if (est.sel) {
    clases[est.sel] = (clases[est.sel] || "") + " sel";
    for (const mv of g.moves({ square: est.sel, verbose: true })) clases[mv.to] = (clases[mv.to] || "") + " destino";
  }
  dibujarTablero($("tabJuego"), fenAMatriz(g.fen()), { girado: est.girado, clases, alTocar: tocarCasilla });
  $("evalbar").classList.toggle("girada", est.girado);
  marcarSegmentado("segColor", est.color);
  $("estado").textContent = viendo ? `Viendo la jugada ${est.verIdx} de ${total}. Toca ⏭ para volver a la partida.` : textoEstado();
  $("jugadas").textContent = sanEs(est.juego.pgn().replace(/^\[.*\]\s*$/gm, "").trim()) || "(sin jugadas)";
  $("btnDeshacer").disabled = total === 0 || viendo;
  $("btnJInicio").disabled = $("btnJAtras").disabled = (est.verIdx ?? total) === 0;
  $("btnJAdelante").disabled = $("btnJFinal").disabled = !viendo;
}
function textoEstado() {
  const g = est.juego;
  if (g.in_checkmate()) return `¡Jaque mate! Ganan las ${g.turn() === "w" ? "negras" : "blancas"}.`;
  if (g.in_stalemate()) return "Tablas por ahogado.";
  if (g.insufficient_material()) return "Tablas: material insuficiente.";
  if (g.in_threefold_repetition()) return "Tablas por triple repetición.";
  if (g.in_draw()) return "Tablas (regla de 50 jugadas).";
  if (est.pensando) return "Stockfish está pensando…";
  const jaque = g.in_check() ? "¡Jaque! " : "";
  return jaque + (g.turn() === est.color ? "Te toca." : "Le toca a Stockfish.");
}
function tocarCasilla(sq) {
  if (est.verIdx != null) { $("estado").textContent = "Estás repasando jugadas: toca ⏭ para volver y seguir jugando."; return; }
  const g = est.juego;
  if (g.game_over() || est.pensando || g.turn() !== est.color) return;
  const pieza = g.get(sq);
  if (est.sel) {
    const mv = g.moves({ square: est.sel, verbose: true }).filter((m) => m.to === sq);
    if (mv.length) {
      if (mv.some((m) => m.promotion)) elegirPromocion(g.turn()).then((pr) => pr && hacerJugada({ from: est.sel, to: sq, promotion: pr }));
      else hacerJugada({ from: est.sel, to: sq });
      return;
    }
  }
  est.sel = pieza && pieza.color === g.turn() ? sq : null;
  dibujarJuego();
}
function elegirPromocion(color) {
  return new Promise((ok) => {
    const cont = $("promoOpciones"); cont.innerHTML = "";
    for (const p of ["q", "r", "b", "n"]) {
      const b = document.createElement("button");
      b.innerHTML = `<span class="pieza ${color === "w" ? "b" : "n"}">${GLIFO[p]}${VS}</span>`;
      b.onclick = () => { $("dlgPromo").close(); ok(p); };
      cont.appendChild(b);
    }
    $("dlgPromo").onclose = () => ok(null);
    $("dlgPromo").showModal();
  });
}
function hacerJugada(m) {
  const r = est.juego.move(m);
  if (!r) return;
  est.ultima = r; est.sel = null; est.pista = null;
  guardarPartida();
  dibujarJuego();
  turnoMotorSiToca();
}
async function turnoMotorSiToca() {
  const g = est.juego;
  if (g.game_over() || g.turn() === est.color) return;
  const gen = ++est.generacion;
  est.pensando = true; dibujarJuego();
  const r = await obtenerMotor().buscar(g.fen(), NIVELES[est.nivel]);
  if (gen !== est.generacion) return; // se deshizo o cambió la partida mientras pensaba
  est.pensando = false;
  actualizarEval(r.cp, r.mate);
  if (r.mejor) {
    const mv = est.juego.move({ from: r.mejor.slice(0, 2), to: r.mejor.slice(2, 4), promotion: r.mejor[4] || "q" });
    if (mv) { est.ultima = mv; guardarPartida(); }
  }
  dibujarJuego();
  if ($("chkSiempre").checked) mostrarPista();
}
function actualizarEval(cp, mate, suf = "") {
  let pct = 50, txt = "";
  if (mate != null) { pct = mate > 0 ? 100 : 0; txt = `Mate en ${Math.abs(mate)} para las ${mate > 0 ? "blancas" : "negras"}`; }
  else if (cp != null) {
    pct = 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
    const v = (cp / 100).toFixed(1);
    txt = `Evaluación: ${cp > 0 ? "+" : ""}${v} ${Math.abs(cp) < 30 ? "(igualado)" : cp > 0 ? "(mejor blancas)" : "(mejor negras)"}`;
  }
  $("evalBlanco" + suf).style.height = pct + "%";
  $("evalTexto" + suf).textContent = txt;
}
$("chkSiempre").checked = leer("siempre", true);
$("chkSiempre").onchange = () => { guardar("siempre", $("chkSiempre").checked); if ($("chkSiempre").checked) mostrarPista(); };
$("btnPista").onclick = () => mostrarPista();
async function mostrarPista() {
  const g = est.juego;
  if (!g || g.game_over() || est.pensando || g.turn() !== est.color) return;
  const gen = est.generacion;
  $("btnPista").disabled = true; $("estado").textContent = "Buscando la mejor jugada…";
  const r = await obtenerMotor().buscar(g.fen(), { skill: 20, depth: 20, ms: 3000 });
  $("btnPista").disabled = false;
  if (gen !== est.generacion) return;
  est.pista = r.mejor; actualizarEval(r.cp, r.mate);
  dibujarJuego();
  if (r.mejor) {
    const san = new Chess(g.fen()).move({ from: r.mejor.slice(0, 2), to: r.mejor.slice(2, 4), promotion: r.mejor[4] || "q" });
    $("estado").textContent = san ? `💡 Mejor jugada: ${sanEs(san.san)} (${describirJugada(san)})` : `💡 Mejor jugada: ${r.mejor}`;
  }
}
$("btnDeshacer").onclick = () => {
  const g = est.juego;
  est.generacion++; est.pensando = false; est.pista = null; est.sel = null;
  g.undo();
  if (g.turn() !== est.color && g.history().length) g.undo(); // deshace también la respuesta del motor
  const h = g.history({ verbose: true }); est.ultima = h.length ? h[h.length - 1] : null;
  guardarPartida(); dibujarJuego();
  if (g.turn() === est.color) { if ($("chkSiempre").checked) mostrarPista(); } else turnoMotorSiToca();
};
$("btnGirar").onclick = () => { est.girado = !est.girado; dibujarJuego(); };
$("segColor").onclick = (e) => {
  const v = e.target.dataset.v; if (!v || v === est.color) return;
  est.color = v; est.girado = v === "b"; est.sel = null; est.pista = null; est.generacion++; est.pensando = false;
  guardarPartida(); dibujarJuego(); turnoMotorSiToca();
};
$("selNivel").onchange = () => { est.nivel = +$("selNivel").value; guardar("nivel", est.nivel); };
$("btnAnalizarJuego").onclick = () => { est.generacion++; est.pensando = false; abrirAnalisis(est.juego.fen()); };
$("btnEditar").onclick = () => { est.generacion++; est.pensando = false; abrirEditor(est.juego.fen()); };
$("btnNuevaFoto").onclick = () => { est.generacion++; est.pensando = false; $("inCamara").click(); };
async function copiar(t, boton) {
  try { await navigator.clipboard.writeText(t); const o = boton.textContent; boton.textContent = "¡Copiado!"; setTimeout(() => (boton.textContent = o), 1200); }
  catch { prompt("Copia el texto:", t); }
}
$("btnCopiarFen").onclick = (e) => copiar(est.juego.fen(), e.target);
$("btnCopiarPgn").onclick = (e) => copiar(est.juego.pgn(), e.target);

// ---------- arranque ----------
actualizarInicio();
mostrar("vInicio");
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
