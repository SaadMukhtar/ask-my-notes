---
title: "Runbook: PgBouncer connection pool"
tags: [runbook, postgres, pgbouncer, oncall]
updated: 2026-10-10
author: Dev Patel
---
# Runbook: PgBouncer connection pool

PgBouncer sits between orders-api and the orders Postgres database in **transaction pooling** mode.

## Current settings (after INC-2041)

- `max_client_conn = 2000` (was 500 during INC-2041)
- `default_pool_size = 40`
- `reserve_pool_size = 10`

## Alert: "PgBouncer waiting clients high"

Fires when `cl_waiting` is above 50 for 2 minutes.

1. Check whether a deploy just happened. New pods open connections before old pods close theirs.
2. Look at `SHOW POOLS;` on the PgBouncer admin console.
3. If `cl_waiting` keeps climbing, roll back the latest orders-api deploy.
4. Never raise `default_pool_size` above 60 without talking to Lena: Postgres `max_connections` is 300.

## Background

Before INC-2041, `max_client_conn` was 500. A deploy doubled the number of orders-api pods for a few
minutes, every pod opened 20 connections, and new connections were refused.
