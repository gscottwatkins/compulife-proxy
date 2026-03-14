// ============================================================
// iAgentIQ API HUB — Railway Proxy Server v7.0
// Routes: Compulife | SMS (Telnyx) | Email (Postmark) | Anthropic | Google Drive
// Deploy: Railway with Static Egress IP (162.220.232.99)
// Updated: Mar 09, 2026 — Added Telnyx SMS + Postmark email routes; proprietary CRM
// ============================================================

const express = require("express");
const cors = require("cors");
// ── CORS ──
const corsOptions = {
origin: [
  'https://iagentiq-quote-engine.gscottwatkins.workers.dev',
  'https://quoteit.insure',
  'https://engine.iagentiq.com',
  'http://localhost:3000'
],
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
};
const app = express();app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
const PORT = process.env.PORT || 3000;

// ---- Config ----
const AUTH_ID = process.env.COMPULIFE_AUTH_ID || "";
const REMOTE_IP = process.env.REMOTE_IP || "162.220.232.99";
const COMPULIFE_BASE = "https://www.compulifeapi.com/api";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// ---- Telnyx SMS ----
const TELNYX_API_KEY  = process.env.TELNYX_API_KEY || "";
const TELNYX_PHONE    = process.env.TELNYX_PHONE   || "+16016918436";

// ---- Postmark Email ----
const POSTMARK_API_KEY = process.env.POSTMARK_API_KEY || "";
const FROM_EMAIL       = process.env.FROM_EMAIL       || "swatkins@quoteit.insure";

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
    service: "iagentiq-api-hub",
    version: "7.0.0",
    timestamp: new Date().toISOString(),
    configured: {
      compulife:    !!AUTH_ID,
      anthropic:    !!ANTHROPIC_API_KEY,
      googleDrive:  !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN),
      googleVision: !!GCP_VISION_API_KEY,
      sms:          !!TELNYX_API_KEY,
      email:        !!POSTMARK_API_KEY,
    },
    endpoints: [
      "POST   /compulife/quote",
      "POST   /compulife/sidebyside",
      "POST   /sms/send",
      "POST   /sms/send-bulk",
      "GET    /sms/status",
      "POST   /email/send",
      "POST   /drive/upload",
      "GET    /supabase/signed-url",
      "POST   /supabase/upload",
      "POST   /anthropic/vision",
      "POST   /ai/chat",
    ],
  });
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
  // Return cached token if still valid (with 60s buffer)
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
  console.log("[Drive] Access token refreshed successfully");
  return cachedAccessToken;
}

