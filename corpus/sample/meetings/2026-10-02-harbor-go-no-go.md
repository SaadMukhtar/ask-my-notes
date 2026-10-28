---
title: Harbor cutover go/no-go - October 2
tags: [meeting, harbor, go-no-go, decision]
date: 2026-10-02
attendees: [Priya, Lena, Tomás, Dev, Marcus]
---
# Harbor cutover go/no-go (October 2)

## Checklist

| Item | Owner | Status |
|---|---|---|
| Replication lag under 10 s for 5 days | Lena | Pass (max 3 s) |
| Shadow read mismatch rate under 0.01% | Tomás | Pass (0.002%) |
| Rollback rehearsed in staging | Lena | Pass (took 12 minutes) |
| On-call staffed for cutover window | Dev | Pass |
| Support team briefed | Hannah (async) | Pass |

## Decision

**GO** for cutover on Saturday, October 4, from 06:00 to 06:30 Pacific.

## Rollback criteria

Roll back to MySQL if checkout error rate is above 2% for 5 minutes after cutover, or if any data
mismatch is found in the first hour. MySQL stays read-only for 14 days as the fallback.
