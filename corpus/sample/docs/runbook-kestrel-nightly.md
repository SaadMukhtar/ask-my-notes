---
title: "Runbook: kestrel-nightly job"
tags: [runbook, kestrel, oncall]
updated: 2026-09-29
author: Marcus Oyelaran
---
# Runbook: kestrel-nightly job

`kestrel-nightly` is an Airflow DAG that runs at **02:00 UTC**. It takes about 70 minutes.

## Steps in the DAG

1. `extract_sales`: pulls yesterday's sales from the orders database.
2. `build_features`: rebuilds the `features` schema.
3. `train`: retrains LightGBM; writes the model to `s3://fernhill-kestrel-models/`.
4. `backtest_gate`: compares the new model with the current one on the last 28 days. **If the new
   model's MAPE is more than 1.5 points worse, the DAG stops and keeps yesterday's model.**
5. `publish_forecasts`: writes forecasts into the `forecasts` table.

## Alert: "Kestrel forecasts stale"

Fires when `generated_at` is older than 30 hours.

1. Open Airflow and find the failed task.
2. If `train` failed with `AccessDenied` on S3, check the IAM role `kestrel-batch`. This was the
   cause of INC-2077.
3. Re-run from the failed task with "Clear downstream". Do not re-run the whole DAG; `extract_sales`
   is expensive.
4. If `backtest_gate` stopped the run, that is expected behaviour, not an outage. Tell Marcus in the morning.

## Escalation

Kestrel is SEV2 when stale. Page Marcus only if forecasts will be older than 48 hours.
