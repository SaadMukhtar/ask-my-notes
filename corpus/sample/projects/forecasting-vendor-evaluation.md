---
title: Forecasting vendor evaluation
tags: [kestrel, vendors, decision]
author: Hannah Cole
date: 2026-05-14
---
# Forecasting vendor evaluation (May 2026)

Before building Kestrel we compared buying a forecasting product with building our own.

| Option | Cost per year | MAPE in trial | Notes |
|---|---|---|---|
| ForecastIQ | $240,000 | 19.8% | Black box, no per-SKU explanations, 6-month onboarding |
| Shelfwise | $180,000 | 21.5% | Good UI, weak on weather effects |
| Build (Kestrel) | about $90,000 (infra plus share of 2 engineers) | 17.1% in offline backtest | Full control, needs ongoing ownership |

## Decision

We chose to **build Kestrel**. It was the cheapest option and had the best accuracy in the backtest.
The main risk is ownership: if Marcus leaves, knowledge is concentrated. Mitigation: Tomás pairs on
Kestrel one day per week and we document the model in the repo.

We will re-evaluate vendors only if Kestrel misses the 18% MAPE target for two consecutive quarters.
