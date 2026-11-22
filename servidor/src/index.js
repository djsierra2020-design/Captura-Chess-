// Servidor compartido de Captura Chess (Cloudflare Worker).
// Lee fotos de tableros con Claude Haiku usando la clave del dueño, para que otras personas
// puedan usar la app sin clave propia. Limita cuántas fotos se leen por persona y en total al día.
//
// Configuración (Cloudflare → Workers → captura-chess → Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY   (secreto, obligatorio) clave de console.anthropic.com
//   LIMITE_POR_PERSONA  fotos por persona al día (por defecto 20)
//   LIMITE_TOTAL        fotos en total al día (por defecto 300)
import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { INSTRUCCIONES, ESQUEMA } from "../../lectura.js";

const MODELO = "claude-haiku-5-5"; // otras personas: solo Haiku (el más barato)
const ORIGENES = ["https://djsierra2020-design.github.io"];
const TIPOS = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_BASE64 = 7_000_000; // ≈ 5 MB de imagen

/** Contadores diarios (uno solo para todo el servicio; las claves llevan la fecha). */
export class Limites extends DurableObject {
  /** Suma 1 si no se pasa de los límites. Devuelve {ok, motivo}. */
  async tomar(dia, persona, porPersona, total) {
    const kt = `${dia}|total`, kp = `${dia}|${persona}`;
    const [t, p] = [(await this.ctx.storage.get(kt)) || 0, (await this.ctx.storage.get(kp)) || 0];
    if (t >= total) return { ok: false, motivo: "total" };
    if (p >= porPersona) return { ok: false, motivo: "persona" };
    await this.ctx.storage.put({ [kt]: t + 1, [kp]: p + 1 });
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
    return { ok: true, quedan: porPersona - p - 1 };
  }
  /** Devuelve la foto al cupo si Claude falló (no fue culpa de la persona). */
  async devolver(dia, persona) {
    for (const k of [`${dia}|total`, `${dia}|${persona}`]) {
      const v = (await this.ctx.storage.get(k)) || 0;
      if (v > 0) await this.ctx.storage.put(k, v - 1);
    }
  }
  /** Una vez al día borra los contadores de días anteriores. */
  async alarm() {
    const hoy = new Date().toISOString().slice(0, 10);
    const viejas = [...(await this.ctx.storage.list()).keys()].filter((k) => !k.startsWith(hoy));
    if (viejas.length) await this.ctx.storage.delete(viejas);
    await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }
}

function cors(origen) {
  const permitido = ORIGENES.includes(origen) || /^http:\/\/localhost(:\d+)?$/.test(origen || "");
  return permitido ? {
    "Access-Control-Allow-Origin": origen,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  } : { Vary: "Origin" };
}
const responder = (datos, estado, h) =>
  new Response(JSON.stringify(datos), { status: estado, headers: { "Content-Type": "application/json; charset=utf-8", ...h } });

export default {
  async fetch(req, env) {
    const h = cors(req.headers.get("Origin"));
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (url.pathname === "/" && req.method === "GET") return responder({ servicio: "Captura Chess", ok: true }, 200, h);
    if (url.pathname !== "/leer" || req.method !== "POST") return responder({ error: "No encontrado." }, 404, h);
    if (!h["Access-Control-Allow-Origin"]) return responder({ error: "Origen no permitido." }, 403, h);
    if (!env.ANTHROPIC_API_KEY) return responder({ error: "El servicio no está configurado todavía." }, 503, h);

    let cuerpo;
    try { cuerpo = await req.json(); } catch { return responder({ error: "Petición inválida." }, 400, h); }
    const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(cuerpo?.imagen || ""));
    if (!m || !TIPOS.has(m[1])) return responder({ error: "No llegó una imagen válida." }, 400, h);
    if (m[2].length > MAX_BASE64) return responder({ error: "La imagen es muy grande." }, 413, h);

    // Límites diarios (por dirección de internet; día en hora UTC).
    const dia = new Date().toISOString().slice(0, 10);
    const persona = req.headers.get("CF-Connecting-IP") || "desconocida";
    const porPersona = +env.LIMITE_POR_PERSONA || 20, total = +env.LIMITE_TOTAL || 300;
    const limites = env.LIMITES.get(env.LIMITES.idFromName("global"));
    const cupo = await limites.tomar(dia, persona, porPersona, total);
    if (!cupo.ok) {
      return responder({
        error: cupo.motivo === "persona"
          ? `Llegaste al límite de ${porPersona} fotos por hoy. Mañana puedes seguir (o arma la posición a mano).`
          : "El servicio llegó a su límite de fotos por hoy. Mañana vuelve a funcionar (o arma la posición a mano).",
        limite: cupo.motivo,
      }, 429, h);
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2,
      ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
    try {
      const r = await client.messages.create({
        model: MODELO,
        max_tokens: 16000,
        output_config: { effort: "high", format: { type: "json_schema", schema: ESQUEMA } },
        system: INSTRUCCIONES,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
            { type: "text", text: "¿Cuál es la posición de este tablero?" },
          ],
        }],
      });
      if (r.stop_reason === "refusal") {
        await limites.devolver(dia, persona);
        return responder({ error: "No se pudo analizar esta imagen." }, 422, h);
      }
      const texto = r.content.find((b) => b.type === "text")?.text || "";
      let datos;
      try { datos = JSON.parse(texto); } catch {
        await limites.devolver(dia, persona);
        return responder({ error: "La respuesta llegó incompleta; intenta de nuevo." }, 502, h);
      }
      return responder({ ...datos, modelo: "Haiku", quedan: cupo.quedan }, 200, h);
    } catch (e) {
      await limites.devolver(dia, persona);
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        return responder({ error: "El servicio no está disponible (clave del servidor inválida)." }, 503, h);
      }
      if (e instanceof Anthropic.RateLimitError) {
        return responder({ error: "El servicio está saturado o sin saldo; intenta más tarde." }, 503, h);
      }
      if (e instanceof Anthropic.APIConnectionError) {
        return responder({ error: "El servidor no pudo conectarse con Claude; intenta de nuevo." }, 502, h);
      }
      if (e instanceof Anthropic.APIError) {
        return responder({ error: `Claude respondió con un error (${e.status ?? "?"}).` }, 502, h);
      }
      return responder({ error: "Error inesperado del servidor." }, 500, h);
    }
  },
};
