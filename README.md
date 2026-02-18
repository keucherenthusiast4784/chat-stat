# chat-stat

A **fully static** React website for analyzing WhatsApp + Discord exported chat text files.

No backend/server process is required in production: the app runs entirely in the browser and is suitable for **GitHub Pages** hosting.

## Use on GitHub Pages (no self-hosting)

1. Push this repo to GitHub.
2. In GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. Push to `main` (or run the workflow manually).
5. Open your Pages URL once deployment completes.

A workflow is included at `.github/workflows/deploy-pages.yml` to publish the site automatically.

## Run locally (optional)

You can still run a local static server while developing:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` and upload `.txt` exports.
