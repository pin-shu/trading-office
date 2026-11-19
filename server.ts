// Trading Office — live 3D isometric office for 澍 (TingHe)'s AI trading team (paper trading only).
// Bun runtime. HTML is read from public/index.html at startup and served at /.
const HTML: string = await Bun.file(new URL("./public/index.html", import.meta.url)).text();

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="10" y="8" width="44" height="50" rx="8" fill="#2f3540"/><g fill="#9fd3bd"><rect x="17" y="15" width="9" height="7" rx="2"/><rect x="28" y="15" width="9" height="7" rx="2"/><rect x="39" y="15" width="8" height="7" rx="2"/><rect x="17" y="26" width="9" height="7" rx="2"/><rect x="28" y="26" width="9" height="7" rx="2"/><rect x="39" y="26" width="8" height="7" rx="2"/><rect x="17" y="37" width="9" height="7" rx="2"/><rect x="39" y="37" width="8" height="7" rx="2"/></g><rect x="27" y="44" width="10" height="14" rx="2" fill="#f6c453"/></svg>`;
const TOKEN = (Bun.env.OFFICE_TOKEN || "").trim();
const MAX_EVENTS = 200;
const ACTIONS = ["working", "idle", "walk_to", "handoff"] as const;
type Action = (typeof ACTIONS)[number];

const AGENTS: Record<string, { name: string; role: string; initial: string }> = {
  commander: { name: "Commander 總指揮", role: "協調、Bull vs Bear 辯論、提案或 NO TRADE", initial: "待命中" },
  crypto: { name: "Crypto Analyst", role: "加密貨幣分析", initial: "待命中" },
  stock: { name: "Stock Analyst", role: "台股與美股分析", initial: "待命中" },
  risk: { name: "Risk & Audit", role: "風控、模擬執行、績效稽核", initial: "待命中" },
  grokbot: { name: "Grok Bot 前台", role: "轉達設定與問題、迷因幣監控", initial: "迷因幣監控暫停中" },
  tinghe: { name: "澍 辦公室", role: "唯一核准提案、修改風控參數", initial: "待命中" },
  lily: { name: "莉莉 影音導演", role: "影音導演：企劃、分鏡與剪輯《萌寵亂劇場》", initial: "待命中" },
  shorts: { name: "Shorts 營運", role: "YouTube Shorts 營運：SEO、標題縮圖、上片排程", initial: "待命中" },
};
// Grok Bot agent ids accepted as aliases for the office agent keys.
const ALIASES: Record<string, string> = {
  "shu": "tinghe",
  "澍": "tinghe",
  "d2c4c88f-884a-4f7f-9b99-cec057ac6ac4": "lily",
  "0cc6b57c-6579-4e4c-9633-42946c7ac6a7": "shorts",
};
const agentKey = (v: string) => ALIASES[v] || v;

type AgentState = { id: string; name: string; role: string; status: string; action: Action; to: string | null; updated: string | null };
type Ev = { id: number; ts: string; agent: string; action: Action; to: string | null; status: string; message: string };

const agents: Record<string, AgentState> = {};
for (const [id, a] of Object.entries(AGENTS)) agents[id] = { id, name: a.name, role: a.role, status: a.initial, action: "idle", to: null, updated: null };
const events: Ev[] = [];
let seq = 0;

const STATE_FILE = Bun.env.STATE_FILE || "";
if (STATE_FILE) {
  try {
    const f = Bun.file(STATE_FILE);
    if (await f.exists()) {
      const s = await f.json();
      if (s?.agents) for (const id of Object.keys(agents)) if (s.agents[id]) Object.assign(agents[id], s.agents[id], { id, name: AGENTS[id].name, role: AGENTS[id].role });
      if (Array.isArray(s?.events)) events.push(...s.events.slice(-MAX_EVENTS));
      seq = events.reduce((m, e) => Math.max(m, e.id || 0), 0);
    }
  } catch (e) { console.error("state load failed", e); }
}
async function persist() {
  if (!STATE_FILE) return;
  try { await Bun.write(STATE_FILE, JSON.stringify({ agents, events })); } catch (e) { console.error("persist failed", e); }
}

const snapshot = () => ({ agents, events, serverTime: new Date().toISOString() });
const enc = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
function sseWrite(c: ReadableStreamDefaultController<Uint8Array>, chunk: string) {
  try { c.enqueue(enc.encode(chunk)); return true; } catch { clients.delete(c); return false; }
}
function broadcast(name: string, data: unknown) {
  const chunk = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of [...clients]) sseWrite(c, chunk);
}

function timingSafeEq(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function handlePost(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const tok = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!TOKEN || !timingSafeEq(tok, TOKEN)) return json({ error: "unauthorized" }, 401);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const agent = agentKey(str(body?.agent, 64).toLowerCase());
  if (!AGENTS[agent]) return json({ error: "unknown agent", allowed: Object.keys(AGENTS) }, 400);
  const action = (str(body?.action, 16) || "working") as Action;
  if (!ACTIONS.includes(action)) return json({ error: "invalid action", allowed: ACTIONS }, 400);
  let to: string | null = agentKey(str(body?.to, 64).toLowerCase()) || null;
  if (to && !AGENTS[to]) return json({ error: "unknown target agent", allowed: Object.keys(AGENTS) }, 400);
  if (to === agent) return json({ error: "to must differ from agent" }, 400);
  if ((action === "walk_to" || action === "handoff") && !to) return json({ error: `${action} requires 'to'` }, 400);
  if (action !== "walk_to" && action !== "handoff") to = null;
  const message = str(body?.message, 240);
  const status = str(body?.status, 120) || message;
  if (!message && !status) return json({ error: "message or status required" }, 400);

  const ev: Ev = { id: ++seq, ts: new Date().toISOString(), agent, action, to, status, message: message || status };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  Object.assign(agents[agent], { status, action, to, updated: ev.ts });
  broadcast("event", { event: ev, agent: agents[agent] });
  persist();
  return json({ ok: true, event: ev });
}

function sse(req: Request) {
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  let hb: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => { if (hb) clearInterval(hb); clients.delete(ctrl); };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      clients.add(c);
      sseWrite(c, `retry: 3000\nevent: init\ndata: ${JSON.stringify(snapshot())}\n\n`);
      hb = setInterval(() => { if (!sseWrite(c, `: ping ${Date.now()}\n\n`)) cleanup(); }, 15000);
    },
    cancel() { cleanup(); },
  });
  req.signal?.addEventListener("abort", cleanup);
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}

const server = Bun.serve({
  port: Number(Bun.env.PORT || 3000),
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "GET" && (p === "/" || p === "/index.html"))
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    if (req.method === "GET" && (p === "/favicon.svg" || p === "/favicon.ico"))
      return new Response(FAVICON, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
    if (req.method === "GET" && p === "/events/stream") return sse(req);
    if (req.method === "GET" && p === "/api/state") return json(snapshot());
    if (req.method === "GET" && p === "/health") return json({ ok: true, clients: clients.size, events: events.length, auth: TOKEN ? "configured" : "missing" });
    if (p === "/api/event") {
      if (req.method === "POST") return handlePost(req);
      return json({ error: "method not allowed" }, 405);
    }
    return json({ error: "not found" }, 404);
  },
});
console.log(`trading-office listening on :${server.port} (token ${TOKEN ? "configured" : "MISSING — POSTs rejected"})`);
