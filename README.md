# CapX

**On-chain spend enforcement for AI agent fleets.** An OKX.AI Agent Service Provider (Software Utility, A2MCP).

Any orchestrator agent spawning a fleet of sub-agents can register a spending policy with CapX. Every sub-agent payment is checked and deducted atomically — enforced by the contract, not by whichever application happens to be calling it. Exceed a cap, and the transaction reverts. No partial spend, no app-layer trust required.

## Why

App-layer budget checks are a convention every agent has to individually honor — and in a marketplace like OKX.AI, you're often paying *other people's* agents whose internal logic you can't audit. CapX moves the ceiling to the chain: it's a wall, not a guideline.

## What's real right now vs. what's next

This is an honest MVP built against a tight deadline — here's the actual state:

| Piece | Status |
|---|---|
| `CapX.sol` — full contract (policies, agent budgets, atomic deduct, pause/resume/topup, gas-optimized with custom errors and packed storage) | **Written, compiles (verified via solc), ready to deploy** |
| Backend API (`/policy`, `/payment/check`, `/invoice/verify`) | **Working**, tested end-to-end |
| Dashboard | **Working**, polls the API live |
| Deployment to X Layer testnet | **Not yet deployed** — see below |
| ERC-8004 identity registry lookup | **Stubbed** — verifies signatures now, needs the real Onchain OS registry call wired in |
| OKX Payment SDK / x402 integration | **Not yet wired** — `/payment/check` currently settles against the local ledger (or a live contract if configured), not yet behind OKX's payment flow |

The backend runs in two modes:
- **SIMULATED** (default) — no chain calls, runs instantly with zero setup. Every budget rule is enforced exactly as the contract would enforce it; nothing broadcasts on-chain.
- **LIVE** — once `CapX.sol` is deployed to X Layer and `XLAYER_RPC` / `CONTRACT_ADDRESS` / `DEPLOYER_PRIVATE_KEY` are set in `backend/.env`, every check calls the real contract and reverts are real reverts.

This lets you demo the full enforcement logic tonight without needing a funded testnet wallet, and flip to live on-chain calls the moment the contract is deployed.

## Quickstart (demo mode — 2 minutes)

```bash
cd backend
npm install
cp .env.example .env    # leave blank for simulated mode
npm start
```

In another terminal, create a policy:

```bash
curl -X POST http://localhost:4000/policy -H "Content-Type: application/json" -d '{
  "orchestrator": "0xOrchestrator111",
  "globalBudget": 500,
  "agents": [
    {"wallet": "0xDataFetcherAgent", "softCap": 100},
    {"wallet": "0xSummarizerAgent", "softCap": 150},
    {"wallet": "0xVerifierAgent", "softCap": 100}
  ]
}'
```

Then open `frontend/landing.html` in a browser — it's the marketing page, with a "Launch Dashboard" button leading to `frontend/index.html`, which polls `http://localhost:4000` every 2.5s. Trigger a spend to watch it update live:

```bash
curl -X POST http://localhost:4000/payment/check -H "Content-Type: application/json" -d '{"policyId": 1, "agent": "0xDataFetcherAgent", "amount": 40}'
```

Try one that exceeds the cap to see it reject:

```bash
curl -X POST http://localhost:4000/payment/check -H "Content-Type: application/json" -d '{"policyId": 1, "agent": "0xDataFetcherAgent", "amount": 90}'
```

## Going live on X Layer

```bash
npm install
cp .env.example .env     # fill in DEPLOYER_PRIVATE_KEY and RPC URLs
npm run compile
npm run deploy:testnet
```

Copy the deployed address into `backend/.env` (`CONTRACT_ADDRESS`, plus `XLAYER_RPC` and `DEPLOYER_PRIVATE_KEY`), restart the backend, and it switches to LIVE mode automatically.

> Double-check the X Layer testnet RPC endpoint and chain ID against current OKX docs before deploying — confirm at okx.com/xlayer/docs, since these can change.

## API

**POST `/policy`** — create a fleet policy
```json
{ "orchestrator": "0x...", "globalBudget": 500, "agents": [{ "wallet": "0x...", "softCap": 100 }] }
```

**POST `/payment/check`** — the A2MCP call every sub-agent makes before paying
```json
{ "policyId": 1, "agent": "0x...", "amount": 40 }
```
Returns `200` with remaining budgets on approval, `402`/`409` with a reason on rejection.

**POST `/invoice/verify`** — verifies a provider's signed invoice against its claimed wallet
```json
{ "invoice": { "policyId": 1, "agent": "0x...", "amount": 40, "resource": "dataset-chunk-1", "nonce": "abc123" }, "signature": "0x..." }
```

**GET `/policy/:id`** — full policy state: remaining budget, per-agent spend, recent events

**POST `/policy/:id/pause`** / **`/resume`** / **`/topup`** — fleet-wide emergency controls

## Architecture

```
Orchestrator agent
      │  POST /policy
      ▼
  CapX backend  ──────────────►  CapX.sol on X Layer
      │  POST /payment/check          (atomic checkAndDeduct)
      ▼
  Sub-agent payment approved/rejected
      │
      ▼
  Dashboard (polls /policy/:id)
```

## Stack

Solidity 0.8.20 + OpenZeppelin (AccessControl, ReentrancyGuard) · Hardhat · Express + better-sqlite3 (zero-infra local ledger) · ethers.js v6 · vanilla HTML/CSS/JS dashboard.

## OKX.AI listing checklist

- [ ] Deploy `CapX.sol` to X Layer testnet, verify on chainscan
- [ ] Wire `/payment/check` behind OKX's x402-compliant Payment SDK so it's a real pay-per-call A2MCP endpoint
- [ ] Replace the stubbed identity check in `/invoice/verify` with a real ERC-8004 registry read via Onchain OS
- [ ] Submit listing at okx.ai/tutorial/asp
- [ ] Submit the hackathon Google form once listed
- [ ] Record and post the 90s demo with #okxai
