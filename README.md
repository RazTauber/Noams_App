# Production Taxi Router

A taxi routing system for film and TV productions

A smart taxi routing system for Israeli film/TV productions that optimizes crew transportation to set locations.

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run tests
npm test

# Build for production
npm run build
```

## Architecture

```
src/
├── index.html                 # Main app shell
├── styles/
│   └── main.css              # Apple-inspired design system
└── js/
    ├── main.js               # App entry point & state management
    ├── components/
    │   └── ui.js             # UI rendering (table, taxi cards, status)
    ├── services/
    │   ├── mapsService.js    # Google Maps Distance Matrix wrapper
    │   ├── routingAlgorithm.js  # Greedy matching + dynamic thresholds
    │   └── exportService.js  # Excel & PDF export
    └── utils/
        ├── constants.js      # Algorithm config & column mappings
        └── helpers.js        # Data parsing & utility functions

tests/
├── algorithm.test.js         # T05-T08: Delay threshold tests
├── parsing.test.js           # Data parsing & time bucket tests
└── integration.test.js       # T01-T04, T09: Full flow tests

docs/                         # Original specifications
├── app_specification.md
├── test_plan.md
├── user_journey.md
├── websitedraft.html         # Original prototype (reference)
└── cssdraft.css              # Original CSS draft (reference)
```

## Algorithm

The routing engine uses a **Greedy Algorithm** with **Dynamic Thresholds**:

| Rule | Value |
|------|-------|
| Max passengers/taxi | 3 |
| Delay % limit | 40% of direct time |
| Minimum grace | 10 minutes |
| Hard cap | 25 minutes |

## Google Maps API

1. Get a Google Maps API key with Distance Matrix and Directions APIs enabled
2. Copy `.env.example` to `.env`
3. Set `GOOGLE_MAPS_API_KEY` in your `.env` file (server-side only — never a `VITE_` variable)
4. Run `npm run dev:full` (`vercel dev`) so the proxy function can read the key

Without a key, or when running plain `npm run dev`, the app runs in **demo mode** with simulated travel times.

## User Flow

1. **Settings** — Enter set address + arrival time
2. **Upload** — Drag Excel file with passenger list
3. **Edit** — Review/correct data in interactive table
4. **Calculate** — Algorithm groups passengers into taxis
5. **Optimize** — Manually separate passengers if needed
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
- **SheetJS (xlsx)** — Excel read/write
- **Google Maps API** — Distance Matrix + Directions
- **Vitest** — Unit & integration testing
