# Logistics Dashboard

Dashboard for the logistics team. It reads orders from Shiprocket, suggests a courier from the pin code list in `data/pincodes.csv`, shows the call disposition from a Google Sheet, and ships single or bulk orders through Shiprocket.

## Run locally
1. Copy `.env.example` to `.env` and fill in the values.
2. `npm install`
3. `node --env-file=.env server.js`
4. Open http://localhost:3000

## Deploy on Railway
1. Create a new project from this GitHub repo.
2. In Variables add everything from `.env.example`. Paste the service account JSON into `GOOGLE_SERVICE_ACCOUNT_JSON`; leave `GOOGLE_KEY_FILE` unset.
3. Add a database for the shipping history and the daily report cache: in the project click **New** > **Database** > **Add PostgreSQL**. Then in the dashboard service open **Variables** > **Add Reference** and add `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`. Tables are created automatically. Without it, both are written to temporary files and are lost on every redeploy.
4. Railway runs `npm start` and gives you a public URL.

## Shipping platforms
Orders are read from Shiprocket. Each order can be shipped through Shiprocket or NimbusPost ("Ship via" at the top sets all rows; each row can override it).
- For Nimbus the shipment is built from the Shiprocket order. The customer's phone number comes from the Google Sheet, because Shiprocket masks it.
- Nimbus courier names have no Surface/Air. A pin code list entry like "Delhivery Surface" picks the cheapest Delhivery option, "Delhivery Air" the fastest one.
- An order shipped through Nimbus is hidden from Ready to ship and shows under Shipped as "SHIPPED VIA NIMBUS".

## Daily report
Shows, per day (counted by when the order was placed, not when it moved), how many orders are Booked (has
an AWB), Shipped (physically picked up), In transit, Delivered, RTO, or Not booked yet, plus a summary row
for the whole filtered range. Orders and which platform shipped them come from Nimbus's own order list
(matches Shopify's daily count); an order Nimbus shows as fulfilled elsewhere is looked up in Shiprocket for
its real status. Needs `NIMBUS_API_KEY` / `NIMBUS_API_SECRET` (Nimbus > Settings > API Keys — a different
credential from `NIMBUS_EMAIL`/`NIMBUS_PASSWORD`, which are only for shipping). A background job refreshes a
rolling 10-day window into the database every 20 minutes so the page loads instantly; a date range outside
that window is computed live on request (slow — it scans every order in the range) and cached from then on.

## Data
- `data/pincodes.csv`: `pincode,partner`, where the partner is the exact Shiprocket courier name (for example "Delhivery Surface").
