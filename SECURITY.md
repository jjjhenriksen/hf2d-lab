# Security policy

## Supported versions

Security fixes are applied to the current `main` branch.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting flow from the repository's **Security** tab. Include reproduction steps, affected browsers or platforms, and the potential impact.

The application is serverless and stores session data locally, but imported session archives and GPU/worker boundaries should still be treated as untrusted input surfaces.
