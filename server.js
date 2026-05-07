import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import multer from "multer";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import archiver from "archiver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const LISTINGS_FILE = path.join(DATA_DIR, "listings.json");
const PURCHASES_FILE = path.join(DATA_DIR, "purchases.json");

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-change-me";
const QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_PRICE_USD = 5;

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();

const paypalClientId = process.env.PAYPAL_CLIENT_ID || "";
const paypalClientSecret = process.env.PAYPAL_CLIENT_SECRET || "";
const paypalSandbox = process.env.PAYPAL_SANDBOX !== "false";

const PAYPAL_API = paypalSandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";

function ensureDirs() {
  for (const d of [DATA_DIR, UPLOADS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function loadUsers() {
  return readJson(USERS_FILE, []);
}
function saveUsers(users) {
  writeJson(USERS_FILE, users);
}
function loadListingsRaw() {
  return readJson(LISTINGS_FILE, []);
}
function saveListings(listings) {
  writeJson(LISTINGS_FILE, listings);
}
function loadPurchases() {
  return readJson(PURCHASES_FILE, []);
}
function savePurchases(rows) {
  writeJson(PURCHASES_FILE, rows);
}

function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function findUserByEmail(email) {
  return loadUsers().find((u) => u.email.toLowerCase() === String(email).toLowerCase());
}

function findUserById(id) {
  return loadUsers().find((u) => u.id === id);
}

function isAdminUser(req) {
  if (!ADMIN_EMAIL) return false;
  const u = findUserById(req.user.sub);
  return u && u.email.toLowerCase() === ADMIN_EMAIL;
}

/** Normalize legacy single-file listings to { files: [...] } */
function normalizeListing(l) {
  if (!l) return null;
  if (Array.isArray(l.files) && l.files.length > 0) {
    const totalSize = l.files.reduce((s, f) => s + (Number(f.size) || 0), 0);
    return { ...l, files: l.files, size: totalSize };
  }
  if (l.storedName) {
    const files = [
      {
        storedName: l.storedName,
        fileName: l.fileName || "file",
        size: Number(l.size) || 0,
        mimeType: l.mimeType || "application/octet-stream",
      },
    ];
    return { ...l, files, size: files.reduce((s, f) => s + f.size, 0) };
  }
  return { ...l, files: [], size: 0 };
}

function loadListings() {
  return loadListingsRaw().map(normalizeListing);
}

function listingToPublic(l) {
  const n = normalizeListing(l);
  if (!n) return null;
  const fc = n.files?.length || 0;
  return {
    id: n.id,
    ownerId: n.ownerId,
    ownerEmail: n.ownerEmail,
    title: n.title,
    fileCount: fc,
    fileName: fc > 1 ? fc + " files" : n.files[0]?.fileName || "file",
    size: n.size,
    priceUsd: typeof n.priceUsd === "number" ? n.priceUsd : 0,
    createdAt: n.createdAt,
    downloadCount: n.downloadCount || 0,
  };
}

function listingOwnerUsedBytes(ownerId) {
  return loadListings()
    .filter((l) => l.ownerId === ownerId)
    .reduce((s, l) => s + (Number(l.size) || 0), 0);
}

async function paypalAccessToken() {
  if (!paypalClientId || !paypalClientSecret) throw new Error("PayPal credentials missing");
  const auth = Buffer.from(`${paypalClientId}:${paypalClientSecret}`).toString("base64");
  const r = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || "PayPal auth failed");
  return j.access_token;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safe = crypto.randomBytes(16).toString("hex") + path.extname(file.originalname || "");
      cb(null, safe);
    },
  }),
  limits: { fileSize: QUOTA_BYTES },
});

ensureDirs();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/config", (_req, res) => {
  res.json({
    payments: "paypal",
    paypalConfigured: Boolean(paypalClientId && paypalClientSecret),
    adminConfigured: Boolean(ADMIN_EMAIL),
  });
});

app.post("/api/register", (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    if (findUserByEmail(email)) return res.status(409).json({ error: "Email already registered" });

    const user = {
      id: uuidv4(),
      email: String(email).trim().toLowerCase(),
      passwordHash: bcrypt.hashSync(String(password), 10),
      createdAt: Date.now(),
    };

    const users = loadUsers();
    users.push(user);
    saveUsers(users);

    const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = findUserByEmail(email);
  if (!user || !bcrypt.compareSync(String(password || ""), user.passwordHash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
  res.json({
    token,
    user: { id: user.id, email: user.email },
  });
});

app.get("/api/me", authMiddleware, (req, res) => {
  const user = findUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: "User gone" });
  res.json({
    id: user.id,
    email: user.email,
    isAdmin: isAdminUser(req),
  });
});

