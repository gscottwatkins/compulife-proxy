// ============================================================
// iAgentIQ API HUB — Railway Proxy Server v7.1.7
// Routes: Compulife | GHL (SMS+Email+CRM) | Anthropic | Google Drive | Vision
// Deploy: Railway with Static Egress IP (162.220.232.99)
// Updated: May 13, 2026 — Compulife proxy rewritten to match official API spec:
//   - REMOTE_IP passed per-request from caller headers (was: hardcoded server IP)
//   - Quote request stays on Compulife's documented COMPULIFE JSON endpoint
//   - Diagnostic endpoint /compulife/diag for sanity checks
//   - Telnyx + Postmark removed; SMS and Email both go via GHL now
// ============================================================

const express = require("express");
const cors = require("cors");

// ── CORS — single source of truth, function-based check is below at line ~67 ──

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", true);

// ---- Config ----
const AUTH_ID = process.env.COMPULIFE_AUTH_ID || "";
const SERVER_IP_FALLBACK = process.env.REMOTE_IP || "162.220.232.99";
const COMPULIFE_BASE = "https://www.compulifeapi.com/api";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// ---- SMS & Email ----
// As of May 2026: SMS and email both go through GHL (/ghl/conversations/messages).
// Telnyx + Postmark integrations were retired — DO NOT re-add them.

// Google Drive Config
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "";
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";
const GCP_VISION_API_KEY = process.env.GCP_VISION_API_KEY || "";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const LEAD_CARDS_BUCKET = process.env.SUPABASE_LEAD_CARDS_BUCKET || "lead-cards";

// ---- CORS (full origin list) ----
// Required production origins are always allowed. ALLOWED_ORIGINS may add
// extra origins in Railway, but it must never replace the engine/CRM defaults.
const REQUIRED_ALLOWED_ORIGINS = [
  "https://engine.iagentiq.com",
  "https://www.iagentiq.com",
  "https://app.iagentiq.com",
  "https://iagentiq-quote-engine.gscottwatkins.workers.dev",
  "https://quoteit.insure",
  "https://www.quoteit.insure",
  "https://quoteitengine.com",
  "https://www.quoteitengine.com",
];
const ENV_ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : [];
const ALLOWED_ORIGINS = Array.from(new Set([
  ...REQUIRED_ALLOWED_ORIGINS,
  ...ENV_ALLOWED_ORIGINS,
]));

app.use(cors({
  origin: function (origin, callback) {
    // Allow no-origin requests (curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    // Allow file:// pages — browser sends literal "null" string as Origin
    if (origin === "null") return callback(null, true);
    // Allow any localhost port (dev convenience)
    if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
      return callback(null, true);
    }
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
    return callback(new Error("CORS: Origin " + origin + " not allowed"), false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));

// Explicit preflight handler (mirrors the rules above)
app.options("*", cors({
  origin: function (origin, callback) {
    if (!origin || origin === "null") return callback(null, true);
    if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) return callback(null, true);
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
    return callback(new Error("CORS preflight: Origin " + origin + " not allowed"), false);
  },
}));

app.use(express.json({ limit: "35mb" }));

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "iagentiq-api-hub",
    version: "7.1.7",
    timestamp: new Date().toISOString(),
    configured: {
      compulife: !!AUTH_ID,
      anthropic: !!ANTHROPIC_API_KEY,
      googleDrive: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN),
      googleVision: !!GCP_VISION_API_KEY,
      supabaseStorage: !!(SUPABASE_URL && SUPABASE_SERVICE_KEY),
      ghl: !!GHL_API_KEY,
    },
    endpoints: [
      "POST   /compulife/quote",
      "POST   /compulife/sidebyside",
      "POST   /api/compulife/quotes",
      "GET    /compulife/diag",
      "GET    /compulife/categories",
      "GET    /compulife/companies",
      "GET    /compulife/states",
      "GET    /compulife/products",
      "POST   /ghl/conversations/messages   (SMS + email both go here)",
      "POST   /drive/upload",
      "POST   /vision/ocr",
      "POST   /anthropic",
      "POST   /ai/chat",
      "POST   /scan-lead",
      "POST   /lead-card/upload",
      "POST   /scoreboard/event",
      "POST   /production/entry",
      "GET    /production/entries",
      "PATCH  /production/entry/:id",
      "DELETE /production/entry/:id",
      "GET    /brochure-mappings",
      "GET    /scoreboard/live",
    ],
  });
});

// ============================================================
// LEAD CARD STORAGE — Supabase public bucket
// ============================================================
function safeStorageSegment(value, fallback = "lead") {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function extFromMime(mimeType, fileName = "") {
  const nameExt = String(fileName).toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1];
  if (nameExt) return nameExt === "jpeg" ? "jpg" : nameExt;
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/heic") return "heic";
  return "jpg";
}

app.post("/lead-card/upload", async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Supabase storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Railway.",
      });
    }

    const {
      fileName = "lead-card",
      mimeType = "application/octet-stream",
      base64 = "",
      firstName = "",
      lastName = "",
      phone = "",
      pageNum = "",
      totalPages = "",
      folder = "",
    } = req.body || {};

    if (!base64 || typeof base64 !== "string") {
      return res.status(400).json({ ok: false, error: "Missing base64 file content" });
    }

    const cleanBase64 = base64.includes(",") ? base64.split(",").pop() : base64;
    const buffer = Buffer.from(cleanBase64, "base64");
    if (!buffer.length) return res.status(400).json({ ok: false, error: "Empty decoded file" });

    const ext = extFromMime(mimeType, fileName);
    const today = new Date().toISOString().slice(0, 10);
    const namePart = safeStorageSegment(`${firstName}-${lastName}`.replace(/^-|-$/g, ""), "lead");
    const phonePart = safeStorageSegment(String(phone).replace(/\D/g, ""), "no-phone");
    const pagePart = pageNum ? `-p${safeStorageSegment(pageNum)}` : "";
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const folderPart = safeStorageSegment(folder || today, today);
    const objectPath = `${folderPart}/${namePart}-${phonePart}${pagePart}-${nonce}.${ext}`;

    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(LEAD_CARDS_BUCKET)}/${objectPath}`;
    const uploadResp = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "apikey": SUPABASE_SERVICE_KEY,
        "Content-Type": mimeType || "application/octet-stream",
        "x-upsert": "false",
      },
      body: buffer,
    });

    const uploadText = await uploadResp.text();
    if (!uploadResp.ok) {
      return res.status(uploadResp.status).json({
        ok: false,
        error: "Supabase upload failed",
        status: uploadResp.status,
        detail: uploadText.slice(0, 500),
      });
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(LEAD_CARDS_BUCKET)}/${objectPath}`;
    return res.json({
      ok: true,
      bucket: LEAD_CARDS_BUCKET,
      path: objectPath,
      url: publicUrl,
      mimeType,
      size: buffer.length,
      pageNum,
      totalPages,
    });
  } catch (e) {
    console.error("[LeadCard] upload error:", e);
    return res.status(500).json({ ok: false, error: e.message || "Lead card upload failed" });
  }
});

