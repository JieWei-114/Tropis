# Security Policy

## Supported versions

Only the latest release (highest `v*` tag) and the `main` branch receive security fixes.

## Reporting a vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

- Preferred: use GitHub's **private vulnerability reporting** ("Report a vulnerability" under the Security tab of this repository).
- Alternatively, email the maintainers at **jiewei@snsoft.my** with the subject `[SECURITY]`.

Please include: affected component/file, reproduction steps or PoC, impact assessment, and any suggested fix.

## What to expect

- **Acknowledgement** within 72 hours.
- **Triage & severity assessment** within 7 days.
- A fix or mitigation plan communicated to you before public disclosure; we aim to release fixes for critical issues within 30 days.
- Credit in the release notes if you'd like it (or anonymity if you prefer).

## Scope notes

- Secrets committed under `infra/` (e.g. `infra/k8s/base/backend/secret.yaml`) are **development placeholders**, not live credentials — still, report anything that looks real.
- Vulnerabilities in third-party dependencies should also be reported upstream; we track them via Dependabot and `pnpm audit`.

Thank you for helping keep the project and its users safe.
