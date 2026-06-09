# Security Policy

## Supported Versions

Currently, only the latest release of OntoIndex is supported for security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

If you discover a potential security vulnerability in OntoIndex, please do not disclose it publicly. Instead, report it directly to the maintainers.

### Disclosure Process

1. **Reporting**: Send an email to `founders@akonlabs.com` with `OntoIndex security` in the subject. Do not include exploit details in public issues, discussions, or Discord.
2. **Acknowledgment**: You will receive an acknowledgment of your report within 48 hours.
3. **Investigation**: The maintainers will investigate the issue and determine its impact.
4. **Resolution**: If a vulnerability is confirmed, a fix will be developed and released.
5. **Disclosure**: Once a fix is available, a security advisory will be published, and you will be credited for the discovery (if desired).

## Security Posture

OntoIndex takes security seriously. Key measures include:
- **Local-First**: Indexing and analysis run locally; your code never leaves your machine unless you explicitly connect a remote agent.
- **Restricted Access**: The HTTP bridge binds to `127.0.0.1` by default and requires Bearer token authentication.
- **XSS Protection**: All rendered diagrams and wiki content are sanitized using `DOMPurify`.
- **Injection Guard**: Database queries use parameterized execution to prevent Cypher/SQL injection.
