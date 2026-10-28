---
title: Kestrel API design review
tags: [kestrel, design-review, api]
date: 2026-07-28
attendees: [Marcus Oyelaran, Tomás Alvarez, Hannah Cole, Priya Raman, Dev Patel]
---
# Kestrel API design review (July 28)

## Proposal (Marcus)

Serve forecasts from precomputed tables instead of running the model at request time. The nightly job
writes all forecasts for all store/SKU pairs (about 1.9 million rows per horizon day) into the
`forecasts` table; the API is a thin read layer.

## Discussion

- Tomás asked whether the Pantry app could call Kestrel directly. Decision: **no**. The app calls
  orders-api, which calls kestrel-api, so we keep one place for auth and rate limits.
- Dev wanted a freshness signal. Decision: every response includes `generated_at`, and we alert if
  forecasts are older than 30 hours.
- Hannah asked about explaining forecasts to store managers. Deferred to Q1 2027.
- Priya asked about cost. Precomputing costs about $40/month extra in storage, much cheaper than
  GPU or CPU inference at request time.

## Decisions

1. Precompute forecasts nightly; the API only reads.
2. JSON responses follow the [API style guide](../docs/api-style-guide.md) (snake_case, cursor pagination).
3. p95 latency SLO of 250 ms.
4. Alert when `generated_at` is older than 30 hours.

## Action items

- Marcus: write the `forecasts` table schema. (Done Aug 4.)
- Dev: add the freshness alert. (Done Aug 11.)
