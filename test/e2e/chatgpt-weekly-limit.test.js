import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"

const EXTENSION_PATH = resolve("extensions/chatgpt-weekly-limit.js")

function encodeBase64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function fakeJwt(payload) {
  return `${encodeBase64Url({ alg: "none" })}.${encodeBase64Url(payload)}.`
}

async function startUsageServer(handler) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    await handler(req, res)
  })

  server.listen(0, "127.0.0.1")
  await once(server, "listening")

  const { port } = server.address()
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/backend-api`,
    close: () =>
      new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      ),
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function scriptCommand(outputFile, command, args) {
  if (process.platform === "darwin")
    return ["script", ["-q", outputFile, command, ...args]]

  return [
    "script",
    ["-q", "-c", [command, ...args].map(shellQuote).join(" "), outputFile],
  ]
}

async function readIfExists(path) {
  if (!existsSync(path)) return ""
  return readFile(path, "utf8")
}

async function waitForOutput(path, predicate, timeoutMs = 8000) {
  const startedAt = Date.now()
  let output = ""

  while (Date.now() - startedAt < timeoutMs) {
    output = await readIfExists(path)
    if (predicate(output)) return output
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }

  return output
}

function tclDoubleQuote(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")}"`
}

function expectSendLiteral(value) {
  return String(value).replaceAll('"', '\\"')
}

function expectBlock(pattern) {
  return `expect {\n  ${tclDoubleQuote(pattern)} {}\n  timeout { exit 1 }\n  eof { exit 1 }\n}`
}

function buildPiArgs(apiKey) {
  return [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-session",
    "--extension",
    EXTENSION_PATH,
    "--provider",
    "openai-codex",
    "--model",
    "gpt-5.5",
    "--api-key",
    apiKey,
  ]
}

async function runRealPiTui({
  baseUrl,
  apiKey,
  extraEnv = {},
  timeoutMs = 8000,
}) {
  if (
    spawnSync("script", ["--version"], { stdio: "ignore" }).error?.code ===
    "ENOENT"
  ) {
    throw new Error(
      "The `script` command is required for real pi TUI e2e tests.",
    )
  }

  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-limit-e2e-"))
  const outputFile = join(tempDir, "typescript.log")
  const agentDir = join(tempDir, "agent")
  const sessionDir = join(tempDir, "sessions")

  const piArgs = buildPiArgs(apiKey)

  const [command, args] = scriptCommand(outputFile, "pi", piArgs)
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CHATGPT_BASE_URL: baseUrl,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      TERM: "xterm-256color",
      NO_COLOR: "0",
      ...extraEnv,
    },
  })

  try {
    const output = await waitForOutput(
      outputFile,
      (text) => text.includes("42%") && text.includes("gpt-5.5"),
      timeoutMs,
    )
    return { output, outputFile }
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {}
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function runRealPiTuiExpect({
  baseUrl,
  apiKey,
  mainKeys,
  optionKeys,
  submenuText,
  expectText,
  extraEnv = {},
  timeoutMs = 12000,
}) {
  if (
    spawnSync("expect", ["-v"], { stdio: "ignore" }).error?.code === "ENOENT"
  ) {
    throw new Error(
      "The `expect` command is required for interactive e2e tests.",
    )
  }

  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-limit-expect-"))
  const outputFile = join(tempDir, "expect.log")
  const expectFile = join(tempDir, "test.exp")
  const agentDir = join(tempDir, "agent")
  const sessionDir = join(tempDir, "sessions")
  const piArgs = buildPiArgs(apiKey).map(tclDoubleQuote).join(" ")
  const env = {
    CHATGPT_BASE_URL: baseUrl,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    TERM: "xterm-256color",
    NO_COLOR: "0",
    COLUMNS: "160",
    LINES: "40",
    ...extraEnv,
  }
  const envLines = Object.entries(env)
    .map(([key, value]) => `set env(${key}) ${tclDoubleQuote(value)}`)
    .join("\n")

  await writeFile(
    expectFile,
    `log_file -noappend ${tclDoubleQuote(outputFile)}
set timeout ${Math.ceil(timeoutMs / 1000)}
${envLines}
spawn pi ${piArgs}
set pi_pid [exp_pid]
stty columns 160 rows 40
after 1500
send "/chatgpt-limit\\r"
${expectBlock("Configure footer display mode")}
send "${expectSendLiteral(mainKeys)}"
${expectBlock(submenuText)}
send "${expectSendLiteral(optionKeys)}"
${expectBlock(expectText)}
catch {exec kill -TERM $pi_pid}
after 100
catch {exec kill -KILL $pi_pid}
close
`,
  )

  try {
    const child = spawn("expect", [expectFile], {
      detached: true,
      stdio: "ignore",
    })
    const status = await new Promise((resolveClose) => {
      child.on("close", (code) => resolveClose(code))
    })
    const output = await readIfExists(outputFile)
    assert.equal(status, 0, output)
    return output
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

test("real pi TUI renders the ChatGPT weekly percentage in the footer", async () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_test",
      chatgpt_plan_type: "pro",
    },
    "https://api.openai.com/profile": {
      email: "user@example.com",
    },
  })

  const server = await startUsageServer((req, res) => {
    assert.equal(req.url, "/backend-api/wham/usage")
    assert.equal(req.headers.authorization, `Bearer ${token}`)
    assert.equal(req.headers["chatgpt-account-id"], "acct_test")

    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            used_percent: 25.4,
            limit_window_seconds: 5 * 60 * 60,
            reset_at: Math.floor(Date.now() / 1000) + 3600,
          },
          secondary_window: {
            used_percent: 42.2,
            limit_window_seconds: 7 * 24 * 60 * 60,
            reset_at: Math.floor(Date.now() / 1000) + 86400,
          },
        },
      }),
    )
  })

  try {
    const { output } = await runRealPiTui({
      baseUrl: server.baseUrl,
      apiKey: token,
    })

    assert.ok(
      server.requests.length > 0,
      "expected real pi extension to call the mocked ChatGPT usage API",
    )
    assert.match(output, /gpt-5\.5/)
    assert.match(output, /42%/)
  } finally {
    await server.close()
  }
})

