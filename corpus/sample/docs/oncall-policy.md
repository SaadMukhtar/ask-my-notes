---
title: On-call policy
tags: [oncall, process, sre]
updated: 2026-08-25
author: Dev Patel
---
# On-call policy

## Rotation

- Weekly rotation with a primary and a secondary.
- **Handoff is Mondays at 10:00 Pacific**, in a 15-minute call where the outgoing primary walks
  through open issues.
- Seven engineers are in the rotation. New engineers join after 6 weeks (see the onboarding guide).

## Escalation

1. The primary has **5 minutes** to acknowledge a page.
2. If not acknowledged, PagerDuty pages the secondary.
3. If still not acknowledged after **15 minutes** total, it pages the engineering manager (Priya).

## Compensation

- On-call engineers get a $300 stipend per week on primary, $150 on secondary.
- If you are paged between midnight and 06:00, take the next morning off.

## Severity levels

- **SEV1**: customers cannot order. Incident commander required, status page update within 15 minutes.
- **SEV2**: degraded but working (for example, stale forecasts).
- **SEV3**: internal only.

Every SEV1 and SEV2 gets a written post-incident review within 5 business days.
