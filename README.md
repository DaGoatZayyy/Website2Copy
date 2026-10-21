# Site Archiver

A Next.js app that collects a bounded set of publicly reachable same-origin website pages and assets into a ZIP archive.

## Local development

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Run `npm run dev`.
4. Open `http://localhost:3000`.

## Deploy to Vercel

Import this repository at https://vercel.com/new and deploy it as a Next.js project.

## Limits and safety

- Up to 50 files, 15 MB total, 4 MB per file, and 12 HTML pages per request.
- Same-origin pages and assets only; standard web ports only.
- Rejects localhost and common private/reserved IP ranges and validates redirects.
- This is a best-effort static downloader, not a browser renderer or full-site backup.
- Use only for sites you own or have permission to archive.
- Detailed diagnostic logs use `[SiteArchiver]` prefixes. Avoid logging cookies, credentials, or full response bodies.
- Before operating as a public service, add rate limiting, abuse monitoring, and stronger DNS/IP pinning at the network layer.