app.get("/api/me/purchases", authMiddleware, (req, res) => {
  const ids = loadPurchases().filter((p) => p.buyerId === req.user.sub).map((p) => p.listingId);
  res.json({ listingIds: ids });
});

function deleteListingFiles(listing) {
  const n = normalizeListing(listing);
  for (const f of n.files || []) {
    const fp = path.join(UPLOADS_DIR, f.storedName);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
}

app.post("/api/listings", authMiddleware, upload.array("files", 200), (req, res) => {
  const files = req.files || [];
  try {
    const user = findUserById(req.user.sub);
    if (!user) return res.status(401).json({ error: "User not found" });
    if (files.length === 0) return res.status(400).json({ error: "At least one file required" });

    const title = String(req.body.title || "").trim();
    const priceUsd = Math.min(MAX_PRICE_USD, Math.max(0, Math.round(Number(req.body.priceUsd) || 0)));
    if (title.length < 2) {
      for (const f of files) if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      return res.status(400).json({ error: "Title too short" });
    }

    let batchSum = 0;
    const fileRows = [];
    for (const f of files) {
      const sz = f.size || 0;
      if (sz > QUOTA_BYTES) {
        for (const x of files) if (x.path && fs.existsSync(x.path)) fs.unlinkSync(x.path);
        return res.status(400).json({ error: "A single file cannot exceed 5 GB" });
      }
      batchSum += sz;
      fileRows.push({
        storedName: path.basename(f.path),
        fileName: f.originalname || "file",
        size: sz,
        mimeType: f.mimetype || "application/octet-stream",
      });
    }

    if (batchSum > QUOTA_BYTES) {
      for (const f of files) if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      return res.status(400).json({ error: "These files add up to more than 5 GB. Remove some or upload a smaller set." });
    }

    const used = listingOwnerUsedBytes(user.id);
    if (used + batchSum > QUOTA_BYTES) {
      for (const f of files) if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      return res.status(400).json({ error: "Exceeds 5 GB total storage for your account" });
    }

    const listing = {
      id: uuidv4(),
      ownerId: user.id,
      ownerEmail: user.email,
      title,
      files: fileRows,
      size: batchSum,
      priceUsd,
      createdAt: Date.now(),
      downloadCount: 0,
    };

    const listings = loadListingsRaw();
    listings.push(listing);
    saveListings(listings);

    res.json({ listing: listingToPublic(listing) });
  } catch (e) {
    console.error(e);
    for (const f of files) if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
    res.status(500).json({ error: "Publish failed" });
  }
});

app.get("/api/listings", (_req, res) => {
  res.json(loadListings().map(listingToPublic));
});

app.delete("/api/listings/:id", authMiddleware, (req, res) => {
  const listings = loadListingsRaw();
  const idx = listings.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  const raw = listings[idx];
  const l = normalizeListing(raw);
  const owner = l.ownerId === req.user.sub;
  const admin = isAdminUser(req);
  if (!owner && !admin) return res.status(403).json({ error: "Only the owner or the admin can remove this listing" });

  deleteListingFiles(l);
  listings.splice(idx, 1);
  saveListings(listings);
  const purchases = loadPurchases().filter((p) => p.listingId !== l.id);
  savePurchases(purchases);
  res.json({ ok: true });
});

function hasPurchase(buyerId, listingId) {
  return loadPurchases().some((p) => p.buyerId === buyerId && p.listingId === listingId);
}

function canAccessDownload(listing, buyerId) {
  const n = normalizeListing(listing);
  if (!n) return false;
  if (n.ownerId === buyerId) return true;
  const price = typeof n.priceUsd === "number" ? n.priceUsd : 0;
  if (price === 0) return true;
  return hasPurchase(buyerId, n.id);
}

app.get("/api/listings/:id/download", authMiddleware, (req, res) => {
  const raw = loadListingsRaw().find((l) => l.id === req.params.id);
  const listing = normalizeListing(raw);
  if (!listing || !listing.files?.length) return res.status(404).json({ error: "Not found" });
  const buyerId = req.user.sub;
  if (!canAccessDownload(listing, buyerId)) return res.status(403).json({ error: "Purchase required" });

  for (const f of listing.files) {
    const fp = path.join(UPLOADS_DIR, f.storedName);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: "File missing: " + f.fileName });
  }

  const all = loadListingsRaw();
  const idx = all.findIndex((x) => x.id === listing.id);
  if (idx !== -1) {
    all[idx].downloadCount = (Number(all[idx].downloadCount) || 0) + 1;
    saveListings(all);
  }

  if (listing.files.length === 1) {
    const f = listing.files[0];
    return res.download(path.join(UPLOADS_DIR, f.storedName), f.fileName);
  }

  const safeTitle = (listing.title || "files").replace(/[^\w\-]+/g, "_").slice(0, 80);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="' + safeTitle + '.zip"');

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);
  for (const f of listing.files) {
    archive.file(path.join(UPLOADS_DIR, f.storedName), { name: f.fileName });
  }
  archive.finalize();
});

