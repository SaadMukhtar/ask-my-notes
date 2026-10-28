---
title: Project Harbor - orders database migration
tags: [harbor, postgres, migration, project]
status: complete
owner: Lena Fischer
updated: 2026-10-20
---
# Project Harbor

Harbor moved the orders database from **MySQL 5.7** to **Postgres 16**.

## Why

- MySQL 5.7 reached end of life and our managed provider stops supporting it in January 2027.
- The team already runs Postgres for the feature store, so one engine means one set of skills,
  backups, and runbooks. See [ADR-007](../docs/adr-007-postgres-for-orders.md).

## Approach

1. Schema conversion with a hand-reviewed script (no automatic converter for the stored procedures).
2. Continuous replication from MySQL to Postgres with **Debezium and Kafka** (CDC).
3. Shadow reads: orders-api read from both databases and compared results for 3 weeks.
4. Cutover in a 30-minute maintenance window.
5. Keep MySQL running read-only for **14 days** as the rollback path.

## Timeline

- Original cutover date: September 20, 2026.
- **Slipped to October 4, 2026** because replication lag spiked to 40 minutes during bulk backfills.
  Lena fixed it by increasing Kafka partitions from 6 to 24 and batching Debezium writes.
- Cutover on October 4 took **22 minutes** of the 30-minute window. No data loss.
- MySQL decommissioned on October 18, 2026.

## Results

- Checkout p95 latency went from 310 ms to 205 ms.
- Storage cost dropped about 18% thanks to better compression.
