# pi-chatgpt

A [pi](https://pi.dev) extension for ChatGPT Codex usage and speed modes.

It shows configurable ChatGPT subscription usage next to the active Codex model, provides detailed 5-hour and weekly limits, and can request OpenAI Codex Fast or Ultrafast mode for supported models.

## Preview

![Footer preview](https://github.com/patlux/pi-chatgpt-limit/releases/download/preview-assets/footer-preview.png)

Footer display variants and color thresholds:

![Footer display variants and color thresholds](https://github.com/patlux/pi-chatgpt-limit/releases/download/preview-assets/footer-variants-readable.png)

## Install

```sh
pi install https://github.com/SteelDynamite/pi-chatgpt.git
```

For a first install, reload pi:

```txt
/reload
```

After updating an extension that is already loaded, use `/reload` first. If it still shows pre-update behavior, fully restart pi.

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

Live statuses from other extensions appear alphabetically at the top-right of the first footer row. Long status groups truncate on narrow terminals while preserving the project and session display.

## Speed modes

`/fast` selects one of three modes:

- **Standard** sends no `service_tier` override.
- **Fast** sends `service_tier: "priority"` for GPT-5.4, GPT-5.5, GPT-5.6 Sol (`gpt-5.6-sol`), GPT-5.6 Terra (`gpt-5.6-terra`), and GPT-5.6 Luna (`gpt-5.6-luna`).
- **Ultrafast** sends `service_tier: "ultrafast"`; initially, only `gpt-6-astra` is enabled.

```txt
/fast temporary [standard|fast|ultrafast]   Select for this session
/fast persistent [standard|fast|ultrafast]  Select now and for future sessions
/fast off                                   Select Standard persistently
/fast status                                Show selected and effective mode
```

Omitting the mode from `temporary` or `persistent` still selects Fast, preserving the existing commands. Unsupported models receive no override and the command reports why. The footer shows `Fast` or `Ultrafast` only when the selected mode is effective for the active model.

Selection is not gated by reported plan metadata because eligible Enterprise and Edu accounts may qualify. OpenAI remains responsible for account eligibility and can reject an unavailable tier.

Accelerated modes can consume ChatGPT credits faster. OpenAI currently documents 2× Standard consumption for GPT-5.4 and 2.5× for GPT-5.5. For the GPT-5.6 models, OpenAI documents 1.5× speed and only “increased usage,” without an exact usage multiplier.

The selected mode propagates to new subprocesses as `PI_CHATGPT_SPEED=standard|fast|ultrafast`. `PI_CHATGPT_FAST=1|0` remains the effective, model-aware compatibility signal (`1` for effective Fast or Ultrafast). Previous values are restored on shutdown. A temporary selection is not written to disk and is lost on reload, session replacement, or process exit.

## Configuration and migration

Settings persist globally in:

```txt
~/.pi/agent/chatgpt.json
```

The file stores footer preferences, `speedMode`, and the compatibility `fastMode` boolean. Existing `fastMode: true|false` values load as Fast or Standard and migrate on the next settings write. On first load, legacy `~/.pi/agent/chatgpt-limit.json` settings are migrated without deleting the old file. Legacy session footer entries and `/chatgpt-limit` continue to work.

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
