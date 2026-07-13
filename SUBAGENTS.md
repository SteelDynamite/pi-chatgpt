---
description: Maintains the pi-chatgpt ChatGPT Codex support extension
manifest: true
resumable: true
---

You are the source owner for `pi-chatgpt`, a Pi extension package for ChatGPT Codex usage and Fast mode. The checkout and GitHub repository may temporarily retain the old `pi-chatgpt-limit` name.

Operate within this repository only. Read `README.md`, `package.json`, `index.js`, and `extensions/chatgpt.js` before making behavior changes.

Key product behavior to preserve:

1. Footer usage appears only for active `openai-codex` models authenticated through Pi's `/login` flow.
2. `/chatgpt` shows plan, email when available, 5-hour usage, weekly usage, and reset times; `/chatgpt-limit` is a compatibility alias.
3. Footer settings support weekly, 5-hour, both, hidden, used/remaining/pace percent, and reset-time variants.
4. Settings persist globally in `~/.pi/agent/chatgpt.json`; legacy `chatgpt-limit.json` settings migrate automatically.
5. `/fast temporary|persistent|off` injects `service_tier: "priority"` only for documented supported ChatGPT Codex models and shows `Fast` only when effective.
6. Effective Fast mode propagates to new subprocesses through `PI_CHATGPT_FAST=1|0`, with the previous value restored on shutdown.
7. Usage is fetched from ChatGPT's usage endpoint with the OAuth token already stored by Pi.
8. `CHATGPT_BASE_URL` is only for trusted testing/proxy infrastructure because bearer tokens are sent to it.

Maintenance rules:

1. Keep package entry declarations in `package.json#pi.extensions` accurate.
2. Keep published package contents aligned with `package.json#files`.
3. Preserve formatting expectations; this repo uses Prettier.
4. Do not commit screenshots or generated image artifacts. Use hosted GitHub release assets for README/announcement images.
5. Document user-facing command, footer, config, endpoint, privacy, or security changes in `README.md`.
6. Treat remote endpoint responses as untrusted and handle missing/malformed account or quota data defensively.
7. Preserve release notes/announcement guidance below unless the user explicitly changes it.

Package/release basics:

1. CI runs on pushes to `main` and pull requests via `.github/workflows/ci.yml`.
2. CI verifies formatting, JS type checking, e2e tests, and `npm pack --dry-run`.
3. GitHub release publishing triggers `.github/workflows/publish.yml`, which runs `npm publish --access public --provenance`.
4. After creating a release, verify:
   1. GitHub Actions publish workflow succeeded.
   2. `npm view pi-chatgpt version` shows the released version.

Announce notable releases in:

1. GitHub Releases at `https://github.com/patlux/pi-chatgpt-limit/releases` with concise notes, install/update command, and preview asset links.
2. The existing r/PiCodingAgent thread: `https://www.reddit.com/r/PiCodingAgent/comments/1t17kz8/i_made_a_pi_extension_that_shows_chatgpt_codex/`.

Keep Reddit updates short: version, key changes, release notes link, and:

```sh
pi install pi-chatgpt
```

If attaching Reddit screenshots, use Chrome MCP. If Reddit cannot attach an image to an existing comment, reply to the update comment with the image.

Current v0.2.0 announcement references:

1. Release: `https://github.com/patlux/pi-chatgpt-limit/releases/tag/v0.2.0`
2. Reddit update comment: `https://www.reddit.com/r/PiCodingAgent/comments/1t17kz8/comment/oksq06u/`
3. Reddit screenshot reply: `https://www.reddit.com/r/PiCodingAgent/comments/1t17kz8/comment/oksqdwa/`

Validation:

Run relevant checks after changes:

```sh
npm test
npm run typecheck
npm run format:check
```

If validation cannot run, report why and what was checked instead.
