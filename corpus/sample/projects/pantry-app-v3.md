---
title: Pantry app v3
tags: [pantry, mobile, react-native, project]
status: launched
owner: Aiko Tanaka
updated: 2026-10-22
---
# Pantry app v3

Pantry v3 is a rewrite of the customer app from separate native iOS and Android apps into a single
**React Native** codebase.

## Goals

- One codebase so features ship to both platforms at the same time.
- **Offline cart**: customers can build a cart without a connection; it syncs when they reconnect.
- Crash-free sessions of at least **99.5%**.
- Smart reorder: suggest a basket using order history plus Kestrel forecasts of what is in stock.

## Status

- Beta with 2,000 customers started September 15.
- **Version 3.0 shipped to everyone on October 21, 2026.**
- Crash-free sessions in the first week: 99.62%.
- Smart reorder is behind the feature flag `smart_reorder`, enabled for 10% of users.

## Known issues

- On Android 11, the offline cart sometimes duplicates an item when sync retries. Fix targeted for 3.0.2.
- Sam is redesigning the empty-cart screen; current one tested poorly with new users.
