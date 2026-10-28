---
title: "INC-2077: Stale Kestrel forecasts on September 23-25"
tags: [incident, postmortem, kestrel, iam]
date: 2026-09-23
severity: SEV2
incident_commander: Marcus Oyelaran
---
# INC-2077: Stale Kestrel forecasts (September 23 to 25, 2026)

## Summary

Kestrel served forecasts generated on September 22 for about **two days**. The 5 pilot stores ordered
from stale numbers on September 23 and 24. Severity: SEV2. Estimated extra spoilage: $6,800.

## Root cause

The automated 90-day secrets rotation replaced the IAM policy for the `kestrel-batch` role and dropped
the `s3:PutObject` permission on `fernhill-kestrel-models`. The `train` task failed with `AccessDenied`
on September 23 and 24. The freshness alert fired on September 24 at 08:00 UTC, but it was routed to
email instead of PagerDuty, so nobody saw it until the morning of September 25.

## Fix

- Marcus restored the permission and re-ran the DAG on September 25; forecasts were fresh by 11:40 UTC.

## Action items

1. Move the freshness alert from email to PagerDuty (SEV2 routing). Owner: Dev. **Done Sept 26.**
2. Manage the `kestrel-batch` IAM policy in Terraform so rotation cannot change it. Owner: Marcus. **Done Oct 3.**
3. Add an integration test that the batch role can write to the models bucket. Owner: Marcus. **In progress.**
4. Write the kestrel-nightly runbook. Owner: Marcus. **Done Sept 29.**
