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
function matrizAFen(m, turno) {
  const piezas = m.map((fila) => {
    let s = "", v = 0;
    for (const c of fila) { if (c) { if (v) { s += v; v = 0; } s += c; } else v++; }
    return s + (v || "");
  }).join("/");
  let enr = "";
  if (m[7][4] === "K") { if (m[7][7] === "R") enr += "K"; if (m[7][0] === "R") enr += "Q"; }
  if (m[0][4] === "k") { if (m[0][7] === "r") enr += "k"; if (m[0][0] === "r") enr += "q"; }
  return `${piezas} ${turno} ${enr || "-"} - 0 1`;
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
const VISTAS = ["vInicio", "vCargando", "vEditor", "vJugar"];
function mostrar(v) { VISTAS.forEach((x) => ($(x).hidden = x !== v)); window.scrollTo(0, 0); }

// ---------- motor Stockfish (Web Worker) ----------
const NIVELES = { // como los niveles 1-8 de Lichess, aproximado
  1: { skill: 0, depth: 1, ms: 80 },   2: { skill: 3, depth: 2, ms: 150 },
  3: { skill: 6, depth: 4, ms: 250 },  4: { skill: 9, depth: 6, ms: 400 },
  5: { skill: 12, depth: 8, ms: 700 }, 6: { skill: 15, depth: 11, ms: 1000 },
  7: { skill: 18, depth: 14, ms: 1500 }, 8: { skill: 20, depth: 20, ms: 2500 },
};
class Motor {
  constructor() {
    this.w = new Worker("vendor/stockfish.js");
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
      this.w.postMessage("ucinewgame");
      this.w.postMessage(`position fen ${fen}`);
      this.w.postMessage(`go depth ${depth} movetime ${ms}`);
    });
    const p = this.cola.then(tarea);
    this.cola = p.catch(() => {});
    return p;
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
  if (!clave) {
    abrirEditor(INICIAL, { notas: "Sin clave de Claude configurada: coloca las piezas mirando la foto (o pon la clave en Ajustes ⚙️)." });
    return;
  }
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
$("btnCancelarRec").onclick = () => { controlRec?.abort(); abrirEditor(INICIAL); };

// ---------- editor ----------
function abrirEditor(fen, { notas = "", esError = false, sinFoto = false, preguntarTurno = false } = {}) {
  if (sinFoto) est.foto = null;
  est.ed.m = fenAMatriz(fen);
  est.ed.turno = fen.split(" ")[1] || "w";
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
$("btnJugarDesde").onclick = () => {
  const fen = matrizAFen(est.ed.m, est.ed.turno);
  const p = problemaPosicion(fen);
  if (p) { $("errEditor").textContent = p; $("errEditor").hidden = false; return; }
  est.color = est.ed.turno; // por defecto juegas con el bando al que le toca
  empezarJuego(fen);
};

// ---------- juego ----------
function empezarJuego(fen, jugadas = []) {
  est.inicioFen = fen;
  est.juego = new Chess(fen);
  for (const j of jugadas) est.juego.move({ from: j.slice(0, 2), to: j.slice(2, 4), promotion: j[4] });
  est.sel = null; est.pista = null; est.generacion++;
  const hist = est.juego.history({ verbose: true });
  est.ultima = hist.length ? hist[hist.length - 1] : null;
  est.girado = est.color === "b";
  $("selNivel").value = String(est.nivel);
  actualizarEval(null, null);
  mostrar("vJugar");
  dibujarJuego();
  obtenerMotor();
  turnoMotorSiToca();
}
function guardarPartida() {
  guardar("partida", { inicio: est.inicioFen, color: est.color, jugadas: est.juego.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion || "")) });
}
function dibujarJuego() {
  const g = est.juego, clases = {};
  if (est.ultima) { clases[est.ultima.from] = "ultima"; clases[est.ultima.to] = "ultima"; }
  if (est.pista) { clases[est.pista.slice(0, 2)] = "pista"; clases[est.pista.slice(2, 4)] = "pista"; }
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
  $("estado").textContent = textoEstado();
  $("jugadas").textContent = g.pgn().replace(/^\[.*\]\s*$/gm, "").trim() || "(sin jugadas)";
  $("btnDeshacer").disabled = g.history().length === 0;
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
}
function actualizarEval(cp, mate) {
  let pct = 50, txt = "";
  if (mate != null) { pct = mate > 0 ? 100 : 0; txt = `Mate en ${Math.abs(mate)} para las ${mate > 0 ? "blancas" : "negras"}`; }
  else if (cp != null) {
    pct = 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
    const v = (cp / 100).toFixed(1);
    txt = `Evaluación: ${cp > 0 ? "+" : ""}${v} ${Math.abs(cp) < 30 ? "(igualado)" : cp > 0 ? "(mejor blancas)" : "(mejor negras)"}`;
  }
  $("evalBlanco").style.height = pct + "%";
  $("evalTexto").textContent = txt;
}
$("btnPista").onclick = async () => {
  const g = est.juego;
  if (g.game_over() || est.pensando || g.turn() !== est.color) return;
  const gen = est.generacion;
  $("btnPista").disabled = true; $("estado").textContent = "Buscando la mejor jugada…";
  const r = await obtenerMotor().buscar(g.fen(), NIVELES[8]);
  $("btnPista").disabled = false;
  if (gen !== est.generacion) return;
  est.pista = r.mejor; actualizarEval(r.cp, r.mate);
  dibujarJuego();
  if (r.mejor) {
    const san = new Chess(g.fen()).move({ from: r.mejor.slice(0, 2), to: r.mejor.slice(2, 4), promotion: r.mejor[4] || "q" });
    $("estado").textContent = `💡 Stockfish sugiere ${san ? san.san : r.mejor}.`;
  }
};
$("btnDeshacer").onclick = () => {
  const g = est.juego;
  est.generacion++; est.pensando = false; est.pista = null; est.sel = null;
  g.undo();
  if (g.turn() !== est.color && g.history().length) g.undo(); // deshace también la respuesta del motor
  const h = g.history({ verbose: true }); est.ultima = h.length ? h[h.length - 1] : null;
  guardarPartida(); dibujarJuego();
  turnoMotorSiToca();
};
$("btnGirar").onclick = () => { est.girado = !est.girado; dibujarJuego(); };
$("segColor").onclick = (e) => {
  const v = e.target.dataset.v; if (!v || v === est.color) return;
  est.color = v; est.girado = v === "b"; est.sel = null; est.pista = null; est.generacion++; est.pensando = false;
  guardarPartida(); dibujarJuego(); turnoMotorSiToca();
};
$("selNivel").onchange = () => { est.nivel = +$("selNivel").value; guardar("nivel", est.nivel); };
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