app.get("/lead-card/diag", (req, res) => {
  function decodeJwtPayload(token) {
    try {
      const parts = String(token || "").split(".");
      if (parts.length < 2) return null;
      const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
      return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
  const claims = decodeJwtPayload(SUPABASE_SERVICE_KEY);
  let host = "";
  try { host = new URL(SUPABASE_URL).host; } catch {}
  res.json({
    ok: true,
    supabaseUrlConfigured: !!SUPABASE_URL,
    supabaseHost: host,
    bucket: LEAD_CARDS_BUCKET,
    serviceKeyPresent: !!SUPABASE_SERVICE_KEY,
    serviceKeyLooksLikeJwt: String(SUPABASE_SERVICE_KEY || "").split(".").length >= 3,
    jwtRole: claims?.role || null,
    jwtIssuer: claims?.iss || null,
    jwtRef: claims?.ref || null,
    jwtExp: claims?.exp ? new Date(claims.exp * 1000).toISOString() : null,
  });
});

// ============================================================
// LIVE SCOREBOARD + PRODUCTION — Supabase REST
// ============================================================
function scoreboardPoints(type, amount = 0) {
  const base = {
    lead_scanned: 1,
    contact_created: 2,
    opportunity_created: 3,
    appointment_loaded: 3,
    quote_delivered: 5,
    disposition_thinking_about_it: 3,
    disposition_rescheduled: 3,
    disposition_no_show: 1,
    disposition_voicemail: 1,
    disposition_no_answer: 1,
    disposition_not_interested: 0,
    sale_submitted: 25,
    policy_issued: 30,
  }[type] ?? 0;
  const premiumBonus = type === "sale_submitted" ? Math.floor((Number(amount) || 0) / 1000) * 10 : 0;
  return base + premiumBonus;
}

async function supabaseRest(method, table, { body, query = "" } = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Supabase not configured");
  }
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ""}`;
  const headers = {
    "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
    "apikey": SUPABASE_SERVICE_KEY,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };
  const r = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = { raw: text.slice(0, 1000) }; }
  if (!r.ok) {
    const err = new Error(data?.message || data?.hint || text.slice(0, 200) || `Supabase ${r.status}`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

app.post("/scoreboard/event", async (req, res) => {
  try {
    const b = req.body || {};
    const event_type = String(b.event_type || b.type || "").trim();
    if (!event_type) return res.status(400).json({ ok: false, error: "event_type required" });
    const annualPremium = Number(b.annual_premium || b.premiumAnnual || b.amount || 0);
    const row = {
      event_type,
      agent_id: b.agent_id || b.agent || "",
      agent_name: b.agent_name || "",
      contact_id: b.contact_id || b.contactId || "",
      opportunity_id: b.opportunity_id || b.opportunityId || "",
      client_name: b.client_name || b.clientName || "",
      points: Number.isFinite(Number(b.points)) ? Number(b.points) : scoreboardPoints(event_type, annualPremium),
      metadata: b.metadata || {},
    };
    const inserted = await supabaseRest("POST", "scoreboard_events", { body: row });
    res.json({ ok: true, event: Array.isArray(inserted) ? inserted[0] : inserted });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.data || null });
  }
});

app.post("/production/entry", async (req, res) => {
  try {
    const b = req.body || {};
    const annualPremium = Number(b.annual_premium || b.premiumAnnual || 0);
    const commission = Number(b.commission_amount || b.commissionEst || 0);
    const row = {
      ghl_contact_id: b.ghl_contact_id || b.contact_id || b.contactId || "",
      ghl_opportunity_id: b.ghl_opportunity_id || b.opportunity_id || b.opportunityId || "",
      agent_id: b.agent_id || b.agent || "",
      agent_name: b.agent_name || "",
      client_name: b.client_name || b.client || "",
      carrier: b.carrier || "",
      product: b.product || "",
      coverage_amount: Number(b.coverage_amount || b.coverage || 0),
      annual_premium: annualPremium,
      monthly_premium: Number(b.monthly_premium || b.premiumMonthly || 0),
      commission_amount: commission,
      policy_status: b.policy_status || b.status || "pending",
      policy_number: b.policy_number || b.policyNum || "",
      sold_date: b.sold_date || b.date || new Date().toISOString().slice(0, 10),
      source: b.source || "engine",
      metadata: b.metadata || {},
    };
    const inserted = await supabaseRest("POST", "production_entries", { body: row });
    await supabaseRest("POST", "scoreboard_events", {
      body: {
        event_type: "sale_submitted",
        agent_id: row.agent_id,
        agent_name: row.agent_name,
        contact_id: row.ghl_contact_id,
        opportunity_id: row.ghl_opportunity_id,
        client_name: row.client_name,
        points: scoreboardPoints("sale_submitted", annualPremium),
        metadata: { annual_premium: annualPremium, carrier: row.carrier, product: row.product },
      },
    }).catch(() => {});
    res.json({ ok: true, entry: Array.isArray(inserted) ? inserted[0] : inserted });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.data || null });
  }
});

app.get("/production/entries", async (req, res) => {
  try {
    const params = new URLSearchParams({
      select: "*",
      order: "sold_date.desc,created_at.desc",
      limit: String(req.query.limit || 500),
    });
    if (req.query.since) params.set("sold_date", `gte.${req.query.since}`);
    const rows = await supabaseRest("GET", "production_entries", { query: params.toString() });
    res.json({ ok: true, entries: rows || [] });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.data || null });
  }
});

app.patch("/production/entry/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const b = req.body || {};
    const row = {};
    if ("date" in b || "sold_date" in b) row.sold_date = b.sold_date || b.date || null;
    if ("client" in b || "client_name" in b) row.client_name = b.client_name || b.client || "";
    if ("carrier" in b) row.carrier = b.carrier || "";
    if ("product" in b) row.product = b.product || "";
    if ("coverage" in b || "coverage_amount" in b) row.coverage_amount = Number(b.coverage_amount || b.coverage || 0);
    if ("premiumAnnual" in b || "annual_premium" in b) row.annual_premium = Number(b.annual_premium || b.premiumAnnual || 0);
    if ("premiumMonthly" in b || "monthly_premium" in b) row.monthly_premium = Number(b.monthly_premium || b.premiumMonthly || 0);
    if ("agent" in b || "agent_id" in b) row.agent_id = b.agent_id || b.agent || "";
    if ("agent_name" in b) row.agent_name = b.agent_name || "";
    if ("status" in b || "policy_status" in b) row.policy_status = b.policy_status || b.status || "pending";
    const updated = await supabaseRest("PATCH", "production_entries", {
      query: new URLSearchParams({ id: `eq.${id}` }).toString(),
      body: row,
    });
    res.json({ ok: true, entry: Array.isArray(updated) ? updated[0] : updated });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.data || null });
  }
});

app.delete("/production/entry/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const deleted = await supabaseRest("DELETE", "production_entries", {
      query: new URLSearchParams({ id: `eq.${id}` }).toString(),
    });
    res.json({ ok: true, entry: Array.isArray(deleted) ? deleted[0] : deleted });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.data || null });
  }
});

app.get("/brochure-mappings", async (req, res) => {
  try {
    const params = new URLSearchParams({
      select: "*",
      active: "eq.true",
      order: "brochure_type.asc,carrier.asc,product_name.asc",
      limit: String(req.query.limit || 500),
    });
    if (req.query.plan_type) params.set("plan_type", `eq.${req.query.plan_type}`);
    const rows = await supabaseRest("GET", "brochure_mappings", { query: params.toString() });
    res.json({ ok: true, mappings: rows || [] });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.data || null });
  }
});

function startForPeriod(period) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "week") start.setDate(start.getDate() - start.getDay());
  if (period === "month") start.setDate(1);
  if (period === "year") { start.setMonth(0, 1); }
  return start.toISOString();
}

app.get("/scoreboard/live", async (req, res) => {
  try {
    const period = ["day", "week", "month", "year"].includes(req.query.period) ? req.query.period : "day";
    const since = req.query.since || startForPeriod(period);
    const eventQuery = new URLSearchParams({
      select: "*",
      created_at: `gte.${since}`,
      order: "created_at.desc",
      limit: String(req.query.limit || 500),
    }).toString();
    const prodQuery = new URLSearchParams({
      select: "*",
      created_at: `gte.${since}`,
      order: "created_at.desc",
      limit: String(req.query.limit || 500),
    }).toString();
    const [events, production] = await Promise.all([
      supabaseRest("GET", "scoreboard_events", { query: eventQuery }),
      supabaseRest("GET", "production_entries", { query: prodQuery }),
    ]);
    const agents = {};
    for (const ev of events || []) {
      const id = ev.agent_id || "unknown";
      agents[id] ||= { agent_id: id, agent_name: ev.agent_name || id, points: 0, events: 0, sales: 0, annual_premium: 0, commission: 0 };
      agents[id].points += Number(ev.points || 0);
      agents[id].events += 1;
    }
    for (const p of production || []) {
      const id = p.agent_id || "unknown";
      agents[id] ||= { agent_id: id, agent_name: p.agent_name || id, points: 0, events: 0, sales: 0, annual_premium: 0, commission: 0 };
      agents[id].sales += 1;
      agents[id].annual_premium += Number(p.annual_premium || 0);
      agents[id].commission += Number(p.commission_amount || 0);
    }
    const leaderboard = Object.values(agents).sort((a, b) => (b.points - a.points) || (b.annual_premium - a.annual_premium) || (b.sales - a.sales));
    const awards = [];
    if (leaderboard[0]) awards.push({ type: "top_points", label: "Points leader", agent_name: leaderboard[0].agent_name, value: leaderboard[0].points });
    const topPremium = [...leaderboard].sort((a,b)=>b.annual_premium-a.annual_premium)[0];
    if (topPremium && topPremium.annual_premium > 0) awards.push({ type: "top_premium", label: "Premium leader", agent_name: topPremium.agent_name, value: topPremium.annual_premium });
    res.json({ ok: true, period, since, leaderboard, events, production, awards });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.data || null });
  }
});

// ============================================================
// COMPULIFE — CORRECTED IMPLEMENTATION (v7.1)
// ============================================================
//
// Per official docs at docs.compulife.com (verified May 13, 2026):
//
//   POST https://www.compulifeapi.com/api/request/?COMPULIFEAUTHORIZATIONID={ID}&REMOTE_IP={USER_IP}
//   Content-Type: multipart/form-data
//   Body: each quote field (State, BirthMonth, Sex, Health, NewCategory, etc.)
//         as its own multipart form field, values quoted as strings.
//
// Compulife validates the subscriber connection by source IP, while REMOTE_IP
// is the end-user/browser IP used for per-user scraping controls. Railway's
// outbound source IP still needs to be whitelisted, but REMOTE_IP should be the
// caller where available.
// ============================================================

// Helper — build a multipart/form-data body from a plain object.
// Node 18+ has native FormData; this works on Railway's default runtime.
function buildFormData(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    // Compulife expects empty string for unused optional fields (not omitted)
    form.append(key, value === undefined || value === null ? "" : String(value));
  }
  return form;
}

// The canonical 19 quote fields per Compulife docs (May 2026).
// Anything not in this list is dropped — protects against the engine accidentally
// sending stale field names (gender, tobacco, NumberOfCompanies, action, etc.).
const COMPULIFE_QUOTE_FIELDS = [
  "State", "ZipCode",
  "BirthMonth", "Birthday", "BirthDay", "BirthYear",
  "ActualAge", "NearestAge",
  "Sex", "Smoker", "Health",
  "NewCategory", "FaceAmount", "ModeUsed",
  "SortOverride1", "CompRating", "LANGUAGE", "ErrOnMissingZipCode",
  "COMPINC", "PRODDIS", "NumberOfCompanies", "MaxNumResults",
  // Health Analyzer additions (optional, only used when DoHeightWeight=ON)
  "DoHeightWeight", "Feet", "Inches", "Weight", "DoSmokingTobacco",
];

// Field-name aliasing — accept common legacy/incorrect names from the engine
// and translate them to the documented names. This lets us keep older engine
// code working while we migrate to the correct field names everywhere.
const FIELD_ALIASES = {
  gender: "Sex",
  tobacco: "Smoker",
  category: "NewCategory",
  face: "FaceAmount",
  mode: "ModeUsed",
  BirthDay: "Birthday",
};

function normalizeQuoteFields(body) {
  const out = {};
  // Apply aliases first so e.g. body.gender → body.Sex
  for (const [from, to] of Object.entries(FIELD_ALIASES)) {
    if (body[from] !== undefined && body[to] === undefined) {
      out[to] = body[from];
    }
  }
  // Then copy through canonical fields (overriding any alias values if both present)
  for (const k of COMPULIFE_QUOTE_FIELDS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  if (out.Birthday !== undefined && out.BirthDay === undefined) out.BirthDay = out.Birthday;
  if (out.BirthDay !== undefined && out.Birthday === undefined) out.Birthday = out.BirthDay;
  // Normalize Smoker: accept Y/N (canonical), S/N (legacy), or boolean
  if (out.Smoker !== undefined) {
    const v = String(out.Smoker).toUpperCase();
    if (v === "S" || v === "Y" || v === "TRUE" || v === "1") out.Smoker = "Y";
    else out.Smoker = "N";
  }
  // Normalize Sex
  if (out.Sex !== undefined) {
    const v = String(out.Sex).toUpperCase();
    out.Sex = v.startsWith("F") ? "F" : "M";
  }
  return out;
}

function cleanIpCandidate(value) {
  let ip = String(value || "").trim();
  if (!ip || /^unknown$/i.test(ip) || /^localhost$/i.test(ip)) return "";
  ip = ip.replace(/^::ffff:/, "");
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, "");
  return ip;
}

function isPublicIp(ip) {
  ip = cleanIpCandidate(ip);
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some(x => x < 0 || x > 255)) return false;
    const [a, b] = n;
    if (a === 10 || a === 127 || a === 0 || a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  const lower = ip.toLowerCase();
  if (!lower.includes(":")) return false;
  if (lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return false;
  return true;
}

function maskIp(ip) {
  ip = cleanIpCandidate(ip);
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.xxx.xxx.${parts[3]}`;
  if (ip.includes(":")) return `${ip.slice(0, 4)}:xxxx:${ip.slice(-4)}`;
  return "";
}

