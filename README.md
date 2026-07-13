# pi-chatgpt

A [pi](https://pi.dev) extension for ChatGPT Codex usage and Fast mode.

It shows configurable ChatGPT subscription usage next to the active Codex model, provides detailed 5-hour and weekly limits, and can request OpenAI Codex Fast mode for supported models.

## Preview

![Footer preview](https://github.com/patlux/pi-chatgpt-limit/releases/download/preview-assets/footer-preview.png)

Footer display variants and color thresholds:

![Footer display variants and color thresholds](https://github.com/patlux/pi-chatgpt-limit/releases/download/preview-assets/footer-variants-readable.png)

## Install

```sh
pi install https://github.com/SteelDynamite/pi-chatgpt.git
```

Then reload pi:

```txt
/reload
```

When upgrading from `pi-chatgpt-limit`, remove the old package after installing this one. Loading both packages causes duplicate commands, requests, and footer replacements.

## Usage limits

The footer percentage appears only while using an `openai-codex` model authenticated through pi's `/login` flow.

Run:

```txt
/chatgpt
```

This shows and configures:

- plan and account email when available
- 5-hour and weekly usage windows and reset times
- weekly, 5-hour, both, or hidden footer usage
- used, remaining, pace, and reset-time display variants

`/chatgpt-limit` remains as a compatibility alias.

Examples:

- `W 42%`
- `W 42% · ~2d`
- `W 58% left`
- `5h 25% / W 42%`

## Fast mode

Fast mode requests `service_tier: "priority"` only for the OpenAI-documented supported ChatGPT Codex models: GPT-5.4 and GPT-5.5.

```txt
/fast temporary   Enable for this running session only
/fast persistent  Enable now and for future sessions
/fast off         Disable now and clear persistent enablement
```

Each command confirms the change. The footer shows `Fast` only when Fast mode is enabled and the active model supports it.

Fast mode increases supported model speed and consumes ChatGPT credits faster. OpenAI currently documents 2× Standard consumption for GPT-5.4 and 2.5× for GPT-5.5.

The extension exports the current effective value as `PI_CHATGPT_FAST=1|0`, so newly launched subprocesses inherit it. The previous environment value is restored when the session shuts down. A temporary setting is not written to disk and is lost on reload, session replacement, or process exit.

## Configuration and migration

Settings persist globally in:

```txt
~/.pi/agent/chatgpt.json
```

The file stores footer preferences and persistent Fast mode. On first load, legacy `~/.pi/agent/chatgpt-limit.json` settings are migrated without deleting the old file. Legacy session footer entries and `/chatgpt-limit` continue to work.

## Endpoint and security

Usage is fetched from:

```txt
GET https://chatgpt.com/backend-api/wham/usage
```

The request uses the OAuth token already stored by pi for the active `openai-codex` provider. By default, bearer tokens are sent only to HTTPS URLs on the `https://chatgpt.com` origin.

`CHATGPT_BASE_URL` can override the endpoint path on that origin. To use a non-ChatGPT testing or proxy URL, set `CHATGPT_TRUST_CUSTOM_BASE_URL=1` only for trusted infrastructure. The legacy `CHATGPT_LIMIT_TRUST_CUSTOM_BASE_URL` name remains supported.

Extensions run with local user permissions and can access pi auth storage. Review extensions before installing them.

## Publish

```sh
npm login
npm publish --access public
```

## License

MIT
