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
const API_BASE = "https://www.compulifeapi.com/api";

// ---- Middleware ----
app.use(cors());
app.use(express.json());

// ---- Health Check (GET /) ----
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "compulife-proxy",
    version: "1.0.0",
    host: "railway",
    timestamp: new Date().toISOString(),
    auth_configured: !!AUTH_ID,
  });
});

// ---- Main API Route (POST /) ----
app.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const action = body.action || "ping";

    switch (action) {
      // ---- Health Check ----
      case "ping":
        return res.json({
          status: "ok",
          service: "compulife-proxy",
          timestamp: new Date().toISOString(),
          auth_configured: !!AUTH_ID,
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
    ...params,
  };
  const json = JSON.stringify(payload);
  const url = `${API_BASE}${path}/?COMPULIFE=${encodeURIComponent(json)}`;

  console.log(`[compulife-proxy] PRIVATE → ${API_BASE}${path}`);
  console.log(`[compulife-proxy] Payload keys: ${Object.keys(payload).join(", ")}`);

  const res = await fetch(url);
  const text = await res.text();
  console.log(`[compulife-proxy] Response status: ${res.status}, length: ${text.length}`);

  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ Compulife Proxy running on port ${PORT}`);
  console.log(`   Auth ID: ${AUTH_ID ? AUTH_ID.slice(0, 4) + "..." : "NOT SET"}`);
  console.log(`   API Base: ${API_BASE}`);
});