function firstPublicIpFromHeader(value) {
  return String(value || "")
    .split(",")
    .map(cleanIpCandidate)
    .find(isPublicIp) || "";
}

function firstPublicIpFromForwarded(value) {
  const parts = String(value || "").split(/[;,]/);
  for (const part of parts) {
    const match = part.match(/\bfor="?([^";,\s]+)"?/i);
    if (match) {
      const ip = cleanIpCandidate(match[1]);
      if (isPublicIp(ip)) return ip;
    }
  }
  return "";
}

function resolveCompulifeRemoteIpInfo(req) {
  if (process.env.NODE_ENV === "development") {
    const devIp = cleanIpCandidate(process.env.DEV_REMOTE_IP || "");
    if (isPublicIp(devIp)) return { ip: devIp, source: "DEV_REMOTE_IP" };
  }
  const candidates = [
    ["x-forwarded-for", firstPublicIpFromHeader(req.headers["x-forwarded-for"])],
    ["x-real-ip", cleanIpCandidate(req.headers["x-real-ip"])],
    ["cf-connecting-ip", cleanIpCandidate(req.headers["cf-connecting-ip"])],
    ["true-client-ip", cleanIpCandidate(req.headers["true-client-ip"])],
    ["x-client-ip", cleanIpCandidate(req.headers["x-client-ip"])],
    ["forwarded", firstPublicIpFromForwarded(req.headers.forwarded)],
    ["req.ips", Array.isArray(req.ips) ? req.ips.map(cleanIpCandidate).find(isPublicIp) : ""],
    ["req.ip", cleanIpCandidate(req.ip)],
    ["socket.remoteAddress", cleanIpCandidate(req.socket?.remoteAddress)],
  ];
  const winner = candidates.find(([, ip]) => isPublicIp(ip));
  return winner ? { ip: winner[1], source: winner[0] } : { ip: "", source: "none" };
}

