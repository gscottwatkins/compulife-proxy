// ============================================================
// COMPULIFE PROXY — Express Server for Railway (Static IP)
// Replaces: netlify/functions/compulife-proxy.js
// Deploy: Railway with Static Egress IP add-on
// ============================================================
// Same API surface as Netlify version — POST body with "action" field.
// Browser calls → this server → Compulife API (whitelisted static IP).
// ============================================================

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config ----
const AUTH_ID = process.env.COMPULIFE_AUTH_ID || "6c1B02Df8";
const REMOTE_IP = process.env.REMOTE_IP || "162.220.232.99";
const API_BASE = "https://www.compulifeapi.com/api";

// ---- GHL Config ----
const GHL_API_KEY = process.env.GHL_API_KEY || "";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "";

// ---- Anthropic Config ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// ---- Middleware ----
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : ["https://quoteitengine.com", "https://www.quoteitengine.com", "http://localhost:3000"];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all for now
    }
  },
  credentials: true
}));
app.use(express.json({ limit: "5mb" }));

// ---- Health Check (GET /) ----
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "quoteit-api-hub",
    version: "2.0.0",
    host: "railway",
    timestamp: new Date().toISOString(),
    routes: {
      compulife: "POST /",
      anthropic: "POST /api/anthropic/messages",
      ghl_contacts: "POST /api/ghl/contacts",
      ghl_search: "GET /api/ghl/contacts/search",
      ghl_opportunities: "POST /api/v1/opportunities",
      ghl_custom_fields: "GET /api/ghl/custom_fields",
      ghl_pipelines: "GET /api/ghl/pipelines",
    },
    configured: {
      compulife: !!AUTH_ID,
      anthropic: !!ANTHROPIC_API_KEY,
      ghl: !!GHL_API_KEY,
    },
  });
});

// ---- Main Compulife Route (POST /) ----
app.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const action = body.action || "ping";

    switch (action) {
      // ---- Health Check ----
      case "ping":
        return res.json({
          status: "ok",
          service: "quoteit-api-hub",
          timestamp: new Date().toISOString(),
          auth_configured: !!AUTH_ID,
          remote_ip: REMOTE_IP,
        });

      // ---- PUBLIC: State List ----
      case "get-states":
        return res.json(await proxyPublic("/StateList"));

      // ---- PUBLIC: Province List ----
      case "get-provinces":
        return res.json(await proxyPublic("/ProvinceList"));

      // ---- PUBLIC: Company Logos ----
      case "get-logos": {
        const size = body.size || "small";
        const country = body.country || "us";
        const base = country === "canada" ? "/CompanyLogoListCanada" : "/CompanyLogoList";
        const path = size === "default" ? base : `${base}/${size}`;
        return res.json(await proxyPublic(path));
      }

      // ---- PUBLIC: Company List ----
      case "get-companies": {
        const country = body.country || "us";
        const path = country === "canada" ? "/CompanyListCanada" : "/CompanyList";
        return res.json(await proxyPublic(path));
      }

      // ---- PRIVATE: Category List ----
      case "get-categories":
        return res.json(await proxyPrivate("/CategoryList", {}));

      // ---- PRIVATE: Company + Product List ----
      case "get-company-products": {
        const params = {};
        if (body.COMPINC) params.COMPINC = body.COMPINC;
        return res.json(await proxyPrivate("/CompanyProductList", params));
      }

      // ---- PRIVATE: Standard Comparison Quote ----
      case "quote-compare":
        return res.json(await proxyPrivate("/request", buildQuoteParams(body)));

      // ---- PRIVATE: Side-by-Side Spreadsheet ----
      case "quote-sidebyside":
        return res.json(await proxyPrivate("/sidebyside", buildQuoteParams(body)));

      // ---- PRIVATE: Health Analyzer Quote ----
      case "quote-health":
        return res.json(await proxyPrivate("/request", buildHealthParams(body)));

      // ---- Unknown ----
      default:
        return res.status(400).json({
          error: "Unknown action",
          action,
          available: [
            "ping",
            "get-states", "get-provinces", "get-logos", "get-companies",
            "get-categories", "get-company-products",
            "quote-compare", "quote-sidebyside", "quote-health",
          ],
        });
    }
  } catch (err) {
    console.error("compulife-proxy error:", err);
    res.status(500).json({ error: "Internal proxy error", message: err.message });
  }
});

// ============================================================
// ANTHROPIC PROXY ROUTE
// ============================================================
app.post("/api/anthropic/messages", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error("anthropic proxy error:", err);
    res.status(500).json({ error: "Anthropic proxy error", message: err.message });
  }
});

// ============================================================
// GHL PROXY ROUTES
// ============================================================
const GHL_BASE = "https://rest.gohighlevel.com/v1";

function ghlHeaders() {
  return {
    "Authorization": "Bearer " + GHL_API_KEY,
    "Content-Type": "application/json",
  };
}

// Contacts
app.post("/api/ghl/contacts", async (req, res) => {
  try {
    const response = await fetch(`${GHL_BASE}/contacts/`, {
      method: "POST",
      headers: ghlHeaders(),
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "GHL contacts error", message: err.message });
  }
});

// Contact search
app.get("/api/ghl/contacts/search", async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const response = await fetch(`${GHL_BASE}/contacts/?${qs}`, {
      headers: ghlHeaders(),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "GHL search error", message: err.message });
  }
});

