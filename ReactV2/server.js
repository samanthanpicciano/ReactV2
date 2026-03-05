/**
 * CT React — Backend Server v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles:
 *   1. Google Sign-In verification (restricts to @coalitiontechnologies.com)
 *   2. Session management (JWT cookies — no passwords ever)
 *   3. All Google API calls via Service Account (GSC, GA4, Gmail)
 *   4. Anthropic API proxy
 *   5. Postgres-backed shared client state (all leads see the same data)
 *
 * Deploy on Railway. Set env vars (see .env.example).
 * Run locally: node server.js
 */

const express       = require("express");
const cors          = require("cors");
const cookieParser  = require("cookie-parser");
const jwt           = require("jsonwebtoken");
const { Pool }      = require("pg");
const { google }    = require("googleapis");
const fetch         = (...args) => import("node-fetch").then(m => m.default(...args));
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Env validation ────────────────────────────────────────────────────────────
const REQUIRED = [
  "JWT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "ANTHROPIC_API_KEY",
  "DATABASE_URL",
];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error("⚠  Missing required env vars:", missing.join(", "));
  console.error("   Check your .env file or Railway environment settings.");
}

// ── Config ────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN    || "http://localhost:5173";
const ALLOWED_DOMAIN    = process.env.ALLOWED_DOMAIN    || "coalitiontechnologies.com";
const JWT_SECRET        = process.env.JWT_SECRET        || "change-me-in-production";
const GOOGLE_CLIENT_ID  = process.env.GOOGLE_CLIENT_ID  || "";
const SESSION_DAYS      = parseInt(process.env.SESSION_DAYS || "7");

// ── Service account ───────────────────────────────────────────────────────────
let serviceAccountKey = null;
try {
  serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
} catch {
  console.error("⚠  Could not parse GOOGLE_SERVICE_ACCOUNT_JSON");
}

function getServiceAuth(scopes) {
  if (!serviceAccountKey?.client_email) return null;
  return new google.auth.JWT({
    email:  serviceAccountKey.client_email,
    key:    serviceAccountKey.private_key,
    scopes,
  });
}

// ── Postgres ──────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      data         JSONB NOT NULL DEFAULT '{}',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS scan_log (
      id         SERIAL PRIMARY KEY,
      lead_name  TEXT,
      lead_email TEXT,
      scanned_at TIMESTAMPTZ DEFAULT NOW(),
      client_ct  INT
    );
  `);
  console.log("✓  Database tables ready");
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin:      ALLOWED_ORIGIN,
  credentials: true,
  methods:     ["GET","POST","PUT","DELETE","OPTIONS"],
}));
app.use(express.json({ limit:"4mb" }));
app.use(cookieParser());

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.ct_session
    || req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired — please sign in again" });
  }
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok",
  db:     !!process.env.DATABASE_URL,
  sa:     !!serviceAccountKey?.client_email,
  anthropic: !!process.env.ANTHROPIC_API_KEY,
}));

// ══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /auth/google
 * Body: { credential: "<Google ID token from GSI button>" }
 * Verifies the token, checks the domain, sets a session cookie.
 */
app.post("/auth/google", async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: "No credential provided" });

  try {
    // Verify with Google
    const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`;
    const r = await fetch(verifyUrl);
    const payload = await r.json();

    if (payload.error) throw new Error(payload.error_description || "Invalid token");
    if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error("Token audience mismatch");

    const email  = payload.email;
    const domain = email.split("@")[1];

    if (domain !== ALLOWED_DOMAIN) {
      return res.status(403).json({
        error: `Access restricted to @${ALLOWED_DOMAIN} accounts. You signed in with ${email}.`,
      });
    }

    // Issue JWT session
    const user = {
      email,
      name:    payload.name,
      picture: payload.picture,
      given:   payload.given_name,
    };
    const sessionToken = jwt.sign(user, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });

    res.cookie("ct_session", sessionToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge:   SESSION_DAYS * 24 * 60 * 60 * 1000,
    });

    console.log(`✓  Signed in: ${email}`);
    res.json({ user, ok: true });
  } catch (e) {
    console.error("Auth error:", e.message);
    res.status(401).json({ error: e.message });
  }
});

