# Shukarsh Backend

Backend API for the Shukarsh e-commerce store.

## Tech Stack

- Node.js
- Express
- TypeScript
- Prisma ORM
- PostgreSQL (Supabase)
- Razorpay
- Shiprocket

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy the environment file and fill in your values:
   ```bash
   cp .env.example .env
   ```

3. Set up the database:
   ```bash
   npx prisma migrate dev --name init
   ```

4. (Optional) Seed sample data:
   ```bash
   npx prisma db seed
   ```

5. Run the development server:
   ```bash
   npm run dev
   ```

The API will be available at `http://localhost:5000`.

## Scripts

- `npm run dev` — Start development server with hot reload
- `npm run build` — Compile TypeScript
- `npm run start` — Start production server
- `npm run db:migrate` — Run Prisma migrations
- `npm run db:studio` — Open Prisma Studio

## Deployment

### Supabase Database

1. Create a free project at [supabase.com](https://supabase.com).
2. Go to Settings > Database > Connection string.
3. Copy the **URI** connection string.
4. Set it as `DATABASE_URL` in Render and locally.

### Schema changes

Migrations live in `prisma/migrations` and are committed. `prisma migrate deploy`
runs from the `prestart` script, so it happens on the way up no matter how the
host's build command is configured. That is deliberate: `render.yaml` also puts
it in `buildCommand`, but a service set up by hand in the Render dashboard does
not use the blueprint, and the schema silently not migrating is how you end up
with new code live against an old database. Running it twice costs nothing,
because applying an already-applied migration is a no-op.

A failed migration therefore stops the server from starting. That is the point:
refusing to boot is easier to spot and to fix than booting and throwing P2022 on
every request that touches the changed table.

Never use `prisma db push` against production: it changes the database without
recording a migration, and the next deploy will not know what has already been
applied.

To change the schema, edit `prisma/schema.prisma`, then:

```bash
npx prisma migrate dev --name what_changed
```

Commit the generated folder under `prisma/migrations` along with the schema.

### Render

1. Push this repo to GitHub.
2. In Render, click **New Web Service** and connect this repo.
3. Use the `render.yaml` blueprint or configure manually:
   - Build command: `npm install; npm run build`
   - Start command: `npm run start`
4. Add environment variables:
   - `DATABASE_URL` (from Supabase)
   - `JWT_SECRET` (random string)
   - `RAZORPAY_KEY_ID` (from Razorpay)
   - `RAZORPAY_KEY_SECRET` (from Razorpay)
   - `FRONTEND_URL` (your Vercel frontend URL)
   - `CORS_ORIGIN` (your Vercel frontend URL)

### Razorpay

1. Create a Razorpay account at [razorpay.com](https://razorpay.com).
2. Get your test key id and key secret from the dashboard.
3. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in your environment variables.
4. Use Razorpay test cards for testing, e.g., `5267 3181 8797 5449`.

#### Payment webhook

Set this up. The browser calls `/api/orders/verify` after a successful payment,
but that call never happens if the customer closes the tab, loses signal or the
page crashes in that moment. Razorpay would have taken the money while the order
sat on `PENDING` with stock never decremented.

1. Razorpay dashboard > **Settings > Webhooks > Add New Webhook**.
2. URL: `https://your-api-host/api/orders/webhook`
3. Secret: any long random string, also set as `RAZORPAY_WEBHOOK_SECRET`.
4. Subscribe to **payment.captured**.

Both paths converge on the same conditional update, so whichever arrives second
sees the order already paid and skips the stock decrement rather than running it
twice.

### GST

Listed prices are the MRP: the tax is already inside them. Nothing here changes
what a customer is charged, it decides how the tax already in the total gets
reported on the order, the receipt and the invoice.

`SELLER_STATE` is what splits CGST+SGST (buyer in your state) from IGST (buyer
anywhere else), so GST stays switched off until you set it. That is the right
setting until you have a GSTIN, because charging GST without one is not legal.

Each product carries its own `gstRate`, picked from the real slabs (0, 0.25, 3,
5, 12, 18, 28). New products fall back to `GST_DEFAULT_RATE`. Delivery is part
of a composite supply, so it is taxed at the rate of the highest-value item in
the order unless you set `GST_ON_SHIPPING=false`.

Every order stores its own tax breakdown and the rate that applied to each line
at the time. Slabs change and customers move house, and neither should be able
to rewrite an invoice that has already gone out. `placeOfSupply` is kept for the
same reason: GSTR-1 is filed state-wise.

`POST /api/orders/quote` prices a bag without writing anything down. The
checkout page uses it so the GST it shows comes from the same code that charges
the card.

Shiprocket is sent `tax: 0` on every line on purpose. Our `selling_price` is
already inclusive, and Shiprocket adds `tax` on top when it prints an invoice,
so any other value bills the customer's GST to them twice.

### Coupons

Managed under **Admin > Coupons**. Three kinds: a percent off (optionally
capped), a flat amount off, or free shipping. Each code can carry a minimum
spend, a total usage limit, a per-customer limit, a live window, and a
first-order-only flag.

Leave a code's categories empty and it covers the whole catalogue. Attach
categories or products and only those lines are discounted, so "25% off
dresses" leaves the rest of the bag alone. The minimum spend is then measured
against the covered lines rather than the whole bag, which is the reading a
customer expects.

A discount is split across the lines it covers in proportion to what each is
worth. That is not cosmetic: GST is charged per line at that line's own rate, so
which lines the money comes off changes what is owed. The discount is applied
before tax is worked out, because GST is due on what the customer actually pays.

Redemptions are booked when an order is confirmed, not when it is placed, so an
abandoned checkout never eats into a code's total count. The count is incremented
unconditionally at that point: by then the money has been taken, and refusing to
record it would leave a discount charged but unaccounted for.

The per-customer limit counts orders that are still awaiting payment as well as
recorded redemptions. Without that, five unpaid checkouts each carrying a
one-per-person code can all be paid afterwards and the code has been used five
times. The price of closing that is that an abandoned checkout holds that
customer's use of the code until the order is cancelled.

`usageLimit` is enforced where it can still be honoured, when the code is applied
and again before payment starts, so a busy limited code can overshoot its cap by
a use or two under concurrent checkouts.

Deleting a code that has been used switches it off instead. Redemptions are what
evidences an order's discount, and deleting the coupon would cascade them away.

`POST /api/coupons/apply` checks a code against a real bag and is what the
checkout page calls. It runs the whole quote rather than reading the coupon on
its own, so the figure it reports is the figure that will be charged.

### Email

Order confirmations and dispatch notices go out through
[Resend](https://resend.com) over its REST API, so there is no SDK to install.
Set `RESEND_API_KEY` and `EMAIL_FROM` (a sender on a domain you have verified
with Resend). Leave them unset and the store behaves exactly as before, just
without email. A send that fails is logged and never blocks a payment or a
shipment.

### Shiprocket

Shipping is optional. With no Shiprocket credentials set the store still takes
orders and simply charges nothing for delivery, so you can launch before the
courier account is approved.

1. Add a pickup address under **Settings > Pickup Addresses** and note its
   nickname and pincode.
2. Create an API user under **Settings > API > Configure**. This is a separate
   credential from your dashboard login.
3. Set `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD`, `SHIPROCKET_PICKUP_LOCATION`
   (the nickname, matched exactly) and `SHIPROCKET_PICKUP_PINCODE`.
4. Generate a long random `SHIPROCKET_WEBHOOK_TOKEN`, then under
   **Settings > API > Webhooks** point the status webhook at
   `https://your-api-host/api/logistics/webhook` and paste the same token as the
   `x-api-key` value.

Auth tokens are cached for nine days and refreshed automatically on a 401, so
normal traffic costs no extra login calls.

#### Orders that move themselves

Once a shipment has an AWB, courier scans drive the order status: Processing
becomes Shipped on dispatch and Delivered on delivery, with no clicking.

Two things do it. The webhook above is the push, and a poller is the safety net
for deliveries a webhook drops or that arrive while the service is asleep. An
order only ever moves forward, and a cancellation or return recorded by an admin
is never overwritten by a late scan.

Run the poller whichever way suits the host:

- **Always-on host:** set `TRACKING_SYNC_INTERVAL_MIN` to something like `30`.
- **Host that sleeps, or a separate scheduler:** set `CRON_SECRET` and have a
  cron job `POST /api/logistics/sync` with an `x-cron-key` header.

Admins can also press **Refresh tracking** on the orders page at any time. That
button and the orders panel share a cooldown so repeated refreshes cost no
courier calls: inside the window they answer "already up to date" instead.
Set `TRACKING_SYNC_MIN_GAP_SEC` to change it from the default 300 seconds. The
cron path ignores the cooldown and always does the work.

#### Logistics endpoints

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/logistics/config` | Public | Whether live shipping is on |
| POST | `/api/logistics/rates` | Public | Courier options for a cart and pincode |
| GET | `/api/logistics/pincode/:pincode` | Public | City and state autofill |
| GET | `/api/logistics/pickup-locations` | Admin | Pickup nicknames as Shiprocket sees them |
| GET | `/api/logistics/orders/:id/rates` | Admin | Courier options for a placed order |
| POST | `/api/logistics/orders/:id/ship` | Admin | Create the shipment, assign an AWB, make the label |
| POST | `/api/logistics/orders/:id/pickup` | Admin | Schedule a courier pickup |
| POST | `/api/logistics/orders/:id/invoice` | Admin | Generate the invoice PDF |
| POST | `/api/logistics/orders/:id/manifest` | Admin | Generate the manifest PDF |
| POST | `/api/logistics/orders/:id/cancel-shipment` | Admin | Cancel an assigned AWB |
| GET | `/api/logistics/orders/:id/track` | Owner or admin | Live tracking for one order |
| POST | `/api/logistics/webhook` | Token | Courier status pushes |
