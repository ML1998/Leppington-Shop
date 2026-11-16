/* Leppington Grocery: connects the shop to Supabase (products, settings, orders, photos, staff login)
   and to the checkout server (/api/order), which checks prices and takes Square card payments. */
(function () {
  var C = window.LEPP_CONFIG || {};
  var configured = window.supabase && C.supabaseUrl && C.supabaseAnonKey && !/YOUR-/.test(C.supabaseUrl + C.supabaseAnonKey);
  // Without Supabase the site runs as a demo with the starter range; orders stay on the customer's device.
  if (!configured) { console.info("Demo mode: add your Supabase details to config.js to go live."); return; }
  window.LEPP_HOSTED = true;
  // Online card payments need the checkout server (Cloudflare). On GitHub Pages leave checkoutServer false.
  if (C.checkoutServer && C.square && C.square.appId && C.square.locationId) window.LEPP_SQUARE = C.square;
  var sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey);
  var BUCKET = "product-images";

  async function fetchAll(table, order) {
    var out = [], from = 0;
    for (;;) {
      var q = sb.from(table).select("id,data");
      if (order) q = q.order(order.col, { ascending: order.asc });
      q = q.range(from, from + 999);
      var res = await q;
      if (res.error) throw res.error;
      out.push.apply(out, res.data);
      if (res.data.length < 1000) break;
      from += 1000;
    }
    return out;
  }
  function live(table, fn) {
    var t, ch = sb.channel("rt-" + table + "-" + Math.random().toString(36).slice(2))
      .on("postgres_changes", { event: "*", schema: "public", table: table }, function () { clearTimeout(t); t = setTimeout(fn, 400); })
      .subscribe();
    return function () { sb.removeChannel(ch); };
  }
  function snap(rows) { return { size: rows.length, docs: rows.map(function (r) { return { id: r.id, exists: true, data: function () { return r.data; } }; }) }; }
  function coll(name, order, lim) {
    return {
      orderBy: function (f, dir) { return coll(name, { col: f === "createdAt" ? "created_at" : f, asc: dir !== "desc" }, lim); },
      limit: function (n) { return coll(name, order, n); },
      doc: function (id) { return docRef(name, id); },
      onSnapshot: function (cb, err) {
        var run = function () { fetchAll(name, order).then(function (r) { cb(snap(lim ? r.slice(0, lim) : r)); }).catch(function (e) { err && err(e); }); };
        run(); return live(name, run);
      }
    };
  }
  function docRef(table, id) {
    if (id === undefined) { var i = table.indexOf("/"); id = table.slice(i + 1); table = table.slice(0, i); }
    async function read() { var r = await sb.from(table).select("id,data").eq("id", id).maybeSingle(); if (r.error) throw r.error; return r.data; }
    return {
      get: async function () { var d = await read(); return { id: id, exists: !!d, data: function () { return d && d.data; } }; },
      onSnapshot: function (cb, err) {
        var run = function () { read().then(function (d) { cb({ id: id, exists: !!d, data: function () { return d && d.data; } }); }).catch(function (e) { err && err(e); }); };
        run(); return live(table, run);
      },
      set: async function (data) { var r = await sb.from(table).upsert({ id: id, data: data, updated_at: new Date().toISOString() }); if (r.error) throw r.error; },
      update: async function (patch) {
        var cur = await read(); var data = Object.assign({}, cur && cur.data, patch); var row = { data: data };
        if (table === "orders" && patch.status) row.status = patch.status; else row.updated_at = new Date().toISOString();
        var r = await sb.from(table).update(row).eq("id", id); if (r.error) throw r.error;
      },
      delete: async function () { var r = await sb.from(table).delete().eq("id", id); if (r.error) throw r.error; }
    };
  }
  var db = { collection: function (n) { return coll(n); }, doc: function (p) { return docRef(p); } };

  var auth = {
    email: null,
    signIn: async function (email, password) {
      var r = await sb.auth.signInWithPassword({ email: email, password: password });
      if (r.error) throw new Error(/invalid/i.test(r.error.message) ? "That email and password don't match." : r.error.message);
    },
    signOut: function () { return sb.auth.signOut(); }
  };
  var user = {
    canEdit: async function () {
      var s = (await sb.auth.getSession()).data.session; if (!s) return false;
      auth.email = s.user.email;
      var r = await sb.from("admins").select("user_id").eq("user_id", s.user.id).maybeSingle();
      return !!(r.data);
    },
    isOwner: function () { return user.canEdit(); }
  };
  var assets = {
    upload: async function (file) {
      var ext = ((file.name || "").split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      var path = "uploads/" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
      var r = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || "image/jpeg", cacheControl: "31536000" });
      if (r.error) throw { code: "failed", message: r.error.message };
      return { id: path, url: sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl };
    },
    delete: async function (id) { await sb.storage.from(BUCKET).remove([id]); return { deleted: true }; }
  };
  var downloads = {
    save: async function (req) {
      var blob = req.data instanceof Blob ? req.data : new Blob([req.data], { type: "text/csv" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = req.filename; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      return { status: "saved" };
    }
  };
  var caps = { db: db, user: user, assets: assets, downloads: downloads };
  window.LEPP_RT = { auth: auth, use: async function (n) { return caps[n] || null; } };

  window.LEPP_API = {
    placeOrder: async function (order, sourceId) {
      if (!C.checkoutServer) {
        // Static hosting (GitHub Pages): save the order straight to the database. Prices are checked by staff when packing.
        var o = Object.assign({}, order, { status: "new", paid: false, priceChecked: false });
        var r = await sb.from("orders").insert({ id: o.no, data: o, status: "new" });
        if (r.error) throw { message: "We couldn't place your order just now. Try again, or call us." };
        return { ok: true, order: { no: o.no } };
      }
      var res = await fetch("api/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order: order, sourceId: sourceId }) });
      var j = {}; try { j = await res.json(); } catch (e) {}
      if (!res.ok || !j.ok) throw { message: j.error || "We couldn't place your order. Try again, or call us." };
      return j;
    }
  };
})();
