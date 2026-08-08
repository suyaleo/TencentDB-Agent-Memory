# Security

Do not report credentials in public issues. Rotate any credential that may have been exposed and report vulnerabilities privately to the repository maintainers.

The shared-brain deployment binds services to loopback by default. Keep runtime secrets in `.env.shared-brain` and `deploy/shared-brain/.runtime/`, both excluded from Git. Review Agent Memory ACLs before sharing assets, and never bulk-import raw transcripts without secret and privacy review.
