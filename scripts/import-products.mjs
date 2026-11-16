#!/usr/bin/env node
/* Loads products from a Shopify-format CSV (like ruvico-shopify-products.csv) into Supabase,
   copying each product photo into your Supabase storage as a small, fast WebP.

   Usage (from the project folder, after `npm install`):
     SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/import-products.mjs ~/Downloads/ruvico-shopify-products.csv
   Options:
     --no-images   load products without photos (much faster; add photos later from the admin)
   Safe to run again: products that already have a photo are skipped for photos, and data is updated in place.
   Products you have edited in the admin are not overwritten unless you add --overwrite. */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const NO_IMAGES = args.includes("--no-images"), OVERWRITE = args.includes("--overwrite");
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!file || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-products.mjs path/to/products.csv [--no-images] [--overwrite]");
  process.exit(1);
}
let sharp = null;
if (!NO_IMAGES) { try { sharp = (await import("sharp")).default; } catch { console.warn("Photo resizing (sharp) isn't installed; photos are copied at original size. Run npm install to fix."); } }
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BUCKET = "product-images";

function parseCSV(t) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}
const SEC = { "fresh grocery": "grocery", meat: "meat", "dry items": "dry", fridge: "fridge", freezer: "freezer", "household & pooja": "household" };
const FLAG = { "nepali favourite": "nepali", halal: "halal", vegetarian: "veg" };
const text = (h) => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

const rows = parseCSV(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
const H = rows[0].map((h) => h.trim()); const ix = (k) => H.indexOf(k);
const g = (r, k) => (ix(k) < 0 ? "" : (r[ix(k)] || "").trim());
const byHandle = new Map();
for (const r of rows.slice(1)) { const h = g(r, "Handle"); if (!h) continue; if (!byHandle.has(h)) byHandle.set(h, []); byHandle.get(h).push(r); }

const products = [];
for (const [handle, rs] of byHandle) {
  const first = rs[0];
  const id = handle.split("-").pop();
  const tags = g(first, "Tags").split(",").map((t) => t.trim()).filter(Boolean);
  const type = g(first, "Type");
  const variants = rs.filter((r) => g(r, "Variant Price"));
  const perKg = g(first, "Option1 Name") === "Weight";
  const v = perKg ? (variants.find((r) => g(r, "Option1 Value") === "1kg") || variants[0]) : variants[0];
  if (!v) continue;
  const price = +g(v, "Variant Price"), compare = +g(v, "Variant Compare At Price") || 0;
  const images = rs.map((r) => g(r, "Image Src")).filter(Boolean);
  products.push({
    id, images,
    data: {
      name: g(first, "Title"), brand: g(first, "Vendor"), size: "", sku: g(v, "Variant SKU"),
      sec: SEC[type.toLowerCase()] || "dry", sub: tags.find((t) => t !== type && !FLAG[t.toLowerCase()] && !t.startsWith("zone-")) || "Other",
      regular: compare > price ? compare : price, special: compare > price ? price : null, saleEnds: "",
      tags: [...new Set(tags.map((t) => FLAG[t.toLowerCase()]).filter(Boolean))],
      perKg, weights: "500g=0.5, 1kg=1, 2kg=2", short: "", desc: text(g(first, "Body (HTML)")),
      stock: g(first, "Status") !== "draft", qty: null, maxQty: null, photos: [], hidden: false, featured: false, sort: 0, badge: "", zone: "", custom: true
    }
  });
}
console.log(`Read ${products.length} products from ${file}`);

const existing = new Map();
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("products").select("id,data").range(from, from + 999);
  if (error) { console.error("Couldn't read the products table. Did you run supabase/schema.sql?", error.message); process.exit(1); }
  data.forEach((r) => existing.set(r.id, r.data));
  if (data.length < 1000) break;
}

async function copyPhoto(p) {
  const prev = existing.get(p.id);
  if (prev && prev.photos && prev.photos.length) return prev.photos;
  const out = [];
  for (const [i, url] of p.images.slice(0, 4).entries()) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      let buf = Buffer.from(await res.arrayBuffer()), type = res.headers.get("content-type") || "image/jpeg", ext = "jpg";
      if (sharp) { buf = await sharp(buf).rotate().resize(800, 800, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(); type = "image/webp"; ext = "webp"; }
      const path = `catalog/${p.id}-${i + 1}.${ext}`;
      const up = await sb.storage.from(BUCKET).upload(path, buf, { contentType: type, upsert: true, cacheControl: "31536000" });
      if (up.error) { console.warn(`  photo upload failed for ${p.data.name}: ${up.error.message}`); continue; }
      out.push({ id: path, url: sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl });
    } catch (e) { /* skip this photo */ }
  }
  return out;
}

let done = 0, skipped = 0, photos = 0;
const queue = products.filter((p) => { const prev = existing.get(p.id); if (prev && prev.updatedAt && !OVERWRITE) { skipped++; return false; } return true; });
const batch = [];
async function flush() {
  if (!batch.length) return;
  const rowsOut = batch.splice(0, batch.length);
  const { error } = await sb.from("products").upsert(rowsOut);
  if (error) console.error("  save failed:", error.message);
}
let idx = 0;
await Promise.all(Array.from({ length: NO_IMAGES ? 1 : 6 }, async () => {
  while (idx < queue.length) {
    const p = queue[idx++];
    const prev = existing.get(p.id);
    const data = { ...p.data };
    if (prev && prev.photos && prev.photos.length) data.photos = prev.photos;
    else if (!NO_IMAGES && p.images.length) { data.photos = await copyPhoto(p); if (data.photos.length) photos++; }
    batch.push({ id: p.id, data, updated_at: new Date().toISOString() });
    if (batch.length >= 200) await flush();
    if (++done % 100 === 0) console.log(`  ${done} of ${queue.length} saved (${photos} with new photos)`);
  }
}));
await flush();
console.log(`Finished: ${done} products saved, ${photos} photos copied${skipped ? `, ${skipped} skipped because you've edited them in the admin (use --overwrite to replace)` : ""}.`);
