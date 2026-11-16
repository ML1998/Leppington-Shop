# Leppington Nepalese and Indian Grocery: online shop

## Live now on GitHub Pages

The website is in the `docs` folder. GitHub Pages serves it: Settings → Pages → Deploy from a branch → `main` / `docs`.

- As uploaded it runs in **demo mode**: the 75 starter products, with orders kept on the customer's device.
- Put your Supabase URL and anon key in `docs/config.js` (keep `checkoutServer: false`) and it goes **live**: the full catalogue, the admin, and real orders paid on delivery, at the counter or by PayID.
- Square card payments need the checkout server, so they arrive with the move to Cloudflare Pages (below). When you move, set `checkoutServer: true`.

---

Your shop runs on three services:

| Service | What it does | Cost to start |
|---|---|---|
| **Cloudflare Pages** | Hosts the website at leppington.shop and runs the checkout server (`functions/api/order.js`) | Free plan |
| **Supabase** | Stores products, photos, settings, orders and staff logins | Free plan (500 MB database, 1 GB photo storage) |
| **Square** | Takes card payments online | No monthly fee; per-transaction fees |

Customers can pay by card online (Square), by card or cash on delivery or at the counter, or by PayID.
Every order goes through the checkout server, which re-checks prices, stock, delivery postcode and promo codes against the database before charging anything.

## What's in this folder

```
docs/              the website (GitHub Pages serves this folder)
  index.html       shop + admin (Admin link appears at the top right for staff)
  config.js        your public keys (edit this)
  runtime.js       connects the site to Supabase and the checkout server
  logo.svg, logo-mark.svg
functions/api/order.js   checkout server: price checks + Square payments
supabase/schema.sql      tables, security rules, photo storage
supabase/seed-starter.sql the 75 starter products with drawn pack images
scripts/import-products.mjs  loads the big product CSV and copies the photos
```

You need [Node.js 18 or newer](https://nodejs.org) on your computer for steps 3 and 5.

---

## 1. Supabase (database, photos, staff login)

1. Sign up at supabase.com and **create a project**. Choose the **Sydney** region and save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. New query again: paste `supabase/seed-starter.sql` and **Run**. This adds the 75 starter products.
4. **Authentication → Users → Add user**: create your staff login (email + password, tick "Auto confirm").
5. Make that login an admin. In SQL Editor run (with your email):
   ```sql
   insert into public.admins (user_id, email) select id, email from auth.users where email = 'you@example.com';
   ```
6. **Project Settings → API**: copy the **Project URL**, the **anon public** key and the **service_role** key.
   - Put the URL and anon key in `docs/config.js`.
   - Keep the service_role key secret. It's used in steps 3 and 5 only, never in the website files.
7. **Authentication → URL Configuration**: set Site URL to `https://leppington.shop`.

## 2. Square (card payments)

1. Sign up at developer.squareup.com with your Square account and **create an application**.
2. Start in **Sandbox** (test mode). From the app's **Credentials** page copy the **Sandbox Application ID** and **Sandbox Access token**. From **Locations** copy the **Location ID**.
3. In `docs/config.js` fill in `appId` and `locationId` (leave `env: "sandbox"`).
4. The access token goes into Cloudflare in step 5, never into `config.js`.

The "Pay now by card" option only appears at checkout once `appId` and `locationId` are filled in.

## 3. Load the 5,714 products

From this folder in a terminal:

```bash
npm install
SUPABASE_URL=https://YOUR-PROJECT-ID.supabase.co SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
  node scripts/import-products.mjs ~/Downloads/ruvico-shopify-products.csv
```

(On Windows PowerShell set the two variables first with `$env:SUPABASE_URL="..."` and `$env:SUPABASE_SERVICE_ROLE_KEY="..."`.)

It copies each photo into your Supabase storage, shrunk to a fast-loading WebP (about 250 MB for all photos). Expect 20 to 40 minutes. If it stops, run it again; it carries on where it left off.
Add `--no-images` to load products in a minute without photos.

## 4. Domain

If you don't own **leppington.shop** yet, register it (Cloudflare Registrar or any registrar), then add it to your Cloudflare account so Cloudflare manages its DNS.

## 5. Put the site online (Cloudflare Pages)

The checkout server only deploys through Wrangler or Git. The dashboard's drag-and-drop upload skips it, so use these commands:

```bash
npx wrangler login
npx wrangler pages project create leppington-shop --production-branch main
npm run deploy
```

Then add the secrets (each command asks you to paste the value):

```bash
npx wrangler pages secret put SUPABASE_URL --project-name leppington-shop
npx wrangler pages secret put SUPABASE_SERVICE_ROLE_KEY --project-name leppington-shop
npx wrangler pages secret put SQUARE_ACCESS_TOKEN --project-name leppington-shop
npx wrangler pages secret put SQUARE_LOCATION_ID --project-name leppington-shop
npx wrangler pages secret put SQUARE_ENV --project-name leppington-shop     # type: sandbox
npm run deploy
```

Finally, in the Cloudflare dashboard: **Workers & Pages → leppington-shop → Custom domains → Set up a custom domain** and add `leppington.shop` (and `www.leppington.shop` if you want it).

## 6. Test, then go live

1. Open the site, add a few items, and check out with **Pay now by card** using Square's test card `4111 1111 1111 1111`, any future expiry, CVV `111` and postcode `2179`.
2. Click **Admin** at the top right, sign in with your staff login, and check the order arrived under **Orders**.
3. In **Admin → Store settings** set your real phone, address, hours, delivery postcodes and fees.
4. To take real payments, switch Square to **Production**:
   - copy the production Application ID and Location ID into `config.js` and set `env: "production"`
   - update the secrets `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID` and `SQUARE_ENV=production`
   - run `npm run deploy`

## Day to day

Everything is managed in **Admin** on the live site: products, photos, prices, specials, stock, sections, homepage banners, delivery rules, promo codes, orders, and CSV export/import for bulk price changes. No code changes needed.

To add another staff member: create their login in Supabase (step 1.4) and run the admin SQL (step 1.5) with their email.

## Before launch

- **GST:** basic food (fresh produce, meat, rice, dal and similar) is usually GST-free in Australia, while snacks, drinks and confectionery are taxable. Square reports the totals you charge; check with your accountant how you record GST.
- **Refunds:** refund online card payments from your Square Dashboard, using the order number shown in Admin → Orders.