test("real pi TUI previews and saves footer display configuration options", async (t) => {
  const down = "\\033\\[B"
  const enter = "\\r"
  const displayModeMenu = `${down}${down}${enter}`
  const footerLimitMenu = `${down}${enter}`
  const cases = [
    {
      name: "5-hour limit",
      mainKeys: footerLimitMenu,
      optionKeys: `${down}${enter}`,
      submenuText: "Display which ChatGPT limit in footer?",
      expectText: "ChatGPT footer display: 5-hour usage",
    },
    {
      name: "both 5-hour and weekly limits",
      mainKeys: footerLimitMenu,
      optionKeys: `${down}${down}${enter}`,
      submenuText: "Display which ChatGPT limit in footer?",
      expectText: "ChatGPT footer display: Both 5-hour and weekly",
    },
    {
      name: "hidden footer limit",
      mainKeys: footerLimitMenu,
      optionKeys: `${down}${down}${down}${enter}`,
      submenuText: "Display which ChatGPT limit in footer?",
      expectText: "ChatGPT footer display: Hide usage from footer",
    },
    {
      name: "used percent with reset",
      mainKeys: displayModeMenu,
      optionKeys: `${down}${enter}`,
      submenuText: "How should the footer value be shown?",
      expectText:
        "ChatGPT footer mode: Used percent with reset, e.g. W 42% · ~2d",
    },
    {
      name: "remaining percent",
      mainKeys: displayModeMenu,
      optionKeys: `${down}${down}${enter}`,
      submenuText: "How should the footer value be shown?",
      expectText: "ChatGPT footer mode: Remaining percent, e.g. W 58% left",
    },
    {
      name: "remaining percent with reset",
      mainKeys: displayModeMenu,
      optionKeys: `${down}${down}${down}${enter}`,
      submenuText: "How should the footer value be shown?",
      expectText:
        "ChatGPT footer mode: Remaining percent with reset, e.g. W 58% left · ~2d",
    },
  ]

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const token = fakeJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_config" },
      })
      const server = await startUsageServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: 25,
                limit_window_seconds: 5 * 60 * 60,
                reset_at: Math.floor(Date.now() / 1000) + 2 * 60 * 60,
              },
              secondary_window: {
                used_percent: 42,
                limit_window_seconds: 7 * 24 * 60 * 60,
                reset_at: Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60,
              },
            },
          }),
        )
      })

      try {
        await runRealPiTuiExpect({
          baseUrl: server.baseUrl,
          apiKey: token,
          mainKeys: testCase.mainKeys,
          optionKeys: testCase.optionKeys,
          submenuText: testCase.submenuText,
          expectText: testCase.expectText,
        })
      } finally {
        await server.close()
      }
    })
  }
})

test("real pi TUI still fetches usage when PI_OFFLINE is set", async () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_offline" },
  })

  const server = await startUsageServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 1,
            limit_window_seconds: 5 * 60 * 60,
            reset_at: Math.floor(Date.now() / 1000) + 3600,
          },
          secondary_window: {
            used_percent: 42,
            limit_window_seconds: 7 * 24 * 60 * 60,
            reset_at: Math.floor(Date.now() / 1000) + 86400,
          },
        },
      }),
    )
  })

  try {
    const { output } = await runRealPiTui({
      baseUrl: server.baseUrl,
      apiKey: token,
      extraEnv: { PI_OFFLINE: "1" },
    })

    assert.ok(
      server.requests.length > 0,
      "expected usage fetch even when PI_OFFLINE=1",
    )
    assert.match(output, /42%/)
  } finally {
    await server.close()
  }
})
