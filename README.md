# Shukarsh Backend

Backend API for the Shukarsh e-commerce store.

## Tech Stack

- Node.js
- Express
- TypeScript
- Prisma ORM
- PostgreSQL

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

4. Run the development server:
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
