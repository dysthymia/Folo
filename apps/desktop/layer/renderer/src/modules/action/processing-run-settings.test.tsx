import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ProcessingEditor,
  ProcessingInput,
  ProcessingRelease,
  ProcessingScheduleConfig,
} from "./processing-client"
import { defaultProcessingSchedule, ProcessingRunSettings } from "./processing-run-settings"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // 测试保留翻译 key，便于通过可访问名称定位真实控件。
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}))

const clientMock = {
  saveSchedule: vi.fn(),
  releaseRuleSet: vi.fn(),
  startRun: vi.fn(),
}

const source: ProcessingEditor["sources"][number] = {
  key: "feed:1",
  kind: "feed",
  id: "1",
  title: "Feed",
  view: 0,
  category: null,
}

const schedule: ProcessingScheduleConfig = {
  sourceKeys: [source.key],
  historySince: "2026-09-01T00:00:00.000Z",
  timeZone: "Asia/Shanghai",
  enabled: true,
  times: ["09:00", "12:00", "15:00", "18:00", "21:00"],
  pollIntervalMinutes: null,
  readyBy: null,
}

const input: ProcessingInput = {
  seq: 1,
  sourceKey: source.key,
  itemId: "entry-1",
  status: "pending",
}

const release: ProcessingRelease = {
  version: 4,
  targetInputIds: [1, 2, 3],
}

const findButton = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === label,
  )

const getReactProps = <T extends object>(element: HTMLElement): T => {
  const key = Object.keys(element).find((item) => item.startsWith("__reactProps"))
  if (!key) throw new Error("React props not found")
  return (element as unknown as Record<string, T>)[key] as T
}

