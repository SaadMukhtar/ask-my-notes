---
title: Architecture overview
tags: [architecture, platform]
updated: 2026-09-12
author: Marcus Oyelaran
---
# Architecture overview

Fernhill's backend is a handful of services behind an API gateway. This page covers the parts the
Platform & Forecasting team owns.

## Request path

The Pantry mobile app talks to the **API gateway** (Envoy). The gateway routes to:

- **orders-api** (Go): carts, orders, checkout. Owned by Tomás.
- **kestrel-api** (Python, FastAPI): demand forecasts. Owned by Marcus.
- **catalog-api** (owned by the Catalog team, not us).

## Data stores

- **Orders database**: historically MySQL 5.7. Project Harbor migrated it to **Postgres 16**; the cutover
  happened on October 4, 2026. Connections go through **PgBouncer** in transaction pooling mode.
- **Feature store**: a Postgres schema called `features` that Kestrel reads. It is rebuilt by the
  nightly pipeline.
- **Event bus**: Kafka. Debezium streams change-data-capture (CDC) events from the orders database.
- **Object storage**: S3 buckets for model artifacts (`fernhill-kestrel-models`) and raw exports.

## Batch jobs

- `kestrel-nightly`: retrains the forecasting model and refreshes forecasts. Runs at 02:00 UTC on
  Airflow. See the [Kestrel nightly runbook](runbook-kestrel-nightly.md).
- `orders-export`: hourly export of orders to the data warehouse.

## Observability

Metrics go to Prometheus and dashboards live in Grafana. Logs go to Loki. Paging is through PagerDuty.
Every service must expose RED metrics (rate, errors, duration) on `/metrics`.
