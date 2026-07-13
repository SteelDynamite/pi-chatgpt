import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import extension, { __test__ } from "../../extensions/chatgpt.js"

const EXTENSION_PATH = resolve("extensions/chatgpt.js")
const HAS_SCRIPT = !spawnSync("script", ["--version"], {
  stdio: "ignore",
}).error
const HAS_EXPECT = !spawnSync("expect", ["-v"], { stdio: "ignore" }).error
const SCRIPT_SKIP = HAS_SCRIPT
  ? false
  : "requires the `script` command for real pi TUI e2e coverage"
const EXPECT_SKIP = HAS_EXPECT
  ? false
  : "requires the `expect` command for interactive real pi TUI e2e coverage"

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

function sendUsageResponse(res, options = {}) {
  const {
    planType,
    fiveHourUsed = 25,
    weeklyUsed = 42,
    fiveHourResetSeconds = 2 * 60 * 60,
    weeklyResetSeconds = 2 * 24 * 60 * 60,
  } = options

  res.writeHead(200, { "content-type": "application/json" })
  res.end(
    JSON.stringify({
      ...(planType ? { plan_type: planType } : {}),
      rate_limit: {
        primary_window: {
          used_percent: fiveHourUsed,
          limit_window_seconds: 5 * 60 * 60,
          reset_at: Math.floor(Date.now() / 1000) + fiveHourResetSeconds,
        },
        secondary_window: {
          used_percent: weeklyUsed,
          limit_window_seconds: 7 * 24 * 60 * 60,
          reset_at: Math.floor(Date.now() / 1000) + weeklyResetSeconds,
        },
      },
    }),
  )
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

function stripEscapedAnsi(value) {
  return String(value)
    .replace(/\\u001b\][^\n]*?\\u0007/g, "")
    .replace(/\\u001b\[[0-?]*[ -/]*[@-~]/g, "")
}

async function readTuiDebugOutput() {
  try {
    const files = await readdir("/tmp/tui")
    const contents = await Promise.all(
      files.map((file) => readIfExists(join("/tmp/tui", file))),
    )
    const output = contents.join("\n")
    return `${output}\n${stripEscapedAnsi(output)}`
  } catch {
    return ""
  }
}

async function waitForOutput(
  path,
  predicate,
  timeoutMs = 8000,
  readExtraOutput = async () => "",
) {
  const startedAt = Date.now()
  let output = ""

  while (Date.now() - startedAt < timeoutMs) {
    output = `${await readIfExists(path)}\n${await readExtraOutput()}`
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

function stripAnsi(value) {
  return String(value)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
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
  initialConfig,
  trustEnvName = "CHATGPT_TRUST_CUSTOM_BASE_URL",
  waitFor = (text) => text.includes("42%") && text.includes("gpt-5.5"),
  settleMs = 0,
  timeoutMs = 8000,
}) {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-e2e-"))
  const outputFile = join(tempDir, "typescript.log")
  const agentDir = join(tempDir, "agent")
  const sessionDir = join(tempDir, "sessions")

  if (initialConfig) {
    await mkdir(agentDir, { recursive: true })
    await writeFile(
      join(agentDir, "chatgpt.json"),
      `${JSON.stringify(initialConfig, null, 2)}\n`,
    )
  }

  const piArgs = buildPiArgs(apiKey)
  await rm("/tmp/tui", { recursive: true, force: true })

  const [command, args] = scriptCommand(outputFile, "pi", piArgs)
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CHATGPT_BASE_URL: baseUrl,
      [trustEnvName]: "1",
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      TERM: "xterm-256color",
      NO_COLOR: "0",
      COLUMNS: "160",
      LINES: "40",
      PI_TUI_DEBUG: "1",
      ...extraEnv,
    },
  })

  try {
    let output = await waitForOutput(
      outputFile,
      waitFor,
      timeoutMs,
      readTuiDebugOutput,
    )
    if (settleMs > 0) {
      await new Promise((resolveWait) => setTimeout(resolveWait, settleMs))
      output = `${await readIfExists(outputFile)}\n${await readTuiDebugOutput()}`
    }
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
    await rm("/tmp/tui", { recursive: true, force: true })
  }
}

