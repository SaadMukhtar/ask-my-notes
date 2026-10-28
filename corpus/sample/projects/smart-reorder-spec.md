---
title: Smart reorder feature spec
tags: [pantry, kestrel, spec]
author: Hannah Cole
updated: 2026-08-19
---
# Smart reorder feature spec

## Problem

Repeat customers rebuild the same basket every week. Interviews showed it takes 6 to 9 minutes.

## Proposal

When a customer opens the app, offer a "Reorder your usuals" basket built from:

1. Items bought in at least 3 of the customer's last 5 orders.
2. Filtered to items that Kestrel forecasts as in stock at the customer's store for the delivery day.
3. Quantities equal to the customer's median quantity for that item.

## Success metric

Median time to checkout for repeat customers drops below 3 minutes.

## Rollout

- Behind the `smart_reorder` flag (see [ADR-009](../docs/adr-009-feature-flags.md)).
- 10% of users first, then 50% after two weeks if the error rate stays below 1%, then 100%.

## Out of scope

- Substitutions for out-of-stock items (planned for Q1 2027).
- Recipes.