app.post("/api/paypal/create-order", authMiddleware, async (req, res) => {
  const { listingId } = req.body || {};
  const raw = loadListingsRaw().find((l) => l.id === listingId);
  const listing = normalizeListing(raw);
  if (!listing) return res.status(404).json({ error: "Listing not found" });

  const buyer = findUserById(req.user.sub);
  if (!buyer) return res.status(401).json({ error: "User not found" });
  if (listing.ownerId === buyer.id) return res.status(400).json({ error: "You own this listing" });

  const price = typeof listing.priceUsd === "number" ? listing.priceUsd : 0;
  if (price === 0) return res.status(400).json({ error: "This listing is free — use Download" });
  if (hasPurchase(buyer.id, listing.id)) return res.status(400).json({ error: "Already purchased" });

  if (!paypalClientId || !paypalClientSecret) {
    return res.status(503).json({ error: "PayPal is not configured (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env)" });
  }

  try {
    const access = await paypalAccessToken();
    const value = price.toFixed(2);
    const r = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + access,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: listing.id,
            custom_id: buyer.id + "|" + listing.id,
            description: listing.title.slice(0, 120),
            amount: { currency_code: "USD", value },
          },
        ],
        application_context: {
          brand_name: "FileHub",
          landing_page: "NO_PREFERENCE",
          user_action: "PAY_NOW",
          return_url: `${baseUrl(req)}/website.html?checkout=paypal_success`,
          cancel_url: `${baseUrl(req)}/website.html?checkout=paypal_cancel`,
        },
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      const msg = j.message || j.name || JSON.stringify(j);
      return res.status(500).json({ error: msg });
    }
    const approve = (j.links || []).find((l) => l.rel === "approve" || l.href?.includes("token="));
    if (!approve?.href) return res.status(500).json({ error: "No PayPal approval URL" });
    res.json({ approvalUrl: approve.href, orderId: j.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "PayPal order failed" });
  }
});

app.get("/api/paypal/capture", authMiddleware, async (req, res) => {
  const orderId = req.query.token || req.query.orderId;
  if (!orderId) return res.status(400).json({ error: "Missing order token" });

  if (!paypalClientId || !paypalClientSecret) {
    return res.status(503).json({ error: "PayPal not configured" });
  }

  try {
    const access = await paypalAccessToken();
    const r = await fetch(`${PAYPAL_API}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + access,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
    });
    const j = await r.json();
    if (!r.ok) {
      return res.status(400).json({ error: j.message || j.name || "Capture failed" });
    }

    const pu = j.purchase_units?.[0];
    const custom = pu?.payments?.captures?.[0]?.custom_id || pu?.custom_id || "";
    const parts = String(custom).split("|");
    const buyerIdFromOrder = parts[0];
    const listingId = parts[1];
    if (buyerIdFromOrder !== req.user.sub) return res.status(403).json({ error: "Wrong account for this payment" });
    if (!listingId) return res.status(400).json({ error: "Invalid order metadata" });

    const listing = normalizeListing(loadListingsRaw().find((l) => l.id === listingId));
    if (!listing) return res.status(404).json({ error: "Listing gone" });

    const amount = parseFloat(pu?.payments?.captures?.[0]?.amount?.value || listing.priceUsd) || listing.priceUsd;
    const amountCents = Math.round(amount * 100);

    const purchases = loadPurchases();
    if (!purchases.some((p) => p.buyerId === req.user.sub && p.listingId === listingId)) {
      purchases.push({
        buyerId: req.user.sub,
        listingId,
        amountCents,
        feeCents: 0,
        ownerReceivesCents: amountCents,
        provider: "paypal",
        createdAt: Date.now(),
      });
      savePurchases(purchases);
    }
    res.json({ ok: true, listingId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Capture failed" });
  }
});

app.use(express.static(__dirname));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`FileHub listening on port ${PORT}`);
  if (!paypalClientId) console.warn("Set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for paid checkout.");
  if (!ADMIN_EMAIL) console.warn("Set ADMIN_EMAIL to your Gmail to allow removing any listing.");
});