describe("ProcessingRunSettings", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    clientMock.saveSchedule.mockResolvedValue({})
    clientMock.releaseRuleSet.mockResolvedValue(release)
    clientMock.startRun.mockResolvedValue({ id: "run-1", status: "queued" })
    clientMock.saveSchedule.mockClear()
    clientMock.releaseRuleSet.mockClear()
    clientMock.startRun.mockClear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  const render = async (
    overrides: Partial<React.ComponentProps<typeof ProcessingRunSettings>> = {},
  ) => {
    const callbacks = {
      onChange: vi.fn(),
      onScopeChange: vi.fn(),
      onRecentSinceChange: vi.fn(),
      onSelectedInputIdsChange: vi.fn(),
      onSave: vi.fn(),
      onRelease: vi.fn(),
      onRun: vi.fn(),
    }
    const props: React.ComponentProps<typeof ProcessingRunSettings> = {
      sources: [source],
      inputs: [input],
      runs: [],
      value: schedule,
      scope: { mode: "future" },
      recentSince: "2026-09-01",
      selectedInputIds: [],
      release: null,
      draftDirty: false,
      saving: false,
      releasing: false,
      running: false,
      canRun: false,
      scheduleValid: true,
      ...callbacks,
      onSave: vi.fn(() => {
        callbacks.onSave()
        return clientMock.saveSchedule()
      }),
      onRelease: vi.fn(() => {
        callbacks.onRelease()
        return clientMock.releaseRuleSet()
      }),
      onRun: vi.fn(() => {
        callbacks.onRun()
        return clientMock.startRun()
      }),
      ...overrides,
    }
    await act(async () => root!.render(<ProcessingRunSettings {...props} />))
    return callbacks
  }

  it("默认计划使用服务端约定的五个时点", () => {
    expect(defaultProcessingSchedule().times).toEqual(["08:00", "12:00", "15:00", "20:00", "23:00"])
  })

  it("按计划时区显示历史日期而不是直接截取 UTC 日期", async () => {
    await render({
      value: {
        ...schedule,
        historySince: "2026-09-11T16:00:00.000Z",
        timeZone: "Asia/Shanghai",
      },
    })

    expect(container!.querySelector<HTMLInputElement>("input[type='date']")?.value).toBe(
      "2026-09-12",
    )
  })

  it("历史时间或时区无效时安全保留输入并继续显示时区校验", async () => {
    await render({
      value: { ...schedule, historySince: "invalid", timeZone: "Invalid/Timezone" },
      scheduleValid: false,
    })

    expect(container!.querySelector<HTMLInputElement>("input[type='date']")?.value).toBe("")
    expect(container!.textContent).toContain("processing.run.timezone_invalid")
  })

  it("没有选择来源时禁用保存", async () => {
    await render({ sources: [], value: { ...schedule, sourceKeys: [] } })

    expect(findButton(container!, "processing.run.save_schedule")?.disabled).toBe(true)
  })

  it("草稿未保存时禁用发布", async () => {
    await render({ draftDirty: true })

    expect(findButton(container!, "processing.run.release_action")?.disabled).toBe(true)
  })

  it("selected scope 必须有非空 targets", async () => {
    await render({ scope: { mode: "selected", inputIds: [] } })
    expect(findButton(container!, "processing.run.release_action")?.disabled).toBe(true)

    await act(async () =>
      root!.render(
        <ProcessingRunSettings
          sources={[source]}
          inputs={[input]}
          runs={[]}
          value={schedule}
          scope={{ mode: "selected", inputIds: [input.seq] }}
          recentSince="2026-09-01"
          selectedInputIds={[input.seq]}
          release={null}
          draftDirty={false}
          saving={false}
          releasing={false}
          running={false}
          canRun={false}
          scheduleValid={true}
          onChange={vi.fn()}
          onScopeChange={vi.fn()}
          onRecentSinceChange={vi.fn()}
          onSelectedInputIdsChange={vi.fn()}
          onSave={vi.fn()}
          onRelease={vi.fn()}
          onRun={vi.fn()}
        />,
      ),
    )
    expect(findButton(container!, "processing.run.release_action")?.disabled).toBe(false)
  })

  it("保存计划只调用保存，不触发发布或运行", async () => {
    const callbacks = await render()
    await act(async () => findButton(container!, "processing.run.save_schedule")?.click())

    expect(callbacks.onSave).toHaveBeenCalledTimes(1)
    expect(clientMock.saveSchedule).toHaveBeenCalledTimes(1)
    expect(callbacks.onRelease).not.toHaveBeenCalled()
    expect(callbacks.onRun).not.toHaveBeenCalled()
  })

  it("按计划时区把历史日期转换为本地午夜", async () => {
    const callbacks = await render()
    const history = container!.querySelector<HTMLInputElement>("input[type='date']")!
    history.value = "2026-09-01"
    await act(async () => {
      getReactProps<{ onChange?: (event: { target: HTMLInputElement }) => void }>(
        history,
      ).onChange?.({ target: history })
    })

    expect(callbacks.onChange).toHaveBeenLastCalledWith({
      ...schedule,
      historySince: "2026-08-31T16:00:00.000Z",
    })
  })

  it("计划仍有本地修改时禁用手动运行", async () => {
    const callbacks = await render({ release, canRun: false })
    const runButton = findButton(container!, "processing.run.now")!

    expect(runButton.disabled).toBe(true)
    await act(async () => runButton.click())
    expect(callbacks.onRun).not.toHaveBeenCalled()
  })

  it("future 发布显示服务冻结的 target 数量", async () => {
    const callbacks = await render({ release, inputs: [input] })

    expect(container!.textContent).toContain("processing.run.release_target_count")
    expect(container!.textContent).toContain("processing.run.release_target_count:3")
    await act(async () => findButton(container!, "processing.run.release_action")?.click())
    expect(callbacks.onRelease).toHaveBeenCalledTimes(1)
    expect(clientMock.releaseRuleSet).toHaveBeenCalledTimes(1)
    expect(callbacks.onRun).not.toHaveBeenCalled()
  })

  it("保存请求失败时不显示成功状态", async () => {
    const callbacks = await render()
    clientMock.saveSchedule.mockRejectedValueOnce(new Error("request failed"))
    await act(async () => findButton(container!, "processing.run.save_schedule")?.click())

    expect(callbacks.onSave).toHaveBeenCalledTimes(1)
    expect(clientMock.saveSchedule).toHaveBeenCalledTimes(1)
    expect(container!.querySelector("[role='status']")).toBeNull()
    expect(container!.textContent).not.toContain("processing.run.saved")
  })
})
