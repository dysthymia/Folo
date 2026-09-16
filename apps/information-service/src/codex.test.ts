import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"

import { join } from "pathe"

import { CodexRunError, runCodexJson } from "./codex.js"

const temporaryDirs: string[] = []
afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

const schema = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
}
const validate = (value: unknown): value is { summary: string } =>
  typeof value === "object" &&
  value !== null &&
  "summary" in value &&
  typeof value.summary === "string"

const fixture = async (body: string) => {
  const root = await mkdtemp(join(tmpdir(), "folo-codex-test-"))
  temporaryDirs.push(root)
  const command = join(root, "fake-codex")
  const runtimeDir = join(root, "runtime")
  await mkdir(runtimeDir)
  // 本地假 CLI 只模拟进程与 JSONL 协议，不读取认证，也不会进行付费模型调用。
  await writeFile(
    command,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const result = (value) => fs.writeFileSync(output, JSON.stringify(value));
${body}
`,
  )
  await chmod(command, 0o700)
  const run = (overrides: Partial<Parameters<typeof runCodexJson<{ summary: string }>>[0]> = {}) =>
    runCodexJson({
      command,
      runtimeDir,
      prompt: "仅总结这段中文文章。",
      model: "test-model",
      schema,
      validate,
      timeoutMs: 3_000,
      ...overrides,
    })
  return { root, runtimeDir, run }
}

const hasCode = (code: string) => (error: unknown) =>
  error instanceof CodexRunError && error.code === code

const waitForFile = async (path: string) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return await readFile(path, "utf8")
    } catch {
      await delay(10)
    }
  }
  throw new Error("Fake CLI did not become ready")
}

const assertStopped = (pid: number) => {
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH",
  )
}

test("passes private stdin, explicit model, isolated cwd and restrictions, then validates output", async () => {
  const f = await fixture(`
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => prompt += chunk);
process.stdin.on("end", () => {
  const snapshot = {args, prompt, cwd: process.cwd(), secretPassed: !!process.env.FOLO_TEST_SECRET, proxyPassed: process.env.HTTP_PROXY === "http://127.0.0.1:1234", nodeProxyPassed: process.env.NODE_USE_ENV_PROXY === "1"};
  fs.writeFileSync(require("node:path").join(process.cwd(), "../../observed.json"), JSON.stringify(snapshot));
  emit({type:"thread.started", thread_id:"fake"});
  emit({type:"item.completed", item:{type:"agent_message", text:"已完成"}});
  result({summary:"中文摘要"});
  emit({type:"turn.completed", usage:{input_tokens:20, output_tokens:4, cached_input_tokens:3}});
});`)
  const previousSecret = process.env.FOLO_TEST_SECRET
  const previousProxy = process.env.HTTP_PROXY
  const previousNodeProxy = process.env.NODE_USE_ENV_PROXY
  process.env.FOLO_TEST_SECRET = "must-not-pass"
  process.env.HTTP_PROXY = "http://127.0.0.1:1234"
  process.env.NODE_USE_ENV_PROXY = "1"
  try {
    const actual = await f.run()
    assert.equal(actual.result.summary, "中文摘要")
    assert.equal(actual.model, "test-model")
    assert.equal(actual.toolCalls, 0)
    assert.deepEqual(actual.usage, { inputTokens: 20, outputTokens: 4, cachedInputTokens: 3 })
    const observed = JSON.parse(await readFile(join(f.root, "observed.json"), "utf8")) as {
      args: string[]
      cwd: string
      prompt: string
      secretPassed: boolean
      proxyPassed: boolean
      nodeProxyPassed: boolean
    }
    assert.equal(observed.prompt, "仅总结这段中文文章。")
    assert.equal(observed.secretPassed, false)
    assert.equal(observed.proxyPassed, true)
    assert.equal(observed.nodeProxyPassed, true)
    assert.match(observed.cwd, /\/runtime\/codex-/)
    assert.equal(observed.args[observed.args.indexOf("-m") + 1], "test-model")
    for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--json"]) {
      assert.ok(observed.args.includes(flag))
    }
    assert.ok(observed.args.includes("features.shell_tool=false"))
    assert.ok(observed.args.includes('web_search="disabled"'))
    assert.ok(observed.args.includes("project_doc_max_bytes=0"))
    assert.ok(observed.args.includes("suppress_unstable_features_warning=true"))
    assert.deepEqual(
      (await readdir(f.runtimeDir)).filter((name) => name !== "codex-usage.jsonl"),
      [],
    )
  } finally {
    if (previousSecret === undefined) delete process.env.FOLO_TEST_SECRET
    else process.env.FOLO_TEST_SECRET = previousSecret
    if (previousProxy === undefined) delete process.env.HTTP_PROXY
    else process.env.HTTP_PROXY = previousProxy
    if (previousNodeProxy === undefined) delete process.env.NODE_USE_ENV_PROXY
    else process.env.NODE_USE_ENV_PROXY = previousNodeProxy
  }
})

test("never returns an incomplete result or treats missing output as success", async () => {
  const missing = await fixture('emit({type:"turn.completed"});')
  await assert.rejects(missing.run(), hasCode("MISSING_OUTPUT"))
  const invalid = await fixture('result({}); emit({type:"turn.completed"});')
  await assert.rejects(invalid.run(), hasCode("INVALID_OUTPUT"))
  const unfinished = await fixture('result({summary:"partial"});')
  await assert.rejects(unfinished.run(), hasCode("INCOMPLETE_TURN"))
})

test("Qianwen profile isolates Codex home and only passes the loopback token to the child", async () => {
  const f = await fixture(`
const home = process.env.CODEX_HOME;
const profile = fs.readFileSync(require('node:path').join(home, 'folo.config.toml'), 'utf8');
const catalog = JSON.parse(fs.readFileSync(require('node:path').join(home, 'models.json'), 'utf8')).models[0];
if (catalog.shell_type !== 'disabled' || !catalog.base_instructions.includes('"additionalProperties":false')) process.exit(6);
// macOS 的临时目录可能通过 /var -> /private/var 访问，比较规范化后的隔离路径。
if (!fs.realpathSync(home).startsWith(process.cwd()) || args.includes('--ignore-user-config') || !args.includes('--profile')) process.exit(2);
if (!profile.includes('model_provider = "folo_qianwen"') || !profile.includes('wire_api = "responses"')) process.exit(3);
if (profile.includes('test-only-key') || args.join(' ').includes('test-only-key')) process.exit(4);
// 真正的上游密钥不进入 CLI；临时 token 只能访问本任务的回环转换器。
if (process.env.FOLO_QIANWEN_API_KEY || !process.env.FOLO_QIANWEN_PROXY_TOKEN || process.env.FOLO_QIANWEN_PROXY_TOKEN === 'test-only-key' || process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) process.exit(5);
if (!profile.includes('http://127.0.0.1:') || !profile.includes('env_key = "FOLO_QIANWEN_PROXY_TOKEN"')) process.exit(7);
if (!process.env.NO_PROXY.includes('127.0.0.1')) process.exit(8);
result({summary:'isolated'});emit({type:'turn.completed'});`)
  const previousHome = process.env.CODEX_HOME
  const previousKey = process.env.FOLO_QIANWEN_API_KEY
  const result = await f.run({ qianwen: { apiKey: "test-only-key" } })
  assert.equal(result.result.summary, "isolated")
  assert.equal(process.env.CODEX_HOME, previousHome)
  assert.equal(process.env.FOLO_QIANWEN_API_KEY, previousKey)
  // 假 CLI 没有请求上游，不能把它补成零 token 的真实调用。
  assert.equal(result.usage, null)
  assert.deepEqual(
    (await readdir(f.runtimeDir)).filter((name) => name !== "codex-usage.jsonl"),
    [],
  )
})

test("missing usage stays unknown and validator exceptions stay private", async () => {
  const f = await fixture('result({summary:"done"}); emit({type:"turn.completed"});')
  assert.equal((await f.run()).usage, null)
  await assert.rejects(
    f.run({
      validate: (_value: unknown): _value is { summary: string } => {
        throw new Error("private article content")
      },
    }),
    hasCode("INVALID_OUTPUT"),
  )
})

test("suppresses raw failure details and never retries another model", async () => {
  const f = await fixture(`
fs.appendFileSync(require("node:path").join(process.cwd(), "../../attempts"), "attempt\\n");
process.stderr.write("private credential and article text");
process.exit(7);`)
  await assert.rejects(f.run(), (error: unknown) => {
    assert.ok(error instanceof CodexRunError)
    assert.equal(error.code, "PROCESS_FAILED")
    assert.equal(error.message, "Codex run failed: PROCESS_FAILED")
    return true
  })
  assert.equal(await readFile(join(f.root, "attempts"), "utf8"), "attempt\n")
  assert.deepEqual(
    (await readdir(f.runtimeDir)).filter((name) => name !== "codex-usage.jsonl"),
    [],
  )
})

test("classifies CLI error items as failures rather than tool activity", async () => {
  const f = await fixture(
    'emit({type:"item.completed",item:{type:"error",message:"private error detail"}}); setInterval(() => {},1000);',
  )
  await assert.rejects(f.run(), hasCode("PROCESS_FAILED"))
})

test("rejects malformed JSONL and malformed JSON result", async () => {
  const badEvent = await fixture(
    'process.stdout.write("not json\\n"); setInterval(() => {}, 1000);',
  )
  await assert.rejects(badEvent.run(), hasCode("INVALID_JSONL"))
  const badResult = await fixture(
    'fs.writeFileSync(output,"{broken"); emit({type:"turn.completed"});',
  )
  await assert.rejects(badResult.run(), hasCode("INVALID_OUTPUT"))
})

test("aborts tool events immediately even when the CLI would otherwise keep running", async () => {
  for (const tool of [
    "command_execution",
    "mcp_tool_call",
    "web_search",
    "file_change",
    "new_tool",
  ]) {
    const f = await fixture(`
emit({type:"item.started", item:{id:"tool",type:${JSON.stringify(tool)}}});
setInterval(() => {},1000);`)
    await assert.rejects(f.run(), hasCode("TOOL_CALL"))
    assert.deepEqual(
      (await readdir(f.runtimeDir)).filter((name) => name !== "codex-usage.jsonl"),
      [],
    )
  }
  const topLevel = await fixture('emit({type:"mcp.call"}); setInterval(() => {},1000);')
  await assert.rejects(topLevel.run(), hasCode("TOOL_CALL"))
})

test("enforces stream and final-file size limits", async () => {
  const stream = await fixture(
    'process.stderr.write("x".repeat(1024 * 1024 + 1)); setInterval(() => {},1000);',
  )
  await assert.rejects(stream.run(), hasCode("OUTPUT_LIMIT"))
  const file = await fixture(
    'result({summary:"x".repeat(1024 * 1024)}); emit({type:"turn.completed"});',
  )
  await assert.rejects(file.run(), hasCode("OUTPUT_LIMIT"))
})

test("rejects invalid options and cancellation before spawning", async () => {
  const f = await fixture('throw new Error("must not execute");')
  await assert.rejects(f.run({ model: " " }), hasCode("INVALID_OPTIONS"))
  await assert.rejects(f.run({ timeoutMs: 0 }), hasCode("INVALID_OPTIONS"))
  await assert.rejects(f.run({ signal: AbortSignal.abort() }), hasCode("ABORTED"))
  assert.deepEqual(
    (await readdir(f.runtimeDir)).filter((name) => name !== "codex-usage.jsonl"),
    [],
  )
})

test("reports spawn failure safely and removes the task directory", async () => {
  const f = await fixture("")
  await assert.rejects(f.run({ command: join(f.root, "missing-cli") }), hasCode("SPAWN_FAILED"))
  assert.deepEqual(
    (await readdir(f.runtimeDir)).filter((name) => name !== "codex-usage.jsonl"),
    [],
  )
})

test("timeout escalates TERM to KILL and waits for actual child exit before returning", async () => {
  const f = await fixture(`
process.on("SIGTERM", () => {});
fs.writeFileSync(require("node:path").join(process.cwd(), "../../pid"), String(process.pid));
setInterval(() => {},1000);`)
  const running = f.run({ timeoutMs: 1_500 })
  const rejected = assert.rejects(running, hasCode("TIMEOUT"))
  const pid = Number(await waitForFile(join(f.root, "pid")))
  await rejected
  assertStopped(pid)
  assert.deepEqual(
    (await readdir(f.runtimeDir)).filter((name) => name !== "codex-usage.jsonl"),
    [],
  )
})

test("active cancellation kills a TERM-resistant child before cleaning its cwd", async () => {
  const f = await fixture(`
process.on("SIGTERM", () => {});
fs.writeFileSync(require("node:path").join(process.cwd(), "../../pid"), String(process.pid));
setInterval(() => {},1000);`)
  const controller = new AbortController()
  const running = f.run({ signal: controller.signal })
  const rejected = assert.rejects(running, hasCode("ABORTED"))
  const pid = Number(await waitForFile(join(f.root, "pid")))
  controller.abort()
  await rejected
  assertStopped(pid)
  assert.deepEqual(
    (await readdir(f.runtimeDir)).filter((name) => name !== "codex-usage.jsonl"),
    [],
  )
})

test(
  "cancellation cleans a descendant even when its parent exits on TERM",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture(`
const path = require("node:path");
const grandchild = require("node:child_process").spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{}); process.stdout.write("ready"); setInterval(()=>{},1000)'], {stdio:["ignore","pipe","ignore"]});
grandchild.stdout.once("data", () => {
  fs.writeFileSync(path.join(process.cwd(), "../../pid"), String(grandchild.pid));
});
setInterval(() => {},1000);`)
    const controller = new AbortController()
    const running = f.run({ signal: controller.signal })
    const rejected = assert.rejects(running, hasCode("ABORTED"))
    const pid = Number(await waitForFile(join(f.root, "pid")))
    controller.abort()
    await rejected
    // 系统回收孤儿进程可能稍晚于进程组 KILL；这里只等待回收，不延长适配器时限。
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(pid, 0)
        await delay(10)
      } catch {
        break
      }
    }
    assertStopped(pid)
    assert.deepEqual(
      (await readdir(f.runtimeDir)).filter((name) => name !== "codex-usage.jsonl"),
      [],
    )
  },
)

test("invalid structured output retains measured usage without raw model text", async () => {
  const f = await fixture(
    'result({unexpected:"private-model-text"}); emit({type:"turn.completed",usage:{input_tokens:20,output_tokens:4,cached_input_tokens:3}});',
  )
  await assert.rejects(f.run(), (error: unknown) => {
    assert.ok(error instanceof CodexRunError)
    assert.equal(error.code, "INVALID_OUTPUT")
    assert.deepEqual(error.usage, { inputTokens: 20, outputTokens: 4, cachedInputTokens: 3 })
    assert.equal(error.message.includes("private-model-text"), false)
    return true
  })
})