/** GET /auth/me — returns current session user */
app.get("/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

/** POST /auth/logout */
app.post("/auth/logout", (_req, res) => {
  res.clearCookie("ct_session");
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// CLIENT DATA ROUTES  (shared across all leads)
// ══════════════════════════════════════════════════════════════════════════════

/** GET /clients — all clients */
app.get("/clients", requireAuth, async (_req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT id, name, data, updated_at FROM clients ORDER BY (data->>'combined')::int ASC NULLS LAST"
    );
    res.json(rows.map(r => ({ ...r.data, id: r.id, name: r.name, updatedAt: r.updated_at })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** PUT /clients/:id — upsert a single client */
app.put("/clients/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const data   = req.body;
  const name   = data.name || id;
  try {
    await db.query(`
      INSERT INTO clients (id, name, data, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name,
            data = EXCLUDED.data,
            updated_at = NOW()
    `, [id, name, JSON.stringify(data)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** PUT /clients/:id/lead — reassign lead only */
app.put("/clients/:id/lead", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { lead } = req.body;
  try {
    await db.query(`
      UPDATE clients
      SET data = jsonb_set(data, '{lead}', $1::jsonb),
          updated_at = NOW()
      WHERE id = $2
    `, [JSON.stringify(lead), id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /clients/:id */
app.delete("/clients/:id", requireAuth, async (req, res) => {
  try {
    await db.query("DELETE FROM clients WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /clients/bulk — upsert many at once (after a scan) */
app.post("/clients/bulk", requireAuth, async (req, res) => {
  const { clients, leadEmail, leadName } = req.body;
  if (!Array.isArray(clients)) return res.status(400).json({ error: "clients must be an array" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const c of clients) {
      await client.query(`
        INSERT INTO clients (id, name, data, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (id) DO UPDATE
          SET name = EXCLUDED.name,
              data = clients.data || EXCLUDED.data,
              updated_at = NOW()
      `, [c.id, c.name, JSON.stringify(c)]);
    }
    await client.query(
      "INSERT INTO scan_log (lead_name, lead_email, client_ct) VALUES ($1, $2, $3)",
      [leadName, leadEmail, clients.length]
    );
    await client.query("COMMIT");
    res.json({ ok: true, saved: clients.length });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE API ROUTES  (all calls via service account — no client tokens needed)
// ══════════════════════════════════════════════════════════════════════════════

/** GET /google/sites — list all GSC sites the service account can access */
app.get("/google/sites", requireAuth, async (_req, res) => {
  try {
    const auth = getServiceAuth(["https://www.googleapis.com/auth/webmasters.readonly"]);
    if (!auth) return res.status(503).json({ error: "Service account not configured" });
    const wm   = google.webmasters({ version:"v3", auth });
    const resp = await wm.sites.list();
    const sites = (resp.data.siteEntry || [])
      .filter(s => s.permissionLevel !== "siteUnverifiedUser");
    res.json(sites);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /google/ga4 — list all GA4 properties the service account can access */
app.get("/google/ga4", requireAuth, async (_req, res) => {
  try {
    const auth  = getServiceAuth(["https://www.googleapis.com/auth/analytics.readonly"]);
    if (!auth) return res.status(503).json({ error: "Service account not configured" });
    const admin = google.analyticsadmin({ version:"v1beta", auth });
    const resp  = await admin.accountSummaries.list();
    const props = [];
    for (const acc of resp.data.accountSummaries || []) {
      for (const p of acc.propertySummaries || []) {
        props.push({
          id:      p.property.replace("properties/",""),
          name:    p.displayName,
          account: acc.displayName,
          full:    `${acc.displayName} › ${p.displayName}`,
        });
      }
    }
    res.json(props);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /google/gsc — query Search Console for a site */
app.post("/google/gsc", requireAuth, async (req, res) => {
  const { siteUrl, startDate, endDate } = req.body;
  if (!siteUrl) return res.status(400).json({ error: "siteUrl required" });
  try {
    const auth = getServiceAuth(["https://www.googleapis.com/auth/webmasters.readonly"]);
    if (!auth) return res.status(503).json({ error: "Service account not configured" });
    const wm   = google.webmasters({ version:"v3", auth });
    const resp = await wm.searchanalytics.query({
      siteUrl,
      requestBody: { startDate, endDate, dimensions: [], rowLimit: 1 },
    });
    const row = resp.data.rows?.[0];
    res.json(row
      ? { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr * 100, position: row.position }
      : { clicks: 0, impressions: 0, ctr: 0, position: 0 }
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /google/ga4/report — run a GA4 report */
app.post("/google/ga4/report", requireAuth, async (req, res) => {
  const { propertyId, startDate, endDate } = req.body;
  if (!propertyId) return res.status(400).json({ error: "propertyId required" });
  try {
    const auth = getServiceAuth(["https://www.googleapis.com/auth/analytics.readonly"]);
    if (!auth) return res.status(503).json({ error: "Service account not configured" });
    const ga4  = google.analyticsdata({ version:"v1beta", auth });
    const resp = await ga4.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name:"sessions" },
          { name:"organicGoogleSearchSessions" },
          { name:"totalRevenue" },
          { name:"conversions" },
        ],
      },
    });
    const mv = resp.data.rows?.[0]?.metricValues;
    res.json(mv
      ? { sessions: +mv[0].value, organicSessions: +mv[1].value, revenue: +mv[2].value, conversions: +mv[3].value }
      : { sessions: 0, organicSessions: 0, revenue: 0, conversions: 0 }
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /google/gmail/messages — list message IDs */
app.post("/google/gmail/messages", requireAuth, async (req, res) => {
  const { userEmail, daysBack, limit, pageToken } = req.body;
  if (!userEmail) return res.status(400).json({ error: "userEmail required" });
  try {
    // Use domain-wide delegation — the service account acts as the user
    const auth  = getServiceAuth(["https://www.googleapis.com/auth/gmail.readonly"]);
    if (!auth) return res.status(503).json({ error: "Service account not configured" });
    // Subject impersonation for domain-wide delegation
    auth.subject = userEmail;
    const gmail  = google.gmail({ version:"v1", auth });
    const after  = Math.floor((Date.now() - (daysBack||90)*86400000)/1000);
    const resp   = await gmail.users.messages.list({
      userId:    "me",
      q:         `in:inbox after:${after}`,
      maxResults: Math.min(limit || 500, 500),
      pageToken:  pageToken || undefined,
    });
    res.json({ messages: resp.data.messages || [], nextPageToken: resp.data.nextPageToken });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /google/gmail/message — get a single message */
app.post("/google/gmail/message", requireAuth, async (req, res) => {
  const { userEmail, messageId } = req.body;
  if (!userEmail || !messageId) return res.status(400).json({ error: "userEmail and messageId required" });
  try {
    const auth = getServiceAuth(["https://www.googleapis.com/auth/gmail.readonly"]);
    if (!auth) return res.status(503).json({ error: "Service account not configured" });
    auth.subject = userEmail;
    const gmail = google.gmail({ version:"v1", auth });
    const resp  = await gmail.users.messages.get({ userId:"me", id:messageId, format:"full" });
    res.json(resp.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ANTHROPIC PROXY
// ══════════════════════════════════════════════════════════════════════════════
app.post("/api/anthropic/v1/messages", requireAuth, async (req, res) => {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        "x-api-key":       process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: "Anthropic proxy error", message: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀  CT React backend running on port ${PORT}`);
    console.log(`    Allowed origin:  ${ALLOWED_ORIGIN}`);
    console.log(`    Allowed domain:  @${ALLOWED_DOMAIN}`);
    console.log(`    Anthropic key:   ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗ MISSING"}`);
    console.log(`    Service account: ${serviceAccountKey?.client_email || "✗ MISSING"}`);
    console.log(`    Database:        ${process.env.DATABASE_URL ? "✓" : "✗ MISSING"}\n`);
  });
}).catch(e => {
  console.error("Failed to initialize database:", e.message);
  process.exit(1);
});