function resolveCompulifeRemoteIp(req) {
  return resolveCompulifeRemoteIpInfo(req).ip;
}

const COMPULIFE_QUOTE_CACHE_TTL_MS = 10 * 60 * 1000;
const compulifeQuoteCache = new Map();
const compulifeInFlight = new Map();

function stableJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(Object.keys(value).sort().reduce((out, key) => {
    out[key] = value[key];
    return out;
  }, {}));
}

function quoteCacheKey(endpoint, fields) {
  return `${endpoint}:${stableJson(fields)}`;
}

function sanitizedQuoteLog(fields) {
  return {
    state: fields.State,
    birthYear: fields.BirthYear,
    birthMonth: fields.BirthMonth,
    sex: fields.Sex,
    smoker: fields.Smoker,
    health: fields.Health,
    newCategory: fields.NewCategory,
    faceAmount: fields.FaceAmount,
    modeUsed: fields.ModeUsed,
    compincCount: String(fields.COMPINC || "").split(",").filter(Boolean).length || 0,
  };
}

function parseCompulifeJson(text, status) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const raw = text.substring(0, 400);
    return {
      error: true,
      status,
      raw,
      parseError: e.message,
      blocked: /scraping|blocked|forbidden|denied/i.test(raw),
      message: /scraping|blocked|forbidden|denied|user.?limit/i.test(raw)
        ? "Compulife temporarily blocked this quote request because of user access limits. Try again later or verify REMOTE_IP is being passed correctly."
        : "Compulife returned a non-JSON response.",
    };
  }
}

function flattenCompulifeRows(data, out = []) {
  if (!data || typeof data !== "object") return out;
  if (Array.isArray(data)) {
    data.forEach(item => flattenCompulifeRows(item, out));
    return out;
  }
  const looksLikeQuoteRow = data.Compulife_company || data.Compulife_Company_Name ||
    data.CompanyName || data.company || data.ProductName || data.Compulife_product ||
    data.prodmonthly || data.Compulife_premiumM || data.Monthly || data.MonthlyPremium;
  if (looksLikeQuoteRow) out.push(data);
  Object.values(data).forEach(value => {
    if (value && typeof value === "object") flattenCompulifeRows(value, out);
  });
  return out;
}

function normalizeCompulifeQuotes(data) {
  return flattenCompulifeRows(data).map(row => {
    const monthly = row.prodmonthly || row.Compulife_premiumM || row.Monthly || row.MonthlyPremium || row.monthly || "";
    const annual = row.prodannual || row.Compulife_premiumA || row.Annual || row.AnnualPremium || row.annual || "";
    return {
      carrier: row.Compulife_company || row.Compulife_Company_Name || row.CompanyName || row.company || "",
      product: row.Compulife_product || row.ProductName || row.product || "",
      planType: row.NewCategory || row.Category || "",
      term: row.TermPeriod || row.term || null,
      faceAmount: row.FaceAmount || row.faceAmount || null,
      healthClass: row.Health || row.healthClass || "",
      tobacco: String(row.Smoker || row.smoker || "").toUpperCase() === "Y" || String(row.Smoker || row.smoker || "").toUpperCase() === "S",
      monthlyPremium: Number(String(monthly).replace(/[^0-9.]/g, "")) || null,
      annualPremium: Number(String(annual).replace(/[^0-9.]/g, "")) || null,
      rawCarrierName: row.Compulife_company || row.Compulife_Company_Name || row.CompanyName || "",
      rawProductName: row.Compulife_product || row.ProductName || "",
      source: "Compulife",
    };
  });
}

// The private quote call.
//   userIp:  the END USER'S browser IP resolved from forwarded request headers.
//   fields:  the normalized quote fields for Compulife's COMPULIFE JSON payload.
async function callCompulifeQuote(userIp, fields, endpoint = "/request") {
  if (!AUTH_ID) {
    throw new Error("COMPULIFE_AUTH_ID env var not set on Railway");
  }
  const remoteIp = userIp;
  if (!remoteIp || !isPublicIp(remoteIp)) {
    return {
      error: true,
      status: 400,
      message: "Unable to determine a valid public REMOTE_IP for Compulife.",
      remoteIpIncluded: false,
    };
  }
  const fullPayload = {
    COMPULIFEAUTHORIZATIONID: AUTH_ID,
    REMOTE_IP: remoteIp,
    ...fields,
  };
  const cacheKey = quoteCacheKey(endpoint, Object.assign({ _remoteIp: remoteIp }, fields));
  const cached = compulifeQuoteCache.get(cacheKey);
  if (cached && Date.now() - cached.at < COMPULIFE_QUOTE_CACHE_TTL_MS) {
    console.log("[Compulife] cache hit", { endpoint, remoteIpIncluded: true, remoteIpMasked: maskIp(remoteIp), ...sanitizedQuoteLog(fields) });
    return cached.data;
  }
  if (compulifeInFlight.has(cacheKey)) {
    console.log("[Compulife] joined in-flight request", { endpoint, remoteIpIncluded: true, remoteIpMasked: maskIp(remoteIp), ...sanitizedQuoteLog(fields) });
    return compulifeInFlight.get(cacheKey);
  }

  const started = Date.now();
  const requestPromise = (async () => {
    const url = `${COMPULIFE_BASE}${endpoint}/?COMPULIFE=${encodeURIComponent(JSON.stringify(fullPayload))}`;
    console.log("[Compulife] quote request", {
      endpoint,
      remoteIpIncluded: true,
      remoteIpMasked: maskIp(remoteIp),
      ...sanitizedQuoteLog(fields),
    });
    const r = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "iAgentIQ Compulife API Proxy",
      },
    });
    const text = await r.text();
    const parsed = parseCompulifeJson(text, r.status);
    const durationMs = Date.now() - started;
    console.log("[Compulife] quote response", {
      endpoint,
      status: r.status,
      durationMs,
      blocked: !!parsed.blocked,
      error: !!parsed.error,
      errorMessage: parsed.error ? parsed.message : undefined,
      cache: false,
    });
    if (parsed.blocked && !parsed.status) parsed.status = 429;
    if (!parsed.error) {
      compulifeQuoteCache.set(cacheKey, { at: Date.now(), data: parsed });
    }
    return parsed;
  })();

  compulifeInFlight.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    compulifeInFlight.delete(cacheKey);
  }
}