async function runRealPiTuiExpect({
  baseUrl,
  apiKey,
  mainKeys,
  optionKeys,
  submenuText,
  expectText,
  expectedConfig,
  initialConfig,
  scriptBody,
  commandText = "/chatgpt",
  settleMs = 100,
  extraEnv = {},
  timeoutMs = 12000,
}) {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-expect-"))
  const outputFile = join(tempDir, "expect.log")
  const expectFile = join(tempDir, "test.exp")
  const agentDir = join(tempDir, "agent")
  const sessionDir = join(tempDir, "sessions")
  if (initialConfig) {
    await mkdir(agentDir, { recursive: true })
    await writeFile(
      join(agentDir, "chatgpt.json"),
      `${JSON.stringify(initialConfig, null, 2)}\n`,
    )
  }

  const piArgs = buildPiArgs(apiKey).map(tclDoubleQuote).join(" ")
  const env = {
    CHATGPT_BASE_URL: baseUrl,
    CHATGPT_TRUST_CUSTOM_BASE_URL: "1",
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

  const body =
    scriptBody ??
    `${expectBlock("Configure footer display mode")}
send "${expectSendLiteral(mainKeys)}"
${expectBlock(submenuText)}
send "${expectSendLiteral(optionKeys)}"
${expectBlock(expectText)}`

  await writeFile(
    expectFile,
    `log_file -noappend ${tclDoubleQuote(outputFile)}
set timeout ${Math.ceil(timeoutMs / 1000)}
${envLines}
spawn pi ${piArgs}
set pi_pid [exp_pid]
stty columns 160 rows 40
after 1500
send "${expectSendLiteral(commandText)}\\r"
${body}
after ${settleMs}
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
    if (expectedConfig) {
      assert.deepEqual(
        JSON.parse(await readFile(join(agentDir, "chatgpt.json"), "utf8")),
        { ...expectedConfig, fastMode: expectedConfig.fastMode ?? false },
      )
    }
    return output
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

test("skips automatic footer and usage work outside TUI mode", async () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-mode-"))
  process.env.PI_CODING_AGENT_DIR = tempDir

  try {
    for (const mode of ["rpc", "json", "print"]) {
      const handlers = new Map()
      let footerInstalls = 0
      let usageAuthCalls = 0

      extension({
        on(eventName, handler) {
          handlers.set(eventName, handler)
        },
        registerCommand() {},
      })

      const ctx = {
        mode,
        model: { provider: "openai-codex", id: "gpt-5.5" },
        modelRegistry: {
          getApiKeyAndHeaders: async () => {
            usageAuthCalls++
            return { ok: false }
          },
        },
        sessionManager: {
          getBranch: () => [],
        },
        ui: {
          setFooter: () => {
            footerInstalls++
          },
        },
      }

      await handlers.get("session_start")?.({}, ctx)
      handlers.get("model_select")?.({}, ctx)
      handlers.get("agent_end")?.({}, ctx)
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))

      assert.equal(footerInstalls, 0, `${mode} should not install footer`)
      assert.equal(usageAuthCalls, 0, `${mode} should not fetch usage`)
    }
  } finally {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir
    }
    await rm(tempDir, { recursive: true, force: true })
  }
})

test("installs footer when ctx.mode is unavailable but process looks interactive", async () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const originalIsTTY = process.stdin.isTTY
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-fallback-"))
  process.env.PI_CODING_AGENT_DIR = tempDir
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  })

  try {
    const handlers = new Map()
    let footerInstalls = 0
    let usageAuthCalls = 0

    extension({
      on(eventName, handler) {
        handlers.set(eventName, handler)
      },
      registerCommand() {},
    })

    const ctx = {
      model: { provider: "openai-codex", id: "gpt-5.5" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => {
          usageAuthCalls++
          return { ok: false }
        },
      },
      sessionManager: {
        getBranch: () => [],
      },
      ui: {
        setFooter: () => {
          footerInstalls++
        },
      },
    }

    await handlers.get("session_start")?.({}, ctx)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))

    assert.equal(footerInstalls, 1)
    assert.equal(usageAuthCalls, 1)
  } finally {
    if (originalIsTTY === undefined) {
      delete process.stdin.isTTY
    } else {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      })
    }
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir
    }
    await rm(tempDir, { recursive: true, force: true })
  }
})

test("parses usage snapshots and token metadata without a TUI", () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_unit",
      chatgpt_plan_type: "pro",
    },
    "https://api.openai.com/profile": { email: "unit@example.com" },
  })

  assert.deepEqual(__test__.getTokenMetadata(token), {
    accountId: "acct_unit",
    planType: "pro",
    email: "unit@example.com",
  })

  const snapshot = __test__.parseUsageSnapshot({
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        used_percent: 25.4,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: 123,
      },
      secondary_window: {
        used_percent: 42.2,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: 456,
      },
    },
  })

  assert.equal(snapshot.planType, "pro")
  assert.equal(snapshot.fiveHour.usedPercent, 25.4)
  assert.equal(snapshot.weekly.usedPercent, 42.2)
})

test("validates ChatGPT base URL before bearer token use", () => {
  assert.deepEqual(__test__.resolveChatGptBaseUrl(undefined), {
    ok: true,
    url: "https://chatgpt.com/backend-api",
    reason: undefined,
  })
  assert.equal(
    __test__.resolveChatGptBaseUrl("https://chatgpt.com/backend-api/").url,
    "https://chatgpt.com/backend-api",
  )
  assert.equal(
    __test__.resolveChatGptBaseUrl("http://chatgpt.com/backend-api").ok,
    false,
  )
  assert.equal(
    __test__.resolveChatGptBaseUrl("https://example.com/backend-api").ok,
    false,
  )
  assert.equal(
    __test__.resolveChatGptBaseUrl("http://127.0.0.1:123/backend-api", true)
      .url,
    "http://127.0.0.1:123/backend-api",
  )
})

test("normalizes config and formats percentages without a TUI", () => {
  assert.deepEqual(
    __test__.normalizeFooterConfig({
      quotaWindow: "both",
      displayMode: "pace",
    }),
    { quotaWindow: "both", displayMode: "pace" },
  )
  assert.deepEqual(
    __test__.normalizeFooterConfig({ quotaWindow: "bad", displayMode: "bad" }),
    { quotaWindow: "weekly", displayMode: "used" },
  )
  assert.equal(__test__.formatUsedPercent({ usedPercent: 42.6 }), "43%")
  assert.equal(__test__.formatRemainingPercent({ usedPercent: 42.2 }), "58%")
  assert.equal(__test__.isOpenAICodexProvider("openai-codex-2"), true)
  assert.equal(
    __test__.isFastSupportedModel({
      provider: "openai-codex",
      id: "gpt-5.4",
    }),
    true,
  )
  assert.equal(
    __test__.isFastSupportedModel({
      provider: "openai-codex",
      id: "gpt-5.5",
    }),
    true,
  )
  assert.equal(
    __test__.isFastSupportedModel({
      provider: "openai-codex",
      id: "gpt-5.4-mini",
    }),
    false,
  )
  assert.equal(
    __test__.isFastSupportedModel({ provider: "openai", id: "gpt-5.5" }),
    false,
  )
  assert.deepEqual(__test__.addFastServiceTier({ model: "gpt-5.5" }), {
    model: "gpt-5.5",
    service_tier: "priority",
  })
  assert.equal(__test__.addFastServiceTier(null), undefined)
  assert.equal(__test__.parseFastEnv("1"), true)
  assert.equal(__test__.parseFastEnv("0"), false)
  assert.equal(__test__.parseFastEnv("true"), undefined)

  const ctx = {
    model: {
      provider: "openai-codex",
      id: "gpt-5.5",
      contextWindow: 1000,
    },
    sessionManager: {
      getEntries: () => [],
      getCwd: () => "/tmp/project",
      getSessionName: () => undefined,
    },
    modelRegistry: { isUsingOAuth: () => true },
    getContextUsage: () => ({ contextWindow: 1000, percent: 10 }),
  }
  const footerData = {
    getGitBranch: () => undefined,
    getAvailableProviderCount: () => 1,
  }
  const theme = { fg: (_color, text) => text }
  const pi = { getThinkingLevel: () => "off" }
  assert.match(
    __test__.renderFooter(pi, ctx, footerData, theme, 120, true).join("\n"),
    /gpt-5\.5 • Fast/,
  )
  ctx.model = {
    provider: "openai-codex",
    id: "gpt-5.4-mini",
    contextWindow: 1000,
  }
  assert.doesNotMatch(
    __test__.renderFooter(pi, ctx, footerData, theme, 120, true).join("\n"),
    /Fast/,
  )
})

test("detects TUI mode with context and process fallback", () => {
  const tuiCtx = { ui: { setFooter() {} } }

  assert.equal(
    __test__.isTuiContext({ ...tuiCtx, mode: "tui" }, ["-p"], false),
    true,
  )
  assert.equal(
    __test__.isTuiContext({ ...tuiCtx, mode: "interactive" }, ["-p"], false),
    true,
  )
  assert.equal(
    __test__.isTuiContext({ ...tuiCtx, mode: "rpc" }, [], true),
    false,
  )
  assert.equal(__test__.isTuiContext(tuiCtx, [], true), true)
  assert.equal(__test__.isTuiContext(tuiCtx, ["--mode", "rpc"], true), false)
  assert.equal(__test__.isTuiContext(tuiCtx, ["--mode=json"], true), false)
  assert.equal(__test__.isTuiContext(tuiCtx, ["--mode=paseo"], true), false)
  assert.equal(__test__.isTuiContext(tuiCtx, ["--print"], true), false)
  assert.equal(__test__.isTuiContext(tuiCtx, [], false), false)
  assert.equal(__test__.isTuiContext(tuiCtx, [], true, false), false)
  assert.equal(
    __test__.isTuiContext({ ...tuiCtx, hasUI: false }, [], true),
    false,
  )
})

test("Fast mode commands migrate config, patch supported payloads, and manage inheritance", async () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const originalFast = process.env.PI_CHATGPT_FAST
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-fast-"))
  process.env.PI_CODING_AGENT_DIR = tempDir
  process.env.PI_CHATGPT_FAST = "0"
  await writeFile(
    join(tempDir, "chatgpt-limit.json"),
    `${JSON.stringify({ quotaWindow: "both", displayMode: "remaining" })}\n`,
  )

  try {
    const handlers = new Map()
    const commands = new Map()
    const notifications = []
    extension({
      on(eventName, handler) {
        handlers.set(eventName, handler)
      },
      registerCommand(name, command) {
        commands.set(name, command)
      },
    })

    const ctx = {
      mode: "rpc",
      model: { provider: "openai-codex", id: "gpt-5.4" },
      sessionManager: { getBranch: () => [] },
      ui: { notify: (message) => notifications.push(message) },
    }

    await handlers.get("session_start")?.({}, ctx)
    assert.deepEqual(
      JSON.parse(await readFile(join(tempDir, "chatgpt.json"), "utf8")),
      { quotaWindow: "both", displayMode: "remaining", fastMode: false },
    )
    assert.ok(commands.has("chatgpt"))
    assert.ok(commands.has("chatgpt-limit"))
    assert.equal(process.env.PI_CHATGPT_FAST, "0")

    await commands.get("fast").handler("temporary", ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "1")
    assert.deepEqual(
      handlers.get("before_provider_request")?.(
        { payload: { model: "gpt-5.4", service_tier: "default" } },
        ctx,
      ),
      { model: "gpt-5.4", service_tier: "priority" },
    )

    ctx.model = { provider: "openai-codex", id: "gpt-5.4-mini" }
    handlers.get("model_select")?.({ model: ctx.model }, ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "0")
    assert.equal(
      handlers.get("before_provider_request")?.({ payload: {} }, ctx),
      undefined,
    )

    ctx.model = { provider: "openai-codex", id: "gpt-5.5" }
    handlers.get("model_select")?.({ model: ctx.model }, ctx)
    await commands.get("fast").handler("persistent", ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "1")
    assert.equal(
      JSON.parse(await readFile(join(tempDir, "chatgpt.json"), "utf8"))
        .fastMode,
      true,
    )

    await commands.get("fast").handler("off", ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "0")
    assert.equal(
      JSON.parse(await readFile(join(tempDir, "chatgpt.json"), "utf8"))
        .fastMode,
      false,
    )
    await commands.get("fast").handler("bad", ctx)
    assert.deepEqual(notifications, [
      "Fast mode enabled temporarily.",
      "Fast mode enabled persistently.",
      "Fast mode disabled.",
      "Usage: /fast temporary|persistent|off",
    ])

    await handlers.get("session_shutdown")?.({}, ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "0")
  } finally {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir
    }
    if (originalFast === undefined) {
      delete process.env.PI_CHATGPT_FAST
    } else {
      process.env.PI_CHATGPT_FAST = originalFast
    }
    await rm(tempDir, { recursive: true, force: true })
  }
})

test("RPC fallback configures footer when custom UI is unavailable", async () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-rpc-"))
  process.env.PI_CODING_AGENT_DIR = tempDir

  try {
    const handlers = new Map()
    let command
    let customCalls = 0
    const notifications = []
    const selectResponses = []

    extension({
      on(eventName, handler) {
        handlers.set(eventName, handler)
      },
      registerCommand(name, registeredCommand) {
        if (name === "chatgpt") command = registeredCommand
      },
    })

    const ctx = {
      mode: "rpc",
      sessionManager: { getBranch: () => [] },
      ui: {
        custom: async () => {
          customCalls++
          return undefined
        },
        select: async (_title, options) => {
          const response = selectResponses.shift()
          return typeof response === "function" ? response(options) : response
        },
        notify: (message) => notifications.push(message),
        confirm: async () => false,
      },
    }

    await handlers.get("session_start")?.({}, ctx)

    selectResponses.push(
      (options) =>
        options.find((option) => option.startsWith("Configure footer limit")),
      "Both 5-hour and weekly",
    )
    await command.handler([], ctx)
    assert.deepEqual(
      JSON.parse(await readFile(join(tempDir, "chatgpt.json"), "utf8")),
      { quotaWindow: "both", displayMode: "used", fastMode: false },
    )

    selectResponses.push(
      "Configure footer display mode",
      "Remaining percent, e.g. W 58% left",
    )
    await command.handler([], ctx)
    assert.deepEqual(
      JSON.parse(await readFile(join(tempDir, "chatgpt.json"), "utf8")),
      { quotaWindow: "both", displayMode: "remaining", fastMode: false },
    )
    assert.equal(customCalls, 2)
    assert.deepEqual(notifications, [
      "ChatGPT footer display: Both 5-hour and weekly",
      "ChatGPT footer mode: Remaining percent, e.g. W 58% left",
    ])
  } finally {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir
    }
    await rm(tempDir, { recursive: true, force: true })
  }
})

test(
  "real pi TUI renders the ChatGPT weekly percentage in the footer",
  { skip: SCRIPT_SKIP },
  async () => {
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

      sendUsageResponse(res, {
        planType: "pro",
        fiveHourUsed: 25.4,
        weeklyUsed: 42.2,
        fiveHourResetSeconds: 3600,
        weeklyResetSeconds: 86400,
      })
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
  },
)

test(
  "real pi TUI shows Fast only when effective",
  { skip: EXPECT_SKIP },
  async () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_fast" },
    })
    const server = await startUsageServer((_req, res) => {
      sendUsageResponse(res)
    })

    try {
      const output = await runRealPiTuiExpect({
        baseUrl: server.baseUrl,
        apiKey: token,
        commandText: "/fast temporary",
        scriptBody: `${expectBlock("Fast mode enabled temporarily.")}
${expectBlock("Fast")}`,
      })
      assert.match(stripAnsi(output), /Fast/)
    } finally {
      await server.close()
    }
  },
)

test(
  "real pi TUI loads global footer configuration",
  { skip: SCRIPT_SKIP },
  async (t) => {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_global" },
    })
    const server = await startUsageServer((_req, res) => {
      sendUsageResponse(res)
    })

    try {
      await t.test("custom display", async () => {
        const { output } = await runRealPiTui({
          baseUrl: server.baseUrl,
          apiKey: token,
          initialConfig: { quotaWindow: "both", displayMode: "remaining" },
          waitFor: (text) =>
            stripAnsi(text).includes("5h 75% left / W 58% left"),
        })

        assert.match(stripAnsi(output), /5h 75% left \/ W 58% left/)
      })

      await t.test("hidden display", async () => {
        const requestCount = server.requests.length
        const { output } = await runRealPiTui({
          baseUrl: server.baseUrl,
          apiKey: token,
          initialConfig: { quotaWindow: "hidden", displayMode: "used" },
          waitFor: (text) =>
            server.requests.length > requestCount &&
            stripAnsi(text).includes("gpt-5.5"),
          settleMs: 500,
        })

        assert.doesNotMatch(stripAnsi(output), /W 42%|5h 25%/)
      })
    } finally {
      await server.close()
    }
  },
)

test(
  "real pi TUI cancels footer previews and resets defaults",
  { skip: EXPECT_SKIP },
  async () => {
    const down = "\\033\\[B"
    const enter = "\\r"
    const escape = "\\033"
    const displayModeMenu = `${down}${down}${enter}`
    const resetMenu = `${down}${down}${down}${enter}`
    const defaultConfig = { quotaWindow: "weekly", displayMode: "used" }
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_reset" },
    })
    const server = await startUsageServer((_req, res) => {
      sendUsageResponse(res)
    })

    try {
      const previewOutput = await runRealPiTuiExpect({
        baseUrl: server.baseUrl,
        apiKey: token,
        initialConfig: defaultConfig,
        expectedConfig: defaultConfig,
        scriptBody: `${expectBlock("Configure footer display mode")}
send "${expectSendLiteral(displayModeMenu)}"
${expectBlock("How should the footer value be shown?")}
send "${expectSendLiteral(down)}"
${expectBlock("W 42% · ~2d")}
send "${expectSendLiteral(escape)}"
${expectBlock("gpt-5.5")}`,
      })
      const previewText = stripAnsi(previewOutput)
      const previewIndex = previewText.lastIndexOf("W 42% · ~2d")
      assert.ok(previewIndex >= 0, previewText)
      assert.ok(previewText.lastIndexOf("W 42%") > previewIndex, previewText)

      const resetOutput = await runRealPiTuiExpect({
        baseUrl: server.baseUrl,
        apiKey: token,
        initialConfig: { quotaWindow: "both", displayMode: "remainingCompact" },
        expectedConfig: defaultConfig,
        scriptBody: `${expectBlock("Reset footer settings to defaults")}
send "${expectSendLiteral(resetMenu)}"
${expectBlock("Reset ChatGPT footer settings?")}
send "${expectSendLiteral(enter)}"
${expectBlock("ChatGPT footer settings reset to defaults.")}`,
      })
      assert.match(stripAnsi(resetOutput), /settings reset to defaults/)
    } finally {
      await server.close()
    }
  },
)

test(
  "real pi TUI previews and saves footer display configuration options",
  { skip: EXPECT_SKIP },
  async (t) => {
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
        expectedConfig: { quotaWindow: "fiveHour", displayMode: "used" },
      },
      {
        name: "both 5-hour and weekly limits",
        mainKeys: footerLimitMenu,
        optionKeys: `${down}${down}${enter}`,
        submenuText: "Display which ChatGPT limit in footer?",
        expectText: "ChatGPT footer display: Both 5-hour and weekly",
        expectedConfig: { quotaWindow: "both", displayMode: "used" },
      },
      {
        name: "hidden footer limit",
        mainKeys: footerLimitMenu,
        optionKeys: `${down}${down}${down}${enter}`,
        submenuText: "Display which ChatGPT limit in footer?",
        expectText:
          "ChatGPT footer display: Hide usage from footer (usage hidden).",
        expectedConfig: { quotaWindow: "hidden", displayMode: "used" },
      },
      {
        name: "used percent with reset",
        mainKeys: displayModeMenu,
        optionKeys: `${down}${enter}`,
        submenuText: "How should the footer value be shown?",
        expectText:
          "ChatGPT footer mode: Used percent with reset, e.g. W 42% · ~2d",
        expectedConfig: { quotaWindow: "weekly", displayMode: "compact" },
      },
      {
        name: "pace percent with state",
        mainKeys: displayModeMenu,
        optionKeys: `${down}${down}${enter}`,
        submenuText: "How should the footer value be shown?",
        expectText:
          "ChatGPT footer mode: Pace percent with state, e.g. WP 13% (reserve)",
        expectedConfig: { quotaWindow: "weekly", displayMode: "pace" },
      },
      {
        name: "pace percent",
        mainKeys: displayModeMenu,
        optionKeys: `${down}${down}${down}${enter}`,
        submenuText: "How should the footer value be shown?",
        expectText: "ChatGPT footer mode: Pace percent, e.g. WP -13%",
        expectedConfig: { quotaWindow: "weekly", displayMode: "paceCompact" },
      },
      {
        name: "pace percent with reset",
        mainKeys: displayModeMenu,
        optionKeys: `${down}${down}${down}${down}${enter}`,
        submenuText: "How should the footer value be shown?",
        expectText:
          "ChatGPT footer mode: Pace percent with reset, e.g. WP -13% · ~2d",
        expectedConfig: {
          quotaWindow: "weekly",
          displayMode: "paceResetCompact",
        },
      },
      {
        name: "remaining percent",
        mainKeys: displayModeMenu,
        optionKeys: `${down}${down}${down}${down}${down}${enter}`,
        submenuText: "How should the footer value be shown?",
        expectText: "ChatGPT footer mode: Remaining percent, e.g. W 58% left",
        expectedConfig: { quotaWindow: "weekly", displayMode: "remaining" },
      },
      {
        name: "remaining percent with reset",
        mainKeys: displayModeMenu,
        optionKeys: `${down}${down}${down}${down}${down}${down}${enter}`,
        submenuText: "How should the footer value be shown?",
        expectText:
          "ChatGPT footer mode: Remaining percent with reset, e.g. W 58% left · ~2d",
        expectedConfig: {
          quotaWindow: "weekly",
          displayMode: "remainingCompact",
        },
      },
    ]

    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        const token = fakeJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_config" },
        })
        const server = await startUsageServer((_req, res) => {
          sendUsageResponse(res)
        })

        try {
          await runRealPiTuiExpect({
            baseUrl: server.baseUrl,
            apiKey: token,
            mainKeys: testCase.mainKeys,
            optionKeys: testCase.optionKeys,
            submenuText: testCase.submenuText,
            expectText: testCase.expectText,
            expectedConfig: testCase.expectedConfig,
          })
        } finally {
          await server.close()
        }
      })
    }
  },
)

test(
  "real pi TUI still fetches usage when PI_OFFLINE is set",
  { skip: SCRIPT_SKIP },
  async () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_offline" },
    })

    const server = await startUsageServer((_req, res) => {
      sendUsageResponse(res, {
        fiveHourUsed: 1,
        fiveHourResetSeconds: 3600,
        weeklyResetSeconds: 86400,
      })
    })

    try {
      const { output } = await runRealPiTui({
        baseUrl: server.baseUrl,
        apiKey: token,
        extraEnv: { PI_OFFLINE: "1" },
        trustEnvName: "CHATGPT_LIMIT_TRUST_CUSTOM_BASE_URL",
      })

      assert.ok(
        server.requests.length > 0,
        `expected usage fetch even when PI_OFFLINE=1; output was:\n${output}`,
      )
    } finally {
      await server.close()
    }
  },
)
