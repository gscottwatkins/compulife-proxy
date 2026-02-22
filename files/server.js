// ============================================================
// QUOTEIT API HUB — Railway Proxy Server v6.1
// Routes: Compulife | GHL (CRM) | Anthropic (OCR)
// Deploy: Railway with Static Egress IP
// Updated: Feb 21, 2026 — GHL Full Integration for Monday Launch
// ============================================================

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config ----
const AUTH_ID = process.env.COMPULIFE_AUTH_ID || "";
const REMOTE_IP = process.env.REMOTE_IP || "162.220.232.99";
const COMPULIFE_BASE = "https://www.compulifeapi.com/api";
const GHL_API_KEY = process.env.GHL_API_KEY || "";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "";
const GHL_BASE = "https://services.leadconnectorhq.com";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// ---- CORS ----
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : [
      "https://quoteitengine.com",
      "https://www.quoteitengine.com",
      "https://quoteit.insure",
      "https://www.quoteit.insure",
    ];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
    return callback(new Error("CORS: Origin " + origin + " not allowed"), false);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));

app.use(express.json({ limit: "10mb" }));

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "quoteit-api-hub",
    version: "6.1.0",
    timestamp: new Date().toISOString(),
    configured: { compulife: !!AUTH_ID, ghl: !!GHL_API_KEY, anthropic: !!ANTHROPIC_API_KEY },
    ghl_endpoints: [
      "POST   /ghl/contacts",
      "GET    /ghl/contacts/search?query=",
      "GET    /ghl/contacts/:id",
      "PUT    /ghl/contacts/:id",
      "POST   /ghl/contacts/:id/tags",
      "POST   /ghl/contacts/:id/notes",
      "POST   /ghl/contacts/:id/tasks",
      "POST   /ghl/conversations/messages",
      "GET    /ghl/conversations/:contactId",
      "GET    /ghl/conversations/:id/messages",
      "POST   /ghl/calendars/events",
      "GET    /ghl/calendars/events",
      "DELETE /ghl/calendars/events/:eventId",
      "GET    /ghl/calendars",
      "GET    /ghl/users",
      "GET    /ghl/pipelines",
      "POST   /ghl/opportunities",
      "PUT    /ghl/opportunities/:id",
      "POST   /ghl/phone/call",
    ],
  });
});

