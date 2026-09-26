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
3. Add a database for the shipping history: in the project click **New** > **Database** > **Add PostgreSQL**. Then in the dashboard service open **Variables** > **Add Reference** and add `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`. The table is created automatically. Without it, history is written to a temporary file and is lost on every redeploy.
4. Railway runs `npm start` and gives you a public URL.

## Shipping platforms
Orders are read from Shiprocket. Each order can be shipped through Shiprocket or NimbusPost ("Ship via" at the top sets all rows; each row can override it).
- For Nimbus the shipment is built from the Shiprocket order. The customer's phone number comes from the Google Sheet, because Shiprocket masks it.
- Nimbus courier names have no Surface/Air. A pin code list entry like "Delhivery Surface" picks the cheapest Delhivery option, "Delhivery Air" the fastest one.
- An order shipped through Nimbus is hidden from Ready to ship and shows under Shipped as "SHIPPED VIA NIMBUS".

## Data
- `data/pincodes.csv`: `pincode,partner`, where the partner is the exact Shiprocket courier name (for example "Delhivery Surface").
