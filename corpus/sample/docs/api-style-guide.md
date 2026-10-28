---
title: API style guide
tags: [api, standards]
updated: 2026-05-30
author: Tomás Alvarez
---
# API style guide

Rules for every HTTP API the team owns.

## Naming

- JSON fields are **snake_case** (`store_id`, `generated_at`).
- Paths are plural nouns with a version prefix: `/v1/orders`, `/v1/forecasts`.

## Pagination

- Use **cursor pagination**, never offset pagination. Responses include `next_cursor`; it is null on
  the last page.
- Default page size 50, maximum 500.

## Errors

- Errors return a JSON body: `{"error": {"code": "...", "message": "..."}}`.
- Use 422 for validation errors, not 400.

## Time

- All timestamps are ISO 8601 in UTC with a `Z` suffix.

## Versioning

- Breaking changes need a new major version path (`/v2/...`) and 90 days of overlap with the old one.
