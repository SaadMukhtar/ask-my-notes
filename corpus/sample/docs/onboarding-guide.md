---
title: Onboarding guide for new engineers
tags: [onboarding, process]
updated: 2026-08-04
author: Priya Raman
---
# Onboarding guide for new engineers

Welcome to Platform & Forecasting. This page is the checklist for your first two weeks.

## Week 1

1. Get laptop access and request the `plat-eng` group in the identity portal. Approval comes from Priya.
2. Read the [architecture overview](architecture-overview.md) and the [glossary](glossary.md).
3. Set up the local dev environment: `make bootstrap` in the `fernhill/platform` repo. It needs Docker
   and about 12 GB of free disk space.
4. Pair with your onboarding buddy for at least two sessions. Buddies are assigned by Priya before day one.
5. Ship one small pull request. A docs fix counts.

## Week 2

1. Shadow the on-call engineer for one full rotation day. You will not be paged.
2. Join the Tuesday team sync and the sprint planning meeting.
3. Read the incident write-ups for INC-2041 and INC-2077; they are the best introduction to how our
   systems fail.

## Things people always ask

- **When do I join on-call?** After 6 weeks, once you have shadowed twice and completed the
  incident-commander training.
- **Learning budget?** Every engineer has a learning budget of $1,200 per calendar year for books,
  courses, and conferences. Submit receipts in the expense tool under "Learning".
- **Who approves my PRs?** Anyone on the team, but see the [code review guidelines](code-review-guidelines.md)
  for services that need two approvals.
