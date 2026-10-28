---
title: Project Kestrel - demand forecasting service
tags: [kestrel, forecasting, project]
status: in progress
owner: Marcus Oyelaran
updated: 2026-10-08
---
# Project Kestrel

Kestrel is the demand forecasting service. It predicts how many units of each SKU each store will
sell on each of the next 14 days.

## Why

Our old forecast was a 28-day moving average built in a spreadsheet. It ignores weather, promotions,
and holidays, so stores over-order perishables. Spoilage cost us about $3.1M last year.
The Q4 objective is to **reduce spoilage by 12%** in stores that use Kestrel.

## What it is

- A gradient-boosted tree model (LightGBM) trained on 2 years of sales, promotions, weather, and
  local holidays.
- One global model across all stores, with store and SKU features, rather than one model per store.
  (Per-store models were tried in the spike and overfit badly on small stores.)
- Retrained nightly by the `kestrel-nightly` job at 02:00 UTC.
- Served by `kestrel-api`: `GET /v1/forecast?store_id=...&sku=...&horizon=14`.

## Targets

| Metric | Target | Status (Oct 8) |
|---|---|---|
| MAPE on perishables | below 18% | 16.4% in the pilot |
| kestrel-api p95 latency | below 250 ms | 180 ms |
| Spoilage reduction in pilot stores | 12% | 9.8% after 4 weeks |

## Timeline

- **Sept 9, 2026**: pilot launched in 5 Portland stores.
- **Oct 28, 2026**: decision on expanding to all Oregon stores (see Q4 planning).
- **Nov 18, 2026**: planned rollout to all 42 stores.

## Open risks

- Forecasts depend on the nightly job; when it fails, forecasts go stale (see INC-2077).
- The weather feed vendor contract renews in December.