// Opportunities
app.post("/api/v1/opportunities", async (req, res) => {
  try {
    const pipelineId = req.body.pipelineId || req.query.pipelineId;
    const url = pipelineId
      ? `${GHL_BASE}/pipelines/${pipelineId}/opportunities/`
      : `${GHL_BASE}/opportunities/`;
    const response = await fetch(url, {
      method: "POST",
      headers: ghlHeaders(),
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "GHL opportunities error", message: err.message });
  }
});

// Custom fields
app.get("/api/ghl/custom_fields", async (req, res) => {
  try {
    const response = await fetch(`${GHL_BASE}/custom-fields/`, {
      headers: ghlHeaders(),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "GHL custom fields error", message: err.message });
  }
});

// Pipelines
app.get("/api/ghl/pipelines", async (req, res) => {
  try {
    const response = await fetch(`${GHL_BASE}/pipelines/`, {
      headers: ghlHeaders(),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "GHL pipelines error", message: err.message });
  }
});

// ============================================================
// PARAMETER BUILDERS
// ============================================================

function buildQuoteParams(body) {
  const params = {};
  const required = [
    "State", "BirthMonth", "Birthday", "BirthYear",
    "Sex", "Smoker", "Health", "NewCategory", "FaceAmount", "ModeUsed",
  ];
  for (const key of required) {
    if (body[key] !== undefined) params[key] = String(body[key]);
  }
  const optional = [
    "ZipCode", "COMPINC", "PRODDIS", "CompRating",
    "SortOverride1", "ErrOnMissingZipCode", "MaxNumResults", "LANGUAGE",
  ];
  for (const key of optional) {
    if (body[key] !== undefined) params[key] = String(body[key]);
  }
  if (!params.CompRating) params.CompRating = "4";
  if (!params.SortOverride1) params.SortOverride1 = "A";
  if (!params.LANGUAGE) params.LANGUAGE = "E";
  return params;
}

function buildHealthParams(body) {
  const params = buildQuoteParams(body);
  const healthFields = [
    "DoSmokingTobacco", "DoCigarettes", "PeriodCigarettes", "NumCigarettes",
    "DoCigars", "PeriodCigars", "NumCigars",
    "DoPipe", "PeriodPipe",
    "DoChewingTobacco", "PeriodChewingTobacco",
    "DoNicotinePatchesOrGum", "PeriodNicotinePatchesOrGum",
    "DoHeightWeight", "Weight", "Feet", "Inches",
    "DoBloodPressure", "Systolic", "Dystolic", "BloodPressureMedication",
    "DoCholesterol", "CholesterolLevel", "HDLRatio",
    "CholesterolMedication", "PeriodCholesterol", "PeriodCholesterolControlDuration",
    "DoDriving", "HadDriversLicense",
    "MovingViolations0", "MovingViolations1", "MovingViolations2",
    "MovingViolations3", "MovingViolations4",
    "RecklessConviction", "DwiConviction", "SuspendedConviction", "MoreThanOneAccident",
    "PeriodRecklessConviction", "PeriodDwiConviction",
    "PeriodSuspendedConviction", "PeriodMoreThanOneAccident",
    "DoFamily", "NumDeaths", "NumContracted",
    "AgeDied00", "AgeContracted00", "IsParent00", "CVD00", "ColonCancer00",
    "AgeContracted10", "IsParent10", "CVD10", "ColonCancer10",
    "DoSubAbuse", "Alcohol", "AlcYearsSinceTreatment",
    "Drugs", "DrugsYearsSinceTreatment",
    "EmbeddedAccums", "EmbeddedAccumColor", "NoRedX",
  ];
  for (const key of healthFields) {
    if (body[key] !== undefined) params[key] = String(body[key]);
  }
  return params;
}

// ============================================================
// API CALLERS
// ============================================================

async function proxyPublic(path) {
  const url = `${API_BASE}${path}`;
  console.log(`[compulife-proxy] PUBLIC → ${url}`);
  const res = await fetch(url);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

async function proxyPrivate(path, params) {
  const payload = {
    COMPULIFEAUTHORIZATIONID: AUTH_ID,
    REMOTE_IP: REMOTE_IP,
    ...params,
  };
  const json = JSON.stringify(payload);
  const url = `${API_BASE}${path}/?COMPULIFE=${encodeURIComponent(json)}`;

  console.log(`[compulife-proxy] PRIVATE → ${API_BASE}${path}`);
  console.log(`[compulife-proxy] Payload keys: ${Object.keys(payload).join(", ")}`);
  console.log(`[compulife-proxy] REMOTE_IP: ${REMOTE_IP}`);

  const res = await fetch(url);
  const text = await res.text();
  console.log(`[compulife-proxy] Response status: ${res.status}, length: ${text.length}`);

  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ QuoteIt API Hub running on port ${PORT}`);
  console.log(`   Auth ID: ${AUTH_ID ? AUTH_ID.slice(0, 4) + "..." : "NOT SET"}`);
  console.log(`   Remote IP: ${REMOTE_IP}`);
  console.log(`   API Base: ${API_BASE}`);
  console.log(`   GHL: ${GHL_API_KEY ? "configured" : "NOT SET"}`);
  console.log(`   Anthropic: ${ANTHROPIC_API_KEY ? "configured" : "NOT SET"}`);
});
