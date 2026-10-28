---
title: "INC-2041: Checkout outage on August 14"
tags: [incident, postmortem, checkout, pgbouncer]
date: 2026-08-14
severity: SEV1
incident_commander: Dev Patel
---
# INC-2041: Checkout outage (August 14, 2026)

## Summary

For **47 minutes** (17:52 to 18:39 Pacific), customers could not complete checkout. About 3,400
checkout attempts failed. Severity: SEV1.

## Timeline (Pacific)

- 17:45 orders-api deploy starts (routine release 2026.08.14-2).
- 17:52 Error rate on `POST /v1/checkout` jumps to 64%. Dev is paged and acknowledges in 2 minutes.
- 18:05 Dev declares SEV1 and becomes incident commander. Status page updated.
- 18:20 Tomás finds "no more connections allowed (max_client_conn)" in PgBouncer logs.
- 18:31 Deploy rolled back; old pods drain.
- 18:39 Error rate back to normal.

## Root cause

The deploy briefly ran old and new pods at the same time (40 pods instead of 20). Each pod opened
20 connections to PgBouncer, so 800 client connections were needed but `max_client_conn` was **500**.
New connections were refused.

## What went well

- Paging worked; acknowledgment in 2 minutes.

## What went wrong

- Nobody had a runbook for PgBouncer.
- The deploy had no automatic rollback on error rate.

## Action items

1. Raise `max_client_conn` to 2000. Owner: Dev. **Done Aug 15.**
2. Write the PgBouncer runbook. Owner: Dev. **Done Aug 22.**
3. Add automatic rollback when checkout error rate exceeds 5% for 3 minutes. Owner: Tomás. **Done Sept 5.**
4. Limit deploy surge to 25% extra pods. Owner: Tomás. **Done Aug 29.**
