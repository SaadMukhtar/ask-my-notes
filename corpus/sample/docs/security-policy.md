---
title: Security policy for the team
tags: [security, policy]
updated: 2026-07-01
---
# Security policy for the team

- **Secrets rotation**: every service credential and IAM access key rotates every **90 days**. Rotation
  is automated by the platform team's `rotate-secrets` job.
- Secrets live in AWS Secrets Manager. Never put secrets in environment files committed to git.
- Production database access needs a break-glass request approved by Priya or Lena; sessions are recorded.
- Customer personal data (names, addresses, phone numbers) must not be copied to laptops or to
  analytics notebooks. Use the anonymised warehouse views.
- Report suspected phishing to `security@fernhill.example` and do not click links in the message.
- AI tools: do not paste customer data or secrets into external AI tools. Internal tools that run on
  approved vendors are fine for code and docs.
