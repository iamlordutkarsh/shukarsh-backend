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

Migrations live in `prisma/migrations` and are committed. Render runs
`prisma migrate deploy` as the last step of its build, so a deploy applies any
new migration before the new code serves traffic. Never use `prisma db push`
against production: it changes the database without recording a migration, and
the next deploy will not know what has already been applied.

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