// ============================================================
// GHL HELPER
// ============================================================
async function ghlFetch(method, path, body = null) {
  const url = `${GHL_BASE}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
  };
  // Private Integration tokens (pit-) work with the same header format
  if (body && (method === "POST" || method === "PUT")) {
    opts.body = JSON.stringify(body);
  }
  console.log(`[GHL] ${method} ${path}`);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    console.error(`[GHL] ${res.status}: ${text.substring(0, 300)}`);
    return { error: true, status: res.status, message: data.message || data.msg || text.substring(0, 200), data };
  }
  return data;
}

// ============================================================
// GHL — CONTACTS
// ============================================================
app.post("/ghl/contacts", async (req, res) => {
  try {
    const result = await ghlFetch("POST", "/contacts/", { ...req.body, locationId: GHL_LOCATION_ID });
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/contacts/search", async (req, res) => {
  try {
    const q = req.query.query || req.query.q || "";
    const field = q.includes("@") ? "email" : "phone";
    const result = await ghlFetch("GET", `/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&${field}=${encodeURIComponent(q)}`);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/contacts/:id", async (req, res) => {
  try {
    const result = await ghlFetch("GET", `/contacts/${req.params.id}`);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.put("/ghl/contacts/:id", async (req, res) => {
  try {
    const result = await ghlFetch("PUT", `/contacts/${req.params.id}`, req.body);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.post("/ghl/contacts/:id/tags", async (req, res) => {
  try {
    const result = await ghlFetch("POST", `/contacts/${req.params.id}/tags`, req.body);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.post("/ghl/contacts/:id/notes", async (req, res) => {
  try {
    const result = await ghlFetch("POST", `/contacts/${req.params.id}/notes`, {
      body: req.body.body || req.body.note, userId: req.body.userId,
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.post("/ghl/contacts/:id/tasks", async (req, res) => {
  try {
    const result = await ghlFetch("POST", `/contacts/${req.params.id}/tasks`, req.body);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// GHL — CONVERSATIONS / MESSAGING
// ============================================================
app.get("/ghl/conversations/:contactId", async (req, res) => {
  try {
    const result = await ghlFetch("GET", `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${req.params.contactId}`);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/conversations/:conversationId/messages", async (req, res) => {
  try {
    const result = await ghlFetch("GET", `/conversations/${req.params.conversationId}/messages`);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// Send SMS, Email, or WhatsApp
app.post("/ghl/conversations/messages", async (req, res) => {
  try {
    const payload = {
      type: req.body.type || "SMS",
      contactId: req.body.contactId,
      message: req.body.message,
    };
    if (req.body.subject) payload.subject = req.body.subject;
    if (req.body.html) payload.html = req.body.html;
    if (req.body.emailFrom) payload.emailFrom = req.body.emailFrom;
    if (req.body.attachments) payload.attachments = req.body.attachments;
    const result = await ghlFetch("POST", "/conversations/messages", payload);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// GHL — CALENDAR / APPOINTMENTS
// ============================================================
app.get("/ghl/calendars", async (req, res) => {
  try {
    const result = await ghlFetch("GET", `/calendars/?locationId=${GHL_LOCATION_ID}`);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/calendars/events", async (req, res) => {
  try {
    const { calendarId, startTime, endTime } = req.query;
    let path = `/calendars/events?locationId=${GHL_LOCATION_ID}`;
    if (calendarId) path += `&calendarId=${calendarId}`;
    if (startTime) path += `&startTime=${encodeURIComponent(startTime)}`;
    if (endTime) path += `&endTime=${encodeURIComponent(endTime)}`;
    const result = await ghlFetch("GET", path);
    res.json(result);
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
    const result = await ghlFetch("POST", "/calendars/events", payload);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.delete("/ghl/calendars/events/:eventId", async (req, res) => {
  try {
    const result = await ghlFetch("DELETE", `/calendars/events/${req.params.eventId}`);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// GHL — PHONE (Click-to-Dial)
// ============================================================
app.post("/ghl/phone/call", async (req, res) => {
  try {
    const contactId = req.body.contactId;
    const phone = req.body.phone;

    let ghlResult = null;
    if (contactId) {
      ghlResult = await ghlFetch("POST", "/conversations/messages", {
        type: "Call",
        contactId: contactId,
        message: `Outbound call initiated to ${phone}`,
      });
    }

    res.json({
      success: true,
      action: "dial",
      phone: phone,
      contactId: contactId,
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
  try {
    const result = await ghlFetch("GET", `/users/?locationId=${GHL_LOCATION_ID}`);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/ghl/pipelines", async (req, res) => {
  try {
    const result = await ghlFetch("GET", `/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.post("/ghl/opportunities", async (req, res) => {
  try {
    const result = await ghlFetch("POST", "/opportunities/", { ...req.body, locationId: GHL_LOCATION_ID });
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.put("/ghl/opportunities/:id", async (req, res) => {
  try {
    const result = await ghlFetch("PUT", `/opportunities/${req.params.id}`, req.body);
    res.json(result);
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// COMPULIFE ROUTES
// ============================================================
app.post("/", async (req, res) => {
  try {
    const action = (req.body || {}).action || "ping";
    switch (action) {
      case "ping":
        return res.json({ status: "ok", service: "compulife-proxy", timestamp: new Date().toISOString() });
      case "get-categories":
        return res.json(await proxyPublic("/CategoryList"));
      case "get-companies":
        return res.json(await proxyPublic(`/CompanyList/${encodeURIComponent(req.body.category || "Life")}`));
      case "get-products": {
        if (!req.body.company) return res.status(400).json({ error: "company required" });
        return res.json(await proxyPublic(`/ProductList/${encodeURIComponent(req.body.company)}`));
      }
      case "quote-sidebyside":
      case "quote-compare":
        return res.json(await proxyPrivate("/sidebyside", buildCompulifeParams(req.body)));
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error("[Compulife]", e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

function buildCompulifeParams(body) {
  const params = {};
  const fields = [
    "Province","Sex","Smoker","Birthdate","FaceAmount","Premium","Mode",
    "TermPeriod","TableRating","InquiryType","ResultType","NumberOfCompanies",
    "Plan","DisplayFlags","DropCompanies","Alcohol","AlcoholYearsSinceTreatment",
    "Asthma","AsthmaRegularMedication","BloodPressure","BloodPressureMedication",
    "BPSystolic","BPDiastolic","Cancer","CancerType","CancerYearsSinceTreatment",
    "Cholesterol","CholesterolMedication","CholesterolReading","Diabetes",
    "DiabetesType","DiabetesA1CReading","HeartDisease","HeartType",
    "HeartYearsSinceTreatment","Depression","DepressionYearsSinceTreatment",
    "Drugs","DrugsYearsSinceTreatment","EmbeddedAccums","EmbeddedAccumColor","NoRedX",
  ];
  for (const k of fields) { if (body[k] !== undefined) params[k] = String(body[k]); }
  return params;
}

async function proxyPublic(path) {
  const url = `${COMPULIFE_BASE}${path}`;
  console.log(`[Compulife] PUBLIC → ${url}`);
  const r = await fetch(url);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}

async function proxyPrivate(path, params) {
  const payload = { COMPULIFEAUTHORIZATIONID: AUTH_ID, REMOTE_IP, ...params };
  const url = `${COMPULIFE_BASE}${path}/?COMPULIFE=${encodeURIComponent(JSON.stringify(payload))}`;
  console.log(`[Compulife] PRIVATE → ${COMPULIFE_BASE}${path}`);
  const r = await fetch(url);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}

// ============================================================
// ANTHROPIC — OCR for Lead Scanner Pro
// ============================================================
app.post("/anthropic", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
    const { image, media_type, prompt } = req.body;
    if (!image) return res.status(400).json({ error: "image (base64) required" });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2024-10-22",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media_type || "image/png", data: image } },
            { type: "text", text: prompt || "Extract all text from this lead card. Return JSON: first_name, last_name, address, city, state, zip, phone, age, dob, gender, tobacco, beneficiary, mortgage_amount, insurance_company, policy_type, vendor_source." },
          ],
        }],
      }),
    });

    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error("[Anthropic]", e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n✅ QuoteIt API Hub v6.1 running on port ${PORT}`);
  console.log(`   Compulife: ${AUTH_ID ? "✓ configured" : "✗ NOT SET"}`);
  console.log(`   GHL:       ${GHL_API_KEY ? "✓ configured" : "✗ NOT SET"}`);
  console.log(`   Anthropic: ${ANTHROPIC_API_KEY ? "✓ configured" : "✗ NOT SET"}`);
  console.log(`   Location:  ${GHL_LOCATION_ID || "NOT SET"}`);
  console.log(`   CORS:      ${ALLOWED_ORIGINS.join(", ")}\n`);
});
