// ============================================================
// QUOTEIT API HUB — Railway Proxy Server v7.1
// Routes: Compulife | GHL (CRM) | Anthropic (AI) | Supabase | Google Drive
// Deploy: Railway with Static Egress IP
// Updated: Feb 24, 2026 — Fixed Compulife parameter whitelist
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

// Supabase Config
const SUPABASE_URL = process.env.SUPABASE_URL || "https://bclpztdoneomugvrdxnb.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "lead-images";

// Google Drive Config
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "";
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";
const GCP_VISION_API_KEY = process.env.GCP_VISION_API_KEY || "";

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
    version: "7.2.0",
    timestamp: new Date().toISOString(),
    configured: {
      compulife: !!AUTH_ID,
      ghl: !!GHL_API_KEY,
      anthropic: !!ANTHROPIC_API_KEY,
      supabase: !!SUPABASE_SERVICE_KEY,
      googleDrive: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN),
      googleVision: !!GCP_VISION_API_KEY,
    },
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
  const searchResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
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
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return res.status(500).json({ error: true, message: "Google Drive not configured" });
    const { fileData, fileName, mimeType, vendorFolder } = req.body;
    if (!fileData) return res.status(400).json({ error: true, message: "fileData (base64) required" });
    const accessToken = await getGoogleAccessToken();
    let parentFolderId = GOOGLE_DRIVE_FOLDER_ID || await findOrCreateFolder(accessToken, "Lead Scanner Pro", "root");
    let targetFolderId = vendorFolder ? await findOrCreateFolder(accessToken, vendorFolder, parentFolderId) : parentFolderId;
    const boundary = "lead_scanner_boundary_" + Date.now();
    const metadata = JSON.stringify({ name: fileName || `lead_${Date.now()}.pdf`, parents: [targetFolderId] });
    const fileBuffer = Buffer.from(fileData, "base64");
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType || "application/pdf"}\r\nContent-Transfer-Encoding: base64\r\n\r\n`),
      fileBuffer, Buffer.from(`\r\n--${boundary}--`),
    ]);
    const uploadResp = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink", {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}`, "Content-Length": multipartBody.length }, body: multipartBody,
    });
    const uploadData = await uploadResp.json();
    if (!uploadResp.ok) return res.status(uploadResp.status).json({ error: true, message: uploadData.error?.message || "Upload failed" });
    await fetch(`https://www.googleapis.com/drive/v3/files/${uploadData.id}/permissions`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });
    res.json({ success: true, fileId: uploadData.id, fileName: uploadData.name, webViewLink: uploadData.webViewLink, driveUrl: `https://drive.google.com/file/d/${uploadData.id}/view` });
  } catch (e) { console.error("[Drive] Error:", e.message); res.status(500).json({ error: true, message: e.message }); }
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
    const resp = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${GCP_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ image: { content: imageData }, features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }], imageContext: { languageHints: ["en"] } }] }),
    });
    const result = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: true, message: result.error?.message || "Vision API error" });
    const annotation = result.responses?.[0];
    if (annotation?.error) return res.status(400).json({ error: true, message: annotation.error.message });
    const fullText = annotation?.fullTextAnnotation?.text || "";
    const pages = annotation?.fullTextAnnotation?.pages || [];
    let totalConf = 0, wordCount = 0;
    for (const page of pages) for (const block of (page.blocks || [])) for (const para of (block.paragraphs || [])) for (const word of (para.words || [])) if (word.confidence !== undefined) { totalConf += word.confidence; wordCount++; }
    res.json({ success: true, fullText, confidence: wordCount > 0 ? Math.round((totalConf / wordCount) * 100) : null, wordCount });
  } catch (e) { console.error("[Vision] Error:", e.message); res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// GHL — CONTACTS
// ============================================================
app.post("/ghl/contacts", async (req, res) => { try { res.json(await ghlFetch("POST", "/contacts/", { ...req.body, locationId: GHL_LOCATION_ID })); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.get("/ghl/contacts/search", async (req, res) => { try { const q = req.query.query || req.query.q || ""; res.json(await ghlFetch("GET", `/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(q)}&limit=${req.query.limit || 20}`)); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.get("/ghl/contacts/:id", async (req, res) => { try { res.json(await ghlFetch("GET", `/contacts/${req.params.id}`)); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.put("/ghl/contacts/:id", async (req, res) => { try { res.json(await ghlFetch("PUT", `/contacts/${req.params.id}`, req.body)); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.post("/ghl/contacts/:id/tags", async (req, res) => { try { res.json(await ghlFetch("POST", `/contacts/${req.params.id}/tags`, req.body)); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.post("/ghl/contacts/:id/notes", async (req, res) => { try { res.json(await ghlFetch("POST", `/contacts/${req.params.id}/notes`, { body: req.body.body || req.body.note, userId: req.body.userId })); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.post("/ghl/contacts/:id/tasks", async (req, res) => { try { res.json(await ghlFetch("POST", `/contacts/${req.params.id}/tasks`, req.body)); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });

// ============================================================
// GHL — CONVERSATIONS / MESSAGING
// ============================================================
app.get("/ghl/conversations/:contactId", async (req, res) => { try { res.json(await ghlFetch("GET", `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${req.params.contactId}`)); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.get("/ghl/conversations/:conversationId/messages", async (req, res) => { try { res.json(await ghlFetch("GET", `/conversations/${req.params.conversationId}/messages`)); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.post("/ghl/conversations/messages", async (req, res) => {
  try {
    const payload = { type: req.body.type || "SMS", contactId: req.body.contactId, message: req.body.message };
    if (req.body.subject) payload.subject = req.body.subject;
    if (req.body.html) payload.html = req.body.html;
    if (req.body.emailFrom) payload.emailFrom = req.body.emailFrom;
    if (req.body.attachments) payload.attachments = req.body.attachments;
    res.json(await ghlFetch("POST", "/conversations/messages", payload));
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// GHL — CALENDAR / APPOINTMENTS
// ============================================================
app.get("/ghl/calendars", async (req, res) => { try { res.json(await ghlFetch("GET", `/calendars/?locationId=${GHL_LOCATION_ID}`)); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.get("/ghl/calendars/events", async (req, res) => { try { let path = `/calendars/events?locationId=${GHL_LOCATION_ID}`; if (req.query.calendarId) path += `&calendarId=${req.query.calendarId}`; if (req.query.startTime) path += `&startTime=${encodeURIComponent(req.query.startTime)}`; if (req.query.endTime) path += `&endTime=${encodeURIComponent(req.query.endTime)}`; res.json(await ghlFetch("GET", path)); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.post("/ghl/calendars/events", async (req, res) => { try { res.json(await ghlFetch("POST", "/calendars/events", { locationId: GHL_LOCATION_ID, calendarId: req.body.calendarId, contactId: req.body.contactId, startTime: req.body.startTime, endTime: req.body.endTime, title: req.body.title || "Insurance Appointment", appointmentStatus: req.body.appointmentStatus || "new", assignedUserId: req.body.assignedUserId || req.body.closerId, notes: req.body.notes || "" })); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.delete("/ghl/calendars/events/:eventId", async (req, res) => { try { res.json(await ghlFetch("DELETE", `/calendars/events/${req.params.eventId}`)); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });

// ============================================================
// GHL — PHONE / USERS / PIPELINES / OPPORTUNITIES
// ============================================================
app.post("/ghl/phone/call", async (req, res) => { try { let ghlResult = null; if (req.body.contactId) ghlResult = await ghlFetch("POST", "/conversations/messages", { type: "Call", contactId: req.body.contactId, message: `Outbound call initiated to ${req.body.phone}` }); res.json({ success: true, action: "dial", phone: req.body.phone, contactId: req.body.contactId, telUri: `tel:${(req.body.phone||"").replace(/[^+\d]/g, "")}`, ghlLog: ghlResult }); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.get("/ghl/users", async (req, res) => { try { res.json(await ghlFetch("GET", `/users/?locationId=${GHL_LOCATION_ID}`)); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.get("/ghl/pipelines", async (req, res) => { try { res.json(await ghlFetch("GET", `/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`)); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.post("/ghl/opportunities", async (req, res) => { try { res.json(await ghlFetch("POST", "/opportunities/", { ...req.body, locationId: GHL_LOCATION_ID })); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });
app.put("/ghl/opportunities/:id", async (req, res) => { try { res.json(await ghlFetch("PUT", `/opportunities/${req.params.id}`, req.body)); } catch (e) { res.status(500).json({ error: true, message: e.message }); } });

// ============================================================
// COMPULIFE ROUTES — Fixed parameter passthrough
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
      case "get-products":
        if (!req.body.company) return res.status(400).json({ error: "company required" });
        return res.json(await proxyPublic(`/ProductList/${encodeURIComponent(req.body.company)}`));
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
  // COMPLETE whitelist — includes both Compulife API field names
  // Working fields (proven Feb 15): State, BirthMonth, Birthday, BirthYear, Sex, Smoker, Health, NewCategory, FaceAmount, ModeUsed
  const fields = [
    // Core quote fields (working format)
    "State","BirthMonth","Birthday","BirthYear","Sex","Smoker","Health",
    "NewCategory","FaceAmount","ModeUsed",
    // Legacy field names (kept for compatibility)
    "Province","Birthdate","Premium","Mode","TermPeriod","Plan",
    "TableRating","InquiryType","ResultType","NumberOfCompanies",
    "DisplayFlags","DropCompanies",
    // Optional filters
    "ZipCode","COMPINC","PRODDIS","CompRating","SortOverride1",
    "ErrOnMissingZipCode","MaxNumResults","LANGUAGE",
    // Health Analyzer fields
    "Alcohol","AlcoholYearsSinceTreatment",
    "Asthma","AsthmaRegularMedication",
    "BloodPressure","BloodPressureMedication","BPSystolic","BPDiastolic",
    "Cancer","CancerType","CancerYearsSinceTreatment",
    "Cholesterol","CholesterolMedication","CholesterolReading",
    "Diabetes","DiabetesType","DiabetesA1CReading",
    "HeartDisease","HeartType","HeartYearsSinceTreatment",
    "Depression","DepressionYearsSinceTreatment",
    "Drugs","DrugsYearsSinceTreatment",
    "EmbeddedAccums","EmbeddedAccumColor","NoRedX",
    // Health Analyzer smoking/HW/driving/family
    "DoSmokingTobacco","DoCigarettes","PeriodCigarettes","NumCigarettes",
    "DoCigars","PeriodCigars","NumCigars","DoPipe","PeriodPipe",
    "DoChewingTobacco","PeriodChewingTobacco",
    "DoNicotinePatchesOrGum","PeriodNicotinePatchesOrGum",
    "DoHeightWeight","Weight","Feet","Inches",
    "DoBloodPressure","Systolic","Dystolic",
    "DoCholesterol","CholesterolLevel","HDLRatio","CholesterolMedication",
    "DoDriving","HadDriversLicense","RecklessConviction","DwiConviction",
    "SuspendedConviction","MoreThanOneAccident",
    "DoFamily","NumDeaths","NumContracted",
    "DoSubAbuse",
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
  console.log(`[Compulife] Params:`, JSON.stringify(params));
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
    const isPassthrough = req.body.model && req.body.messages;
    let body;
    if (isPassthrough) { body = JSON.stringify(req.body); }
    else {
      const { image, media_type, prompt } = req.body;
      if (!image) return res.status(400).json({ error: "image (base64) required" });
      body = JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4096, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: media_type || "image/png", data: image } }, { type: "text", text: prompt || "Extract all text from this lead card. Return JSON." }] }] });
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, body });
    res.json(await r.json());
  } catch (e) { console.error("[Anthropic]", e.message); res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// SUPABASE — Lead Image Storage
// ============================================================
app.post("/supabase/upload", async (req, res) => {
  try {
    if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: true, message: "SUPABASE_SERVICE_KEY not configured" });
    const { imageData, fileName, mimeType, folder } = req.body;
    if (!imageData) return res.status(400).json({ error: true, message: "imageData (base64) required" });
    const storagePath = folder ? `${folder}/${fileName}` : fileName;
    const buffer = Buffer.from(imageData, "base64");
    const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${storagePath}`, {
      method: "POST", headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": mimeType || "image/png", "x-upsert": "true" }, body: buffer,
    });
    const uploadData = await uploadResp.json();
    if (!uploadResp.ok) return res.status(uploadResp.status).json({ error: true, message: uploadData.error || uploadData.message || "Upload failed" });
    res.json({ success: true, path: storagePath, bucket: SUPABASE_BUCKET, fullPath: `${SUPABASE_BUCKET}/${storagePath}` });
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

app.get("/supabase/signed-url", async (req, res) => {
  try {
    if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: true, message: "SUPABASE_SERVICE_KEY not configured" });
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: true, message: "path query param required" });
    const expiresIn = parseInt(req.query.expires || "3600");
    const signResp = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${SUPABASE_BUCKET}/${filePath}`, {
      method: "POST", headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn }),
    });
    const signData = await signResp.json();
    if (!signResp.ok) return res.status(signResp.status).json({ error: true, message: signData.error || signData.message || "Sign failed" });
    const signedUrl = (signData.signedURL || signData.signedUrl) ? `${SUPABASE_URL}/storage/v1${signData.signedURL || signData.signedUrl}` : null;
    if (!signedUrl) return res.status(500).json({ error: true, message: "No signed URL returned" });
    res.json({ success: true, signedUrl, expiresIn, path: filePath });
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n✅ QuoteIt API Hub v7.2 running on port ${PORT}`);
  console.log(`   Compulife:  ${AUTH_ID ? "✓" : "✗"} | GHL: ${GHL_API_KEY ? "✓" : "✗"} | Anthropic: ${ANTHROPIC_API_KEY ? "✓" : "✗"}`);
  console.log(`   Supabase:   ${SUPABASE_SERVICE_KEY ? "✓" : "✗"} | Drive: ${GOOGLE_REFRESH_TOKEN ? "✓" : "✗"} | Vision: ${GCP_VISION_API_KEY ? "✓" : "✗"}`);
  console.log(`   CORS: ${ALLOWED_ORIGINS.join(", ")}\n`);
});