async function findOrCreateFolder(accessToken, folderName, parentId) {
  // Search for existing folder
  const query = `name='${folderName.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;

  const searchResp = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const searchData = await searchResp.json();

  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }

  // Create folder
  console.log(`[Drive] Creating folder: ${folderName}`);
  const createResp = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });

  const createData = await createResp.json();
  if (!createResp.ok) {
    throw new Error(`Failed to create folder: ${createData.error?.message || "unknown"}`);
  }
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

    // Determine parent folder
    let parentFolderId = GOOGLE_DRIVE_FOLDER_ID;

    // If no root folder configured, create "Lead Scanner Pro" in Drive root
    if (!parentFolderId) {
      parentFolderId = await findOrCreateFolder(accessToken, "Lead Scanner Pro", "root");
    }

    // Create vendor subfolder if specified
    let targetFolderId = parentFolderId;
    if (vendorFolder) {
      targetFolderId = await findOrCreateFolder(accessToken, vendorFolder, parentFolderId);
    }

    // Upload file using multipart upload
    const boundary = "lead_scanner_boundary_" + Date.now();
    const metadata = JSON.stringify({
      name: fileName || `lead_${Date.now()}.pdf`,
      parents: [targetFolderId],
    });

    // Decode base64 to binary
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

    if (!uploadResp.ok) {
      console.error("[Drive] Upload failed:", uploadData);
      return res.status(uploadResp.status).json({
        error: true,
        message: uploadData.error?.message || "Upload failed",
      });
    }

    // Make file viewable by anyone with the link
    await fetch(`https://www.googleapis.com/drive/v3/files/${uploadData.id}/permissions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "reader",
        type: "anyone",
      }),
    });

    console.log(`[Drive] ✓ Uploaded: ${uploadData.name} → ${uploadData.webViewLink}`);

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
// GOOGLE VISION — OCR Proxy for Lead Scanner Pro
// ============================================================
app.post("/vision/ocr", async (req, res) => {
  try {
    const GCP_API_KEY = process.env.GCP_VISION_API_KEY || "";
    if (!GCP_API_KEY) return res.status(500).json({ error: true, message: "GCP_VISION_API_KEY not configured" });

    const { imageData, mimeType } = req.body;
    if (!imageData) return res.status(400).json({ error: true, message: "imageData (base64) required" });

    const url = `https://vision.googleapis.com/v1/images:annotate?key=${GCP_API_KEY}`;
    const body = {
      requests: [{
        image: { content: imageData },
        features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
        imageContext: { languageHints: ["en"] },
      }],
    };

    console.log("[Vision] Processing OCR request...");
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await resp.json();
    if (!resp.ok) {
      console.error("[Vision] API error:", result);
      return res.status(resp.status).json({ error: true, message: result.error?.message || "Vision API error" });
    }

    const annotation = result.responses?.[0];
    if (annotation?.error) {
      return res.status(400).json({ error: true, message: annotation.error.message });
    }

    const fullText = annotation?.fullTextAnnotation?.text || "";
    const pages = annotation?.fullTextAnnotation?.pages || [];

    let totalConf = 0, wordCount = 0;
    for (const page of pages) {
      for (const block of (page.blocks || [])) {
        for (const para of (block.paragraphs || [])) {
          for (const word of (para.words || [])) {
            if (word.confidence !== undefined) {
              totalConf += word.confidence;
              wordCount++;
            }
          }
        }
      }
    }

    const avgConfidence = wordCount > 0 ? Math.round((totalConf / wordCount) * 100) : null;
    console.log(`[Vision] ✓ OCR complete: ${wordCount} words, ${avgConfidence}% confidence`);

    res.json({
      success: true,
      fullText,
      confidence: avgConfidence,
      wordCount,
    });

  } catch (e) {
    console.error("[Vision] Error:", e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

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
});// ══════════════════════════════════════════════════════════
// COMPULIFE DIRECT QUOTE ROUTE
// ══════════════════════════════════════════════════════════
app.post("/compulife/quote", async (req, res) => {
  try {
    const result = await proxyPrivate("/request", req.body);
    return res.json(result);
  } catch (e) {
    console.error("[Compulife/quote]", e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

function buildCompulifeParams(body) {
  const params = {};
  const fields = [
    // Core quote fields (legacy + current naming)
    "Province","State","Sex","Smoker","Birthdate","BirthMonth","Birthday","BirthYear",
    "FaceAmount","Premium","Mode","ModeUsed","Health",
    "TermPeriod","NewCategory","Category",
    "TableRating","InquiryType","ResultType","NumberOfCompanies",
    "Plan","DisplayFlags","DropCompanies",
    // Sort/display options
    "CompRating","SortOverride1","LANGUAGE","ZipCode","COMPINC","PRODDIS",
    "ErrOnMissingZipCode","MaxNumResults",
    // Health analyzer fields
    "Alcohol","AlcoholYearsSinceTreatment",
    "Asthma","AsthmaRegularMedication","BloodPressure","BloodPressureMedication",
    "BPSystolic","BPDiastolic","Cancer","CancerType","CancerYearsSinceTreatment",
    "Cholesterol","CholesterolMedication","CholesterolReading","Diabetes",
    "DiabetesType","DiabetesA1CReading","HeartDisease","HeartType",
    "HeartYearsSinceTreatment","Depression","DepressionYearsSinceTreatment",
    "Drugs","DrugsYearsSinceTreatment","EmbeddedAccums","EmbeddedAccumColor","NoRedX",
    // Smoking/Tobacco detail
    "DoSmokingTobacco","DoCigarettes","PeriodCigarettes","NumCigarettes",
    "DoCigars","PeriodCigars","NumCigars","DoPipe","PeriodPipe",
    "DoChewingTobacco","PeriodChewingTobacco","DoNicotinePatchesOrGum","PeriodNicotinePatchesOrGum",
    // Height/Weight
    "DoHeightWeight","Weight","Feet","Inches",
    // Blood Pressure detail
    "DoBloodPressure","Systolic","Dystolic",
    // Cholesterol detail
    "DoCholesterol","CholesterolLevel","HDLRatio","PeriodCholesterol","PeriodCholesterolControlDuration",
    // Driving
    "DoDriving","HadDriversLicense",
    "MovingViolations0","MovingViolations1","MovingViolations2","MovingViolations3","MovingViolations4",
    "RecklessConviction","DwiConviction","SuspendedConviction","MoreThanOneAccident",
    "PeriodRecklessConviction","PeriodDwiConviction","PeriodSuspendedConviction","PeriodMoreThanOneAccident",
    // Family History
    "DoFamily","NumDeaths","NumContracted",
    "AgeDied00","AgeContracted00","IsParent00","CVD00","ColonCancer00",
    "AgeContracted10","IsParent10","CVD10","ColonCancer10",
    // Substance Abuse
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
  console.log(`[Compulife] Full URL length: ${url.length}`);
  console.log(`[Compulife] Payload keys: ${Object.keys(payload).join(', ')}`);
  const r = await fetch(url);
  console.log(`[Compulife] Response status: ${r.status}`);
  const t = await r.text();
  console.log(`[Compulife] Response preview: ${t.substring(0, 200)}`);
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}

// ============================================================
// ANTHROPIC — OCR for Lead Scanner Pro
// ============================================================
app.post("/anthropic", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

    // Support both legacy format and new passthrough format
    const isPassthrough = req.body.model && req.body.messages;

    let body;
    if (isPassthrough) {
      // New format: pass through the full Anthropic request
      body = JSON.stringify(req.body);
    } else {
      // Legacy format: image + prompt
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
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body,
    });

    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error("[Anthropic]", e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// AI Chat Proxy — shields Anthropic API key from frontend; frontend POSTs to /ai/chat
// ═══════════════════════════════════════════════════════════════
app.post("/ai/chat", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "AI proxy error", detail: "ANTHROPIC_API_KEY not configured" });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });

    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (e) {
      data = { error: "Invalid JSON from Anthropic", detail: raw.slice(0, 200) };
    }

    if (!response.ok) {
      return res.status(response.status).json(data);
    }
    res.json(data);
  } catch (err) {
    console.error("[AI Chat Proxy] Error:", err.message);
    res.status(500).json({ error: "AI proxy error", detail: err.message });
  }
});

// ============================================================
// SMS — Telnyx
// ============================================================

// GET /sms/status — confirm SMS is configured
app.get("/sms/status", (req, res) => {
  res.json({
    configured: !!TELNYX_API_KEY,
    from: TELNYX_PHONE,
    service: "telnyx",
    status: TELNYX_API_KEY ? "ready" : "missing TELNYX_API_KEY",
  });
});

// POST /sms/send — send single SMS
// Body: { to, body, from (optional) }
app.post("/sms/send", async (req, res) => {
  const { to, body, from } = req.body || {};
  if (!to || !body) {
    return res.status(400).json({ success: false, error: "Missing required fields: to, body" });
  }
  const toClean = normalizePhone(to);
  if (!toClean) {
    return res.status(400).json({ success: false, error: "Invalid phone number format" });
  }
  if (!TELNYX_API_KEY) {
    return res.status(500).json({ success: false, error: "TELNYX_API_KEY not configured" });
  }
  try {
    const r = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        from: from || TELNYX_PHONE,
        to: toClean,
        text: body,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      const errMsg = data?.errors?.[0]?.detail || data?.error || "Telnyx send failed";
      console.error(`[SMS] Error to ${toClean}:`, errMsg);
      return res.status(r.status).json({ success: false, error: errMsg });
    }
    console.log(`[SMS] Sent to ${toClean} | ID: ${data?.data?.id || "unknown"}`);
    res.json({
      success: true,
      sid: data?.data?.id,
      to: toClean,
      status: data?.data?.to?.[0]?.status || "queued",
    });
  } catch (e) {
    console.error("[SMS] Exception:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /sms/send-bulk — send same message to multiple recipients
// Body: { recipients: ['+16015551234', ...], body, from (optional) }
app.post("/sms/send-bulk", async (req, res) => {
  const { recipients, body, from } = req.body || {};
  if (!recipients || !Array.isArray(recipients) || !body) {
    return res.status(400).json({ success: false, error: "Missing required fields: recipients (array), body" });
  }
  const results = [];
  for (const phone of recipients) {
    const toClean = normalizePhone(phone);
    if (!toClean) { results.push({ to: phone, success: false, error: "Invalid phone" }); continue; }
    try {
      const r = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TELNYX_API_KEY}` },
        body: JSON.stringify({ from: from || TELNYX_PHONE, to: toClean, text: body }),
      });
      const data = await r.json();
      if (r.ok) {
        results.push({ to: toClean, success: true, sid: data?.data?.id });
      } else {
        results.push({ to: toClean, success: false, error: data?.errors?.[0]?.detail || "Send failed" });
      }
      await new Promise(resolve => setTimeout(resolve, 120)); // rate limit buffer
    } catch (e) {
      results.push({ to: toClean, success: false, error: e.message });
    }
  }
  const sent = results.filter(r => r.success).length;
  console.log(`[SMS] Bulk: ${sent}/${recipients.length} delivered`);
  res.json({ success: true, sent, total: recipients.length, results });
});

// ============================================================
// EMAIL — Postmark
// ============================================================

// POST /email/send — send transactional email
// Body: { to, subject, html, text, replyTo (optional) }
app.post("/email/send", async (req, res) => {
  const { to, subject, html, text, replyTo } = req.body || {};
  if (!to || !subject || (!html && !text)) {
    return res.status(400).json({ success: false, error: "Missing required fields: to, subject, html or text" });
  }
  if (!POSTMARK_API_KEY) {
    return res.status(500).json({ success: false, error: "POSTMARK_API_KEY not configured" });
  }
  try {
    const r = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": POSTMARK_API_KEY,
        "Accept": "application/json",
      },
      body: JSON.stringify({
        From: FROM_EMAIL,
        To: to,
        Subject: subject,
        HtmlBody: html || "",
        TextBody: text || "",
        ReplyTo: replyTo || FROM_EMAIL,
        MessageStream: "outbound",
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("[EMAIL] Error:", data?.Message || data);
      return res.status(r.status).json({ success: false, error: data?.Message || "Postmark send failed" });
    }
    console.log(`[EMAIL] Sent to ${to} | ID: ${data.MessageID}`);
    res.json({ success: true, messageId: data.MessageID, to, subject });
  } catch (e) {
    console.error("[EMAIL] Exception:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n✅ iAgentIQ API Hub v7.0 running on port ${PORT}`);
  console.log(`   Compulife:  ${AUTH_ID ? "✓ configured" : "✗ NOT SET"}`);
  console.log(`   Anthropic:  ${ANTHROPIC_API_KEY ? "✓ configured" : "✗ NOT SET"}`);
  console.log(`   SMS/Telnyx: ${TELNYX_API_KEY ? "✓ configured (" + TELNYX_PHONE + ")" : "✗ NOT SET"}`);
  console.log(`   Email/PM:   ${POSTMARK_API_KEY ? "✓ configured (" + FROM_EMAIL + ")" : "✗ NOT SET"}`);
  console.log(`   Drive:      ${GOOGLE_REFRESH_TOKEN ? "✓ configured" : "✗ NOT SET"}`);
  console.log(`   Vision:     ${GCP_VISION_API_KEY ? "✓ configured" : "✗ NOT SET"}`);
  console.log(`   CORS:       ${ALLOWED_ORIGINS.join(", ")}\n`);
});
// ═══════════════════════════════════════════════════════════════
// RAILWAY PROXY PATCH — zestful-education index.js
//
// INSTRUCTIONS:
// 1. Open Railway → zestful-education → index.js
// 2. Find your existing /compulife/quote route
// 3. Paste this ENTIRE block right after it
// 4. Save — Railway auto-deploys (~60 seconds)
// 5. iAgentIQ → My Account → Admin Tools → Compulife Product Inspector
//    → Click "Fetch via Railway Proxy" — all 12 carriers populate
// ═══════════════════════════════════════════════════════════════

const COMPULIFE_AUTH_ID = '6c1B02Df8';
const COMPULIFE_API_BASE = 'https://compulifeapi.com/api';

// ── POST /compulife/products ─────────────────────────────────
// Auth goes as QUERY PARAM per Compulife curl docs:
// curl POST /api/CompanyProductList?COMPULIFEAUTHORIZATIONID=xxx
app.post('/compulife/products', async (req, res) => {
  try {
    const { CompanyCode, Category } = req.body;
    const url = `${COMPULIFE_API_BASE}/CompanyProductList?COMPULIFEAUTHORIZATIONID=${COMPULIFE_AUTH_ID}`;
    console.log(`[compulife/products] ${CompanyCode} cat:${Category}`);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'curl/7.55.1' },
      body: JSON.stringify({ CompanyCode, Category })
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: `Compulife ${r.status}`, raw: text.substring(0, 300) });
    try { res.json(JSON.parse(text)); }
    catch(e) { res.status(502).json({ error: 'Non-JSON from Compulife', raw: text.substring(0, 500) }); }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── GET /compulife/products (browser test) ───────────────────
// https://zestful-education-production-88e7.up.railway.app/compulife/products?CompanyCode=SENA&Category=6
app.get('/compulife/products', async (req, res) => {
  try {
    const { CompanyCode, Category } = req.query;
    const url = `${COMPULIFE_API_BASE}/CompanyProductList?COMPULIFEAUTHORIZATIONID=${COMPULIFE_AUTH_ID}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'curl/7.55.1' },
      body: JSON.stringify({ CompanyCode, Category })
    });
    const text = await r.text();
    try { res.json(JSON.parse(text)); }
    catch(e) { res.status(502).json({ error: 'Non-JSON', raw: text.substring(0, 500) }); }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── GET /compulife/companies (logo lookup) ───────────────────
// Returns company list with official logo URLs
// https://zestful-education-production-88e7.up.railway.app/compulife/companies
app.get('/compulife/companies', async (req, res) => {
  try {
    const url = `${COMPULIFE_API_BASE}/GetCompanyList?COMPULIFEAUTHORIZATIONID=${COMPULIFE_AUTH_ID}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'curl/7.55.1' },
      body: JSON.stringify({})
    });
    const text = await r.text();
    try { res.json(JSON.parse(text)); }
    catch(e) { res.status(502).json({ error: 'Non-JSON', raw: text.substring(0, 500) }); }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// QUICK BROWSER TESTS after deploying:
//
// Security National:
// /compulife/products?CompanyCode=SENA&Category=6
//
// Combined Insurance:
// /compulife/products?CompanyCode=COMB&Category=6
//
// Americo Financial:
// /compulife/products?CompanyCode=AMSV&Category=5
//
// Foresters:
// /compulife/products?CompanyCode=INDE&Category=5
//
// United of Omaha:
// /compulife/products?CompanyCode=UTOM&Category=5
//
// Company list + logos:
// /compulife/companies
// ═══════════════════════════════════════════════════════════════
