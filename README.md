# Production Taxi Router

A smart taxi routing system for Israeli film/TV productions that optimizes crew transportation to set locations.

**Live app:** https://noamsapp.raztauber.workers.dev/

**Repository:** https://github.com/RazTauber/Noams_App

## Quick Start

```bash
# Install dependencies
npm install

# Start full development server (API proxy + Vite)
npm run dev:full

# Run tests
npm test

# Build for production
npm run build

# Deploy to Cloudflare Workers
npm run deploy
```

> **Important:** Always use `npm run dev:full` for development. Running plain `npm run dev` will start Vite without the API proxy, causing the app to fall back to mock travel times.

## Deployment

The app is deployed on **Cloudflare Workers** at https://noamsapp.raztauber.workers.dev/

Deployment is done via Wrangler:
```bash
npm run deploy   # builds + deploys to Cloudflare
```

Required Cloudflare Worker secrets (set via `wrangler secret put`):
- `GOOGLE_MAPS_API_KEY` — Google Maps API key (Distance Matrix + Directions)

The Supabase credentials are compile-time env vars baked into the client bundle during build (set in `.env` locally or CI environment):
- `VITE_SUPABASE_URL` — Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — Supabase anon/public key

## Architecture

```
src/
├── index.html                 # Main app shell
├── public/
│   └── highs.wasm            # ILP solver (copied from node_modules)
├── styles/
│   └── main.css              # Apple-inspired design system
└── js/
    ├── main.js               # App entry point & state management
    ├── components/
    │   └── ui.js             # UI rendering (table, taxi cards, status)
    ├── services/
    │   ├── mapsService.js    # Google Maps proxy client + mock fallback
    │   ├── routingAlgorithm.js  # Greedy + smart (ILP) matching
    │   ├── optimizer.js      # ILP solver (HiGHS WASM) + group enumeration
    │   ├── cacheService.js   # Same-day browser cache (memory + localStorage)
    │   ├── groupMemoryService.js  # Supabase persistent memory layer
    │   ├── delayEvaluator.js # Delay threshold rules
    │   └── exportService.js  # Excel & PDF export
    └── utils/
        ├── constants.js      # Algorithm config & column mappings
        └── helpers.js        # Data parsing & utility functions

api/
└── maps.js                   # Server-side Google Maps proxy (Cloudflare Worker)

worker.js                     # Cloudflare Worker entry (routes /api/maps)
dev-server.js                 # Local API server (port 3000, used by dev:full)
schema.sql                    # Supabase DB schema (grouping_memory + pair cache)

tests/
├── algorithm.test.js         # Delay threshold tests
├── smartAlgorithm.test.js    # ILP + smart match tests
├── parsing.test.js           # Data parsing & time bucket tests
├── integration.test.js       # Full flow tests
└── costOptimization.test.js  # API cost optimization tests
```

## Algorithm

The routing engine uses a **Smart Match (ILP)** algorithm with **Greedy fallback**:

1. **ILP Solver (HiGHS)** — Finds optimal passenger-to-taxi assignment minimizing total taxis
2. **Greedy Algorithm** — Fallback when ILP is unavailable; iteratively groups nearby passengers

Dynamic delay thresholds:

| Rule | Value |
|------|-------|
| Max passengers/taxi | 3 |
| Delay % limit | 40% of direct time |
| Minimum grace | 10 minutes |
| Hard cap | 25 minutes |
| Cross-city cap | 5 minutes |

## Caching & Memoization

Three-tier caching strategy:

1. **Browser session cache** — In-memory + localStorage, same-day TTL
2. **Supabase DB** — Persistent pair matrix + grouping memory (cross-session)
3. **Server-side cache** — In-memory on Cloudflare Worker (warm instances)

## Google Maps API

The app proxies all Google Maps requests through `/api/maps` (server-side) to keep the API key secure.

Required APIs enabled on the Google Cloud project:
- Distance Matrix API
- Directions API

Without a configured key, the app falls back to **mock mode** with simulated travel times. The proxy will automatically retry after 30 seconds if it initially fails.

## User Flow

1. **Settings** — Enter set address + arrival time
2. **Upload** — Drag Excel file with passenger list
3. **Edit** — Review/correct data in interactive table
4. **Calculate** — Algorithm groups passengers into taxis
5. **Optimize** — Manually separate/merge passengers
6. **Export** — Download Excel (production) or PDF (taxi company)

## Excel Format

The input file should have these columns (Hebrew or English):

| Full Name | Pickup Address | Special Taxi | Exception Time |
|-----------|---------------|-------------|----------------|
| Israel Israeli | Dizengoff 50, Tel Aviv | No | |
| Yael Cohen | Herzl 10, Rishon | Yes | 08:00 |

## Tech Stack

- **Vite** — Build tool & dev server
- **Vanilla JS** — No framework, simplicity first
- **HiGHS (WASM)** — Integer Linear Programming solver
- **Supabase** — Persistent memory (PostgreSQL)
- **SheetJS (xlsx)** — Excel read/write
- **Google Maps API** — Distance Matrix + Directions
- **Cloudflare Workers** — Serverless deployment
- **Vitest** — Unit & integration testing
