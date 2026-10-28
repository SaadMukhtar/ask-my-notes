---
title: "ADR-007: Postgres 16 for the orders database"
tags: [adr, harbor, postgres, decision]
date: 2026-04-02
status: accepted
deciders: [Lena Fischer, Marcus Oyelaran, Priya Raman]
---
# ADR-007: Postgres 16 for the orders database

## Context

The orders database runs on MySQL 5.7, which is end of life. We must move before January 2027.

## Options considered

1. **Upgrade in place to MySQL 8 (Aurora MySQL).** Smallest change. Keeps two database engines in the team.
2. **Migrate to Postgres 16.** Bigger change. One engine across orders and the feature store.
3. **Move orders to DynamoDB.** Rejected early: checkout needs multi-row transactions and ad hoc reporting.

## Decision

Migrate to **Postgres 16**, self-managed on our existing RDS setup.

## Why

- One engine for the whole team: shared backups, monitoring, runbooks, and on-call knowledge.
- Better support for the JSON and partial indexes the orders schema already wants.
- Logical replication and CDC tooling (Debezium) are mature for both engines, so migration risk is manageable.

## Consequences

- About 6 weeks of extra work compared with the MySQL 8 upgrade.
- Stored procedures (11 of them) must be rewritten in PL/pgSQL or moved into orders-api.
- Connection handling changes: Postgres needs a pooler, so we adopt PgBouncer.
