---
title: Code review guidelines
tags: [process, code-review]
updated: 2026-06-02
---
# Code review guidelines

## Approvals

- One approval is enough for most changes.
- **Two approvals** are required for changes to services that touch payments (orders-api checkout
  code) and for database migrations.
- The author merges, not the reviewer.

## Size

- Keep pull requests under **400 changed lines**. Split larger changes behind a flag.

## Turnaround

- Reviewers respond within one business day. If you are blocked, ask in `#plat-forecasting`.

## What reviewers check

1. Does it have tests?
2. Are metrics and logs added for new code paths?
3. Is the change safe to roll back?
