# Faultline

Faultline is a flight recorder for multi-agent mobile app generation. It runs a real OpenAI-compatible workflow, publishes an Expo preview, and makes self-hosted SigNoz the evidence store for traces, metrics, logs, dashboards, and alerts.

## Run locally

Requirements: Node 20+, Docker Desktop, and an OpenAI-compatible API key.

```bash
cp .env.example .env
npm install
cd infra/signoz && chmod +x bootstrap.sh && ./bootstrap.sh
# Start the pinned official SigNoz Docker deployment from infra/signoz/upstream.
npm run dev
```

Open SigNoz at `http://localhost:8080` and complete its one-time initial admin setup before running Faultline; this enables the collector's telemetry pipeline. Then open Faultline at `http://localhost:5173`. `npm run dev` starts the Faultline bridge (`4320`), runner (`4310`), console (`5173`), and Expo preview (`8081`) together. Use **Healthy run** for the normal workflow, then **Injected incident** to create a recorded timeout/retry and token-budget breach.

## Demo checks

1. A healthy run produces four nested agent spans and an Expo preview.
2. An injected incident produces an `agent.retry` span, error context, and a token-budget breach metric.
3. Faultline ranks the incident first and links to SigNoz evidence.