// Public (no-auth-needed-in-body) GETs — CategoryList, StateList, CompanyList, etc.
// These still need the auth ID as a query parameter on the URL.
async function callCompulifePublic(endpoint) {
  if (!AUTH_ID) throw new Error("COMPULIFE_AUTH_ID env var not set on Railway");
  const sep = endpoint.includes("?") ? "&" : "?";
  const url = `${COMPULIFE_BASE}${endpoint}${sep}COMPULIFEAUTHORIZATIONID=${encodeURIComponent(AUTH_ID)}`;
  console.log(`[Compulife] GET ${endpoint}`);
  const r = await fetch(url);
  const t = await r.text();
  try { return JSON.parse(t); }
  catch { return { raw: t, status: r.status }; }
}

// ─── PRIMARY QUOTE ENDPOINT ───
// The engine calls this with quote fields in the body; the proxy resolves
// REMOTE_IP from forwarded request headers before calling Compulife.
app.post("/compulife/quote", async (req, res) => {
  try {
    const userIp = resolveCompulifeRemoteIp(req);
    const fields = normalizeQuoteFields(req.body);

    // Basic validation — fail fast with a useful message instead of letting
    // Compulife return a vague error.
    const required = ["State", "BirthMonth", "Birthday", "BirthYear", "Sex", "Smoker", "Health", "NewCategory", "FaceAmount", "ModeUsed"];
    const missing = required.filter(k => fields[k] === undefined || fields[k] === "");
    if (missing.length) {
      return res.status(400).json({
        error: true,
        message: `Missing required Compulife fields: ${missing.join(", ")}`,
        received_keys: Object.keys(req.body),
      });
    }

    const result = await callCompulifeQuote(userIp, fields, "/request");
    return res.json(result);
  } catch (e) {
    console.error("[Compulife/quote] Error:", e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

// ─── SIDE-BY-SIDE COMPARISON ENDPOINT ───
// Compulife's pre-formatted spreadsheet-style endpoint. Same field shape.
app.post("/compulife/sidebyside", async (req, res) => {
  try {
    const userIp = resolveCompulifeRemoteIp(req);
    const fields = normalizeQuoteFields(req.body);
    const result = await callCompulifeQuote(userIp, fields, "/sidebyside");
    return res.json(result);
  } catch (e) {
    console.error("[Compulife/sidebyside] Error:", e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

// ─── NORMALIZED API ENDPOINT FOR ENGINE/FUTURE CLIENTS ───
app.post("/api/compulife/quotes", async (req, res) => {
  try {
    const userIp = resolveCompulifeRemoteIp(req);
    const fields = normalizeQuoteFields(req.body);
    const required = ["State", "BirthMonth", "Birthday", "BirthYear", "Sex", "Smoker", "Health", "NewCategory", "FaceAmount", "ModeUsed"];
    const missing = required.filter(k => fields[k] === undefined || fields[k] === "");
    if (missing.length) {
      return res.status(400).json({ error: true, message: `Missing required Compulife fields: ${missing.join(", ")}` });
    }
    const endpoint = req.body?.requestType === "request" ? "/request" : "/sidebyside";
    const raw = await callCompulifeQuote(userIp, fields, endpoint);
    if (raw?.error) return res.status(raw.blocked ? 429 : 502).json(raw);
    return res.json({ quotes: normalizeCompulifeQuotes(raw), raw, source: "Compulife" });
  } catch (e) {
    console.error("[Compulife/api/quotes] Error:", e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});


// ─── REFERENCE LOOKUPS (cache these on engine boot) ───
app.get("/compulife/categories", async (req, res) => {
  try { res.json(await callCompulifePublic("/CategoryList")); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/compulife/companies", async (req, res) => {
  try { res.json(await callCompulifePublic("/CompanyList")); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/compulife/states", async (req, res) => {
  try { res.json(await callCompulifePublic("/StateList")); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/compulife/products", async (req, res) => {
  try {
    const compinc = req.query.compinc ? `?COMPINC=${encodeURIComponent(req.query.compinc)}` : "";
    res.json(await callCompulifePublic(`/CompanyProductList${compinc}`));
  }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ─── DIAGNOSTIC ENDPOINT ───
// Calls Compulife's /api/ip endpoint to verify our outbound IP matches what
// they have whitelisted, and reports the configured state of the proxy.
app.get("/compulife/diag", async (req, res) => {
  try {
    const remoteIpInfo = resolveCompulifeRemoteIpInfo(req);
    const out = {
      proxy_version: "7.1.7",
      auth_id_set: !!AUTH_ID,
      server_ip_configured: SERVER_IP_FALLBACK,
      caller_ip_seen_masked: maskIp(remoteIpInfo.ip || req.ip || "?"),
      remote_ip_would_send: maskIp(remoteIpInfo.ip),
      remote_ip_included: !!remoteIpInfo.ip,
      remote_ip_source: remoteIpInfo.source,
      header_presence: {
        x_forwarded_for: !!req.headers["x-forwarded-for"],
        x_real_ip: !!req.headers["x-real-ip"],
        cf_connecting_ip: !!req.headers["cf-connecting-ip"],
        true_client_ip: !!req.headers["true-client-ip"],
        x_client_ip: !!req.headers["x-client-ip"],
        forwarded: !!req.headers.forwarded,
      },
      compulife_sees_us_as: null,
      whitelist_match: null,
      timestamp: new Date().toISOString(),
    };
    // Ask Compulife what IP they see us coming from
    try {
      const r = await fetch(`${COMPULIFE_BASE}/ip/`);
      const data = await r.json();
      out.compulife_sees_us_as = data.IPADDRESS || data.ipaddress || JSON.stringify(data);
      out.whitelist_match = (out.compulife_sees_us_as === SERVER_IP_FALLBACK);
    } catch (e) {
      out.compulife_sees_us_as = "ERROR: " + e.message;
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

// ─── LEGACY COMPATIBILITY: POST / with action: "..." ───
// The current engine code posts to the proxy root with an action field
// (e.g. action: "quote-sidebyside"). Preserve that contract so we don't
// break the live engine while we update the engine-side call shape.
app.post("/", async (req, res) => {
  try {
    const action = (req.body || {}).action || "ping";
    const userIp = resolveCompulifeRemoteIp(req);
    switch (action) {
      case "ping":
        return res.json({ status: "ok", service: "compulife-proxy", timestamp: new Date().toISOString() });
      case "get-categories":
        return res.json(await callCompulifePublic("/CategoryList"));
      case "get-companies":
        return res.json(await callCompulifePublic("/CompanyList"));
      case "get-products": {
        const compinc = req.body.company ? `?COMPINC=${encodeURIComponent(req.body.company)}` : "";
        return res.json(await callCompulifePublic(`/CompanyProductList${compinc}`));
      }
      case "quote-sidebyside":
      case "quote-compare":
      case "quote": {
        const fields = normalizeQuoteFields(req.body);
        const endpoint = action === "quote-sidebyside" ? "/sidebyside" : "/request";
        const result = await callCompulifeQuote(userIp, fields, endpoint);
        if (result?.error) return res.status(result.blocked ? 429 : (result.status || 502)).json(result);
        return res.json(result);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error("[Compulife/legacy]", e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

// ============================================================
// PHONE NORMALIZE HELPER
// ============================================================
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  if (digits.length > 10) return "+" + digits;
  return null;
}

// ============================================================
// GOOGLE DRIVE HELPER
// ============================================================
let cachedAccessToken = null;
let tokenExpiresAt = 0;

async function getGoogleAccessToken() {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }
  console.log("[Drive] Refreshing access token...");
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    console.error("[Drive] Token refresh failed:", data);
    throw new Error(`Failed to refresh Google token: ${data.error_description || data.error || "unknown"}`);
  }
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  return cachedAccessToken;
}

async function findOrCreateFolder(accessToken, folderName, parentId) {
  const query = `name='${folderName.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;
  const searchResp = await fetch(searchUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const searchData = await searchResp.json();
  if (searchData.files && searchData.files.length > 0) return searchData.files[0].id;
  const createResp = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  const createData = await createResp.json();
  if (!createResp.ok) throw new Error(`Failed to create folder: ${createData.error?.message || "unknown"}`);
  return createData.id;
}

// ============================================================
// GOOGLE DRIVE — FILE UPLOAD
// ============================================================
app.post("/drive/upload", async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
      return res.status(500).json({ error: true, message: "Google Drive not configured" });
    }
    const { fileData, fileName, mimeType, vendorFolder } = req.body;
    if (!fileData) return res.status(400).json({ error: true, message: "fileData (base64) required" });
    const accessToken = await getGoogleAccessToken();
    let parentFolderId = GOOGLE_DRIVE_FOLDER_ID;
    if (!parentFolderId) parentFolderId = await findOrCreateFolder(accessToken, "Lead Scanner Pro", "root");
    let targetFolderId = parentFolderId;
    if (vendorFolder) targetFolderId = await findOrCreateFolder(accessToken, vendorFolder, parentFolderId);
    const boundary = "lead_scanner_boundary_" + Date.now();
    const metadata = JSON.stringify({ name: fileName || `lead_${Date.now()}.pdf`, parents: [targetFolderId] });
    const fileBuffer = Buffer.from(fileData, "base64");
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${metadata}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${mimeType || "application/pdf"}\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n`
      ),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const uploadResp = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
          "Content-Length": multipartBody.length,
        },
        body: multipartBody,
      }
    );
    const uploadData = await uploadResp.json();
    if (!uploadResp.ok) return res.status(uploadResp.status).json({ error: true, message: uploadData.error?.message || "Upload failed" });
    await fetch(`https://www.googleapis.com/drive/v3/files/${uploadData.id}/permissions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });
    res.json({
      success: true,
      fileId: uploadData.id,
      fileName: uploadData.name,
      webViewLink: uploadData.webViewLink,
      webContentLink: uploadData.webContentLink,
      driveUrl: `https://drive.google.com/file/d/${uploadData.id}/view`,
    });
  } catch (e) {
    console.error("[Drive] Error:", e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

// ============================================================
// GOOGLE VISION — OCR
// ============================================================
app.post("/vision/ocr", async (req, res) => {
  try {
    const GCP_API_KEY = process.env.GCP_VISION_API_KEY || "";
    if (!GCP_API_KEY) return res.status(500).json({ error: true, message: "GCP_VISION_API_KEY not configured" });
    const { imageData } = req.body;
    if (!imageData) return res.status(400).json({ error: true, message: "imageData (base64) required" });
    const url = `https://vision.googleapis.com/v1/images:annotate?key=${GCP_API_KEY}`;
    const body = {
      requests: [{
        image: { content: imageData },
        features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
        imageContext: { languageHints: ["en"] },
      }],
    };
    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: true, message: result.error?.message || "Vision API error" });
    const annotation = result.responses?.[0];
    if (annotation?.error) return res.status(400).json({ error: true, message: annotation.error.message });
    const fullText = annotation?.fullTextAnnotation?.text || "";
    const pages = annotation?.fullTextAnnotation?.pages || [];
    let totalConf = 0, wordCount = 0;
    for (const page of pages) {
      for (const block of (page.blocks || [])) {
        for (const para of (block.paragraphs || [])) {
          for (const word of (para.words || [])) {
            if (word.confidence !== undefined) { totalConf += word.confidence; wordCount++; }
          }
        }
      }
    }
    const avgConfidence = wordCount > 0 ? Math.round((totalConf / wordCount) * 100) : null;
    res.json({ success: true, fullText, confidence: avgConfidence, wordCount });
  } catch (e) {
    console.error("[Vision] Error:", e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

// ============================================================
// GHL — CONFIG + FETCH HELPER
// ============================================================
const GHL_API_KEY = process.env.GHL_API_KEY || "";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "tOhI6SGWSB1guLHKIIqX";
const GHL_BASE_URL = "https://services.leadconnectorhq.com";

async function ghlFetch(method, path, body) {
  const url = GHL_BASE_URL + path;
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${GHL_API_KEY}`,
      "Content-Type": "application/json",
      "Version": "2021-07-28"
    }
  };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); }
  catch (e) { data = { error: true, raw: text.substring(0, 1000) }; }
  return {
    _ok: r.ok,
    _status: r.status,
    _path: path,
    ...data,
  };
}

// ============================================================
// GHL — CONTACTS
// ============================================================
app.post("/ghl/contacts", async (req, res) => {
  try {
    const result = await ghlFetch("POST", "/contacts/", { ...req.body, locationId: GHL_LOCATION_ID });
    res.status(result._ok ? 200 : result._status || 502).json(result);
  }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/contacts/search", async (req, res) => {
  try {
    const q = req.query.query || req.query.q || "";
    if (q.match(/^\d/) || q.includes("@")) {
      const field = q.includes("@") ? "email" : "phone";
      res.json(await ghlFetch("GET", `/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&${field}=${encodeURIComponent(q)}`));
    } else {
      res.json(await ghlFetch("GET", `/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(q)}&limit=10`));
    }
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/contacts/:id", async (req, res) => {
  try { res.json(await ghlFetch("GET", `/contacts/${req.params.id}`)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.put("/ghl/contacts/:id", async (req, res) => {
  try { res.json(await ghlFetch("PUT", `/contacts/${req.params.id}`, req.body)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.post("/ghl/contacts/:id/tags", async (req, res) => {
  try { res.json(await ghlFetch("POST", `/contacts/${req.params.id}/tags`, req.body)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.post("/ghl/contacts/:id/notes", async (req, res) => {
  try { res.json(await ghlFetch("POST", `/contacts/${req.params.id}/notes`, { body: req.body.body || req.body.note, userId: req.body.userId })); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.post("/ghl/contacts/:id/tasks", async (req, res) => {
  try { res.json(await ghlFetch("POST", `/contacts/${req.params.id}/tasks`, req.body)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// GHL — CUSTOM FIELDS
// ============================================================
app.get("/ghl/custom-fields", async (req, res) => {
  try { res.json(await ghlFetch("GET", `/locations/${GHL_LOCATION_ID}/customFields`)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.post("/ghl/custom-fields", async (req, res) => {
  try { res.json(await ghlFetch("POST", `/locations/${GHL_LOCATION_ID}/customFields`, { ...req.body, model: req.body.model || "contact" })); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/custom-fields/:id", async (req, res) => {
  try { res.json(await ghlFetch("GET", `/locations/${GHL_LOCATION_ID}/customFields/${req.params.id}`)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// GHL — CONVERSATIONS / MESSAGING
// ============================================================
app.get("/ghl/conversations/:contactId", async (req, res) => {
  try { res.json(await ghlFetch("GET", `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${req.params.contactId}`)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/conversations/:conversationId/messages", async (req, res) => {
  try { res.json(await ghlFetch("GET", `/conversations/${req.params.conversationId}/messages`)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.post("/ghl/conversations/messages", async (req, res) => {
  try {
    const payload = { type: req.body.type || "SMS", contactId: req.body.contactId, message: req.body.message };
    if (req.body.subject) payload.subject = req.body.subject;
    if (req.body.html) payload.html = req.body.html;
    if (!payload.html && req.body.templatePreviewUrl) {
      const previewUrl = new URL(String(req.body.templatePreviewUrl));
      if (previewUrl.hostname !== "firebasestorage.googleapis.com" || !previewUrl.pathname.includes("/highlevel-backend.appspot.com/")) {
        return res.status(400).json({ error: true, message: "Unsupported email template preview URL" });
      }
      const templateResp = await fetch(previewUrl.toString(), { headers: { "Accept": "text/html" } });
      const templateHtml = await templateResp.text();
      if (!templateResp.ok || !templateHtml || /<Error>|NoSuchKey|AccessDenied/i.test(templateHtml.slice(0, 500))) {
        return res.status(502).json({
          error: true,
          message: `Unable to fetch GHL email template preview (${templateResp.status})`,
          templateId: req.body.templateId || "",
          templateName: req.body.templateName || "",
        });
      }
      payload.html = templateHtml;
    }
    if (req.body.emailFrom) payload.emailFrom = req.body.emailFrom;
    if (req.body.attachments) payload.attachments = req.body.attachments;
    res.json(await ghlFetch("POST", "/conversations/messages", payload));
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// GHL — EMAIL TEMPLATES
// ============================================================
app.get("/ghl/email-templates", async (req, res) => {
  try {
    const params = new URLSearchParams();
    params.set("locationId", GHL_LOCATION_ID);
    if (req.query.limit) params.set("limit", req.query.limit);
    if (req.query.skip) params.set("skip", req.query.skip);
    if (req.query.offset) params.set("offset", req.query.offset);
    if (req.query.search) params.set("search", req.query.search);
    const result = await ghlFetch("GET", `/emails/builder?${params.toString()}`);
    res.status(result._ok ? 200 : result._status || 502).json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.post("/ghl/email-templates", async (req, res) => {
  try {
    const name = req.body.name || req.body.title || "iAgentIQ Email Template";
    const subject = req.body.subject || "";
    const previewText = req.body.previewText || "";
    const html = req.body.html || req.body.editorContent || "";
    if (!html) return res.status(400).json({ error: true, message: "html/editorContent is required" });

    // GHL's email builder API has evolved. Try the current simplified editor
    // payload first, then fall back to the older HTML fields if the location
    // still expects the legacy shape.
    const attempts = [
      {
        locationId: GHL_LOCATION_ID,
        name,
        title: name,
        editorType: "html",
        editorContent: html,
        subject,
        previewText,
      },
      {
        locationId: GHL_LOCATION_ID,
        name,
        title: name,
        type: "html",
        html,
        subject,
        previewText,
        isPlainText: false,
      },
      {
        locationId: GHL_LOCATION_ID,
        templateName: name,
        name,
        subject,
        html,
        type: "html",
        isPlainText: false,
      },
    ];

    const results = [];
    for (const payload of attempts) {
      const result = await ghlFetch("POST", "/emails/builder", payload);
      results.push(result);
      if (result._ok) return res.status(200).json({ success: true, attempt: results.length, result });
    }

    res.status(results[0]?._status || 502).json({ error: true, message: "All GHL email-template create attempts failed", results });
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/email-templates/:templateId", async (req, res) => {
  try {
    const result = await ghlFetch("GET", `/emails/builder/${req.params.templateId}?locationId=${GHL_LOCATION_ID}`);
    res.status(result._ok ? 200 : result._status || 502).json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.patch("/ghl/email-templates/:templateId", async (req, res) => {
  try {
    const payload = { ...req.body };
    if (payload.html && !payload.editorContent) {
      payload.editorType = payload.editorType || "html";
      payload.editorContent = payload.html;
      delete payload.html;
    }
    const result = await ghlFetch("PATCH", `/emails/builder/${req.params.templateId}`, payload);
    res.status(result._ok ? 200 : result._status || 502).json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// GHL — CALENDAR / APPOINTMENTS
// ============================================================
app.get("/ghl/calendars", async (req, res) => {
  try { res.json(await ghlFetch("GET", `/calendars/?locationId=${GHL_LOCATION_ID}`)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/calendars/events", async (req, res) => {
  try {
    const { calendarId, startTime, endTime } = req.query;
    let path = `/calendars/events?locationId=${GHL_LOCATION_ID}`;
    if (calendarId) path += `&calendarId=${calendarId}`;
    if (startTime) path += `&startTime=${encodeURIComponent(startTime)}`;
    if (endTime) path += `&endTime=${encodeURIComponent(endTime)}`;
    res.json(await ghlFetch("GET", path));
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.post("/ghl/calendars/events", async (req, res) => {
  try {
    const payload = {
      locationId: GHL_LOCATION_ID,
      calendarId: req.body.calendarId,
      contactId: req.body.contactId,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      title: req.body.title || "Insurance Appointment",
      appointmentStatus: req.body.appointmentStatus || "new",
      assignedUserId: req.body.assignedUserId || req.body.closerId,
      notes: req.body.notes || "",
    };
    res.json(await ghlFetch("POST", "/calendars/events", payload));
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.delete("/ghl/calendars/events/:eventId", async (req, res) => {
  try { res.json(await ghlFetch("DELETE", `/calendars/events/${req.params.eventId}`)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// GHL — PHONE
// ============================================================
app.post("/ghl/phone/call", async (req, res) => {
  try {
    const contactId = req.body.contactId;
    const phone = req.body.phone;
    let ghlResult = null;
    if (contactId) {
      ghlResult = await ghlFetch("POST", "/conversations/messages", {
        type: "Call", contactId: contactId, message: `Outbound call initiated to ${phone}`,
      });
    }
    res.json({
      success: true, action: "dial", phone: phone, contactId: contactId,
      telUri: `tel:${phone.replace(/[^+\d]/g, "")}`,
      ghlLog: ghlResult,
      note: "Frontend should open tel: URI or GHL softphone widget",
    });
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// GHL — USERS / PIPELINES / OPPORTUNITIES
// ============================================================
app.get("/ghl/users", async (req, res) => {
  try { res.json(await ghlFetch("GET", `/users/?locationId=${GHL_LOCATION_ID}`)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/pipelines", async (req, res) => {
  try { res.json(await ghlFetch("GET", `/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/workflows", async (req, res) => {
  try { res.json(await ghlFetch("GET", `/workflows/?locationId=${GHL_LOCATION_ID}`)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.post("/ghl/opportunities", async (req, res) => {
  try {
    const result = await ghlFetch("POST", "/opportunities/", { ...req.body, locationId: GHL_LOCATION_ID });
    res.status(result._ok ? 200 : result._status || 502).json(result);
  }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/opportunities/search", async (req, res) => {
  try {
    const params = new URLSearchParams();
    params.set("location_id", GHL_LOCATION_ID);
    if (req.query.contact_id || req.query.contactId) params.set("contact_id", req.query.contact_id || req.query.contactId);
    if (req.query.pipeline_id || req.query.pipelineId) params.set("pipeline_id", req.query.pipeline_id || req.query.pipelineId);
    if (req.query.pipeline_stage_id || req.query.pipelineStageId) params.set("pipeline_stage_id", req.query.pipeline_stage_id || req.query.pipelineStageId);
    if (req.query.status) params.set("status", req.query.status);
    if (req.query.query) params.set("query", req.query.query);
    if (req.query.limit) params.set("limit", req.query.limit);
    const result = await ghlFetch("GET", `/opportunities/search?${params.toString()}`);
    res.status(result._ok ? 200 : result._status || 502).json(result);
  }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.put("/ghl/opportunities/:id", async (req, res) => {
  try { res.json(await ghlFetch("PUT", `/opportunities/${req.params.id}`, req.body)); }
  catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// ANTHROPIC — passthrough for OCR + AI Chat
// ============================================================
app.post("/anthropic", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
    const isPassthrough = req.body.model && req.body.messages;
    let body;
    if (isPassthrough) {
      body = JSON.stringify(req.body);
    } else {
      const { image, media_type, prompt } = req.body;
      if (!image) return res.status(400).json({ error: "image (base64) required" });
      body = JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media_type || "image/png", data: image } },
            { type: "text", text: prompt || "Extract all text from this lead card. Return JSON." },
          ],
        }],
      });
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = { error: true, raw: text.substring(0, 200) }; }
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    console.error("[Anthropic]", e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

app.post("/ai/chat", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "AI proxy error", detail: "ANTHROPIC_API_KEY not configured" });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(req.body),
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch (e) { data = { error: "Invalid JSON from Anthropic", detail: raw.slice(0, 200) }; }
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    console.error("[AI Chat Proxy] Error:", err.message);
    res.status(500).json({ error: "AI proxy error", detail: err.message });
  }
});

// ============================================================
// SCAN LEAD — IQ Scanner Pro (multi-page)
// ============================================================
app.post('/scan-lead', async (req, res) => {
  const { file, mediaType, files } = req.body;
  if (!file && (!files || !files.length)) return res.status(400).json({ error: 'No file provided' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const imageBlocks = [];
    if (files && files.length) {
      files.forEach(f => {
        imageBlocks.push({
          type: f.mediaType === 'application/pdf' ? 'document' : 'image',
          source: { type: 'base64', media_type: f.mediaType, data: f.data }
        });
      });
    } else {
      imageBlocks.push({
        type: mediaType === 'application/pdf' ? 'document' : 'image',
        source: { type: 'base64', media_type: mediaType, data: file }
      });
    }
    imageBlocks.push({
      type: 'text',
      text: 'This PDF contains multiple mortgage protection insurance lead cards, one per page or section. Extract ALL leads and return ONLY a JSON array where each element has these keys (empty string if not found): {"firstName":"","lastName":"","phone":"","email":"","dob":"MM/DD/YYYY","address":"","city":"","state":"2-letter","zip":"","mortgageAmount":"numbers only","lender":"","leadSource":"","coBorrowerFirstName":"","coBorrowerLastName":"","coBorrowerDob":"","tobaccoUse":"yes or no","gender":"Male or Female","coBorrowerGender":"Male or Female","monthlyPayment":"numbers only"}. IMPORTANT: gender is the PRIMARY BORROWER\'s gender only. coBorrowerGender is the co-borrower\'s gender only. Do not mix them up. Return ONLY the JSON array, no markdown, no backticks, no explanation. Example: [{"firstName":"John",...},{"firstName":"Jane",...}]'
    });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 8000, messages: [{ role: 'user', content: imageBlocks }] })
    });
    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Anthropic API error: ' + response.status });
    }
    const data = await response.json();
    const raw = (data.content && data.content[0] && data.content[0].text || '').trim();
    let result;
    try { result = JSON.parse(raw); }
    catch (e) {
      const arrMatch = raw.match(/\[[\s\S]*/);
      if (arrMatch) {
        let partial = arrMatch[0];
        const lastClose = partial.lastIndexOf('}');
        if (lastClose > 0) partial = partial.substring(0, lastClose + 1) + ']';
        try { result = JSON.parse(partial); } catch (e2) { result = []; }
      } else {
        const objMatch = raw.match(/\{[\s\S]*\}/);
        result = objMatch ? JSON.parse(objMatch[0]) : [];
      }
    }
    const leads = Array.isArray(result) ? result : [result];
    res.json({ leads, lead: leads[0] || {} });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Scan failed' });
  }
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n✅ iAgentIQ API Hub v7.1.7 running on port ${PORT}`);
  console.log(`   Compulife:  ${AUTH_ID ? "✓ configured" : "✗ NOT SET"}`);
  console.log(`   Server IP:  ${SERVER_IP_FALLBACK}`);
  console.log(`   Anthropic:  ${ANTHROPIC_API_KEY ? "✓ configured" : "✗ NOT SET"}`);
  console.log(`   GHL:        ${GHL_API_KEY ? "✓ configured (SMS + Email both via /ghl/conversations/messages)" : "✗ NOT SET"}`);
  console.log(`   Drive:      ${GOOGLE_REFRESH_TOKEN ? "✓ configured" : "✗ NOT SET"}`);
  console.log(`   Vision:     ${GCP_VISION_API_KEY ? "✓ configured" : "✗ NOT SET"}`);
  console.log(`   CORS:       ${ALLOWED_ORIGINS.join(", ")}\n`);
});
