/* POST /api/order  (Cloudflare Pages Function)
   Checks every price against the database, works out delivery and promo, takes the card payment
   through Square when the customer pays online, then saves the order for the staff dashboard.
   Environment variables (Cloudflare Pages > Settings > Variables and secrets):
     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENV (sandbox|production) */

const DEF = { deliveryFee: 7.99, freeOver: 60, minDelivery: 25, postcodes: "", promos: [{ code: "NAMASTE5", pct: 5, firstOnly: true, active: true }], sections: null };
const r2 = (n) => Math.round(n * 100) / 100;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (msg, status = 400) => json({ ok: false, error: msg }, status);

function parseWeights(s) {
  const out = [];
  String(s || "500g=0.5, 1kg=1, 2kg=2").split(",").forEach((t) => { const m = t.trim().match(/^(.+?)\s*=\s*([\d.]+)$/); if (m && +m[2] > 0) out.push([m[1].trim(), +m[2]]); });
  return out.length ? out : [["1kg", 1]];
}
function currentPrice(p, today) {
  const reg = +p.regular || 0, sp = p.special;
  const active = sp != null && sp !== "" && +sp > 0 && +sp < reg && (!p.saleEnds || p.saleEnds >= today);
  return active ? +sp : reg;
}
async function sb(env, path, init = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) }
  });
  if (!res.ok) throw new Error(`Database error ${res.status}: ${await res.text()}`);
  return res.status === 204 || init.method === "DELETE" || (init.headers && init.headers.Prefer === "return=minimal") ? null : res.json();
}
const clean = (v, n = 200) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return fail("The shop isn't fully set up yet. Please call us to order.", 500);
  let body;
  try { body = await request.json(); } catch { return fail("Something went wrong sending your order. Try again."); }
  const o = body.order || {};
  const items = Array.isArray(o.items) ? o.items.slice(0, 200) : [];
  if (!items.length) return fail("Your cart is empty.");
  if (!clean(o.name)) return fail("Add your name.");
  if (!/^[\d\s+()-]{8,20}$/.test(String(o.phone || ""))) return fail("Add a valid mobile number.");
  const mode = o.mode === "collect" ? "collect" : "delivery";
  const pay = ["online", "card", "cash", "payid"].includes(o.pay) ? o.pay : "card";

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
  let cfg = DEF, prods;
  try {
    const st = await sb(env, "settings?select=data&id=eq.store");
    if (st && st[0]) cfg = { ...DEF, ...st[0].data };
    const ids = [...new Set(items.map((i) => String(i.key || "").split("|")[0]).filter((x) => /^[\w-]{1,60}$/.test(x)))];
    prods = await sb(env, `products?select=id,data&id=in.(${ids.map((x) => `"${x}"`).join(",")})`);
  } catch (e) { return fail("We couldn't check prices just now. Try again in a minute.", 503); }
  const P = Object.fromEntries(prods.map((r) => [r.id, r.data]));
  const hiddenSecs = new Set((cfg.sections || []).filter((s) => !s.visible).map((s) => s.id));

  // Re-price every line from the database.
  const lines = [];
  for (const it of items) {
    const key = String(it.key || ""), bar = key.indexOf("|"), id = bar < 0 ? key : key.slice(0, bar), w = bar < 0 ? null : key.slice(bar + 1);
    const p = P[id];
    if (!p || p.hidden || p.deleted || hiddenSecs.has(p.sec)) return fail(`${clean(it.name) || "An item"} is no longer available. Remove it from your cart and try again.`, 409);
    if (p.stock === false || (p.qty != null && p.qty !== "" && +p.qty <= 0)) return fail(`${p.name} has just sold out. Remove it from your cart and try again.`, 409);
    let mult = 1;
    if (p.perKg) { const f = parseWeights(p.weights).find((x) => x[0] === w); if (!f) return fail(`Choose a weight for ${p.name} again.`, 409); mult = f[1]; }
    const qty = Math.floor(+it.qty);
    const cap = Math.min(p.maxQty ? +p.maxQty : 99, p.qty != null && p.qty !== "" ? +p.qty : 99);
    if (!(qty >= 1) || qty > cap) return fail(`You can order up to ${cap} of ${p.name}.`, 409);
    const raw = currentPrice(p, today) * mult;
    lines.push({ key, name: p.name, size: w || p.size || "", qty, unit: r2(raw), raw });
  }
  const subRaw = lines.reduce((a, l) => a + l.raw * l.qty, 0), sub = r2(subRaw);
  lines.forEach((l) => delete l.raw);
  let promo = "", pct = 0;
  if (o.promo) { const pr = (cfg.promos || []).find((x) => x.active && String(x.code).toUpperCase() === String(o.promo).toUpperCase()); if (pr) { promo = pr.code; pct = +pr.pct || 0; } }
  const discRaw = subRaw * pct / 100, disc = r2(discRaw);
  let fee = 0;
  if (mode === "delivery") {
    if (subRaw < +cfg.minDelivery) return fail(`Delivery orders start at $${(+cfg.minDelivery).toFixed(2)}.`);
    const pc = String(o.postcode || "");
    const list = String(cfg.postcodes || "").split(/[\s,]+/).filter(Boolean);
    if (!/^\d{4}$/.test(pc) || (list.length ? !list.includes(pc) : !/^2/.test(pc))) return fail("We don't deliver to that postcode yet. Try Click & Collect.");
    if (!clean(o.address) || !clean(o.suburb)) return fail("Add your street address and suburb.");
    fee = subRaw - discRaw >= +cfg.freeOver ? 0 : +cfg.deliveryFee;
  }
  const total = r2(subRaw - discRaw + fee);
  if (Math.abs(total - (+o.total || 0)) > 0.02) return fail(`Prices have changed since you filled your cart. The new total is $${total.toFixed(2)}. Refresh the page to see it, then place your order again.`, 409);

  const no = "LP" + Date.now().toString().slice(-7) + Math.floor(Math.random() * 10);
  const order = {
    no, createdAt: Date.now(), status: "new", mode, slot: clean(o.slot, 20), when: clean(o.when, 80),
    name: clean(o.name, 80), phone: clean(o.phone, 20), email: clean(o.email, 120),
    address: mode === "delivery" ? clean(o.address, 160) : "", suburb: mode === "delivery" ? clean(o.suburb, 60) : "", postcode: mode === "delivery" ? clean(o.postcode, 4) : "",
    subs: ["call", "similar", "none"].includes(o.subs) ? o.subs : "call", pay, notes: clean(o.notes, 500),
    items: lines, subtotal: sub, discount: disc, fee, total, promo, paid: false
  };

  try { await sb(env, "orders", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ id: no, data: order, status: "new" }) }); }
  catch (e) { return fail("We couldn't save your order just now. Try again in a minute.", 503); }

  if (pay === "online") {
    if (!body.sourceId) { await sb(env, `orders?id=eq.${no}`, { method: "DELETE" }).catch(() => {}); return fail("Card details are missing. Enter your card again."); }
    const base = env.SQUARE_ENV === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
    let sq, sqj = {};
    try {
      sq = await fetch(`${base}/v2/payments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`, "Square-Version": "2024-10-17", "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: body.sourceId, idempotency_key: crypto.randomUUID(), amount_money: { amount: Math.round(total * 100), currency: "AUD" }, location_id: env.SQUARE_LOCATION_ID, reference_id: no, note: `Order ${no}`, autocomplete: true })
      });
      sqj = await sq.json();
    } catch (e) { sq = null; }
    if (!sq || !sq.ok || !sqj.payment) {
      await sb(env, `orders?id=eq.${no}`, { method: "DELETE" }).catch(() => {});
      const code = sqj.errors && sqj.errors[0] && sqj.errors[0].code;
      const msg = { CARD_DECLINED: "Your card was declined. Try another card.", INSUFFICIENT_FUNDS: "Your card was declined for insufficient funds.", CVV_FAILURE: "The security code doesn't match. Check it and try again.", ADDRESS_VERIFICATION_FAILURE: "The postcode doesn't match your card. Check it and try again.", INVALID_EXPIRATION: "Check the card's expiry date.", GENERIC_DECLINE: "Your card was declined. Try another card." }[code];
      return fail(msg || "The payment didn't go through, and you haven't been charged. Try again or choose another payment option.", 402);
    }
    order.paid = true; order.paymentId = sqj.payment.id; order.receiptUrl = sqj.payment.receipt_url || "";
    await sb(env, `orders?id=eq.${no}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ data: order }) }).catch(() => {});
  }
  return json({ ok: true, order: { no, total, subtotal: sub, discount: disc, fee, items: lines, paid: order.paid, receiptUrl: order.receiptUrl || "" } });
}

