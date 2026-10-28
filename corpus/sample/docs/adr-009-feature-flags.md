---
title: "ADR-009: Self-hosted Unleash for feature flags"
tags: [adr, feature-flags, decision]
date: 2026-06-10
status: accepted
deciders: [Priya Raman, Aiko Tanaka, Tomás Alvarez]
---
# ADR-009: Self-hosted Unleash for feature flags

## Context

Pantry v3 and Kestrel both need gradual rollouts. Today flags are environment variables, which need a
deploy to change.

## Options

1. **LaunchDarkly**: best features, quoted at about $28,000 per year for our seat count.
2. **Self-hosted Unleash** (open source): free license, we run it on the existing Kubernetes cluster.
3. **Build our own** on Postgres: rejected; flag evaluation SDKs for mobile are a lot of work.

## Decision

Use **self-hosted Unleash**.

## Why

The cost difference is large and our needs are simple: percentage rollouts and per-user targeting.
Unleash has React Native and Go SDKs.

## Consequences

- Dev's team owns Unleash uptime. If Unleash is down, SDKs fall back to the last cached flag values.
- Flag names use snake_case, for example `smart_reorder`.
- Every flag needs an owner and a removal date in its description.
