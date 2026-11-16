/* Your public settings. These keys are safe to publish (the Supabase anon key only allows what the
   database rules permit). Secret keys go in Cloudflare's environment variables, never here. */
window.LEPP_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT-ID.supabase.co",
  supabaseAnonKey: "YOUR-SUPABASE-ANON-KEY",
  // true when hosted on Cloudflare Pages (enables price-checked orders and Square card payments).
  // false on GitHub Pages, which can't run the checkout server.
  checkoutServer: false,
  square: {
    appId: "",        // e.g. sandbox-sq0idb-xxxxxxxx (Square Developer > your app > Credentials)
    locationId: "",   // e.g. LXXXXXXXXXXXX (Square Developer > Locations)
    env: "sandbox"    // change to "production" when you go live
  }
};
