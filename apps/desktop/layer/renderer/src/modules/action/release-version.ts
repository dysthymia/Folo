import type { ProcessingRelease } from "./processing-client"

/**
 * 当前已生效版本 = 历史发布与「本次刚发布」里的最大版本号（§6 场景三要求明确当前用的是哪一版）。
 *
 * `editor.releases` 只在页面加载/刷新时取一次，刚发布的那一版不在里面；若只看历史列表，
 * 用户点完「保存并启用」看到的仍是上一版（实测：v4 已发布、提示仍写 v3）。
 * 只看 `release` 也不行——刷新后 `release` 会被清空，而历史列表才是此时的事实来源。
 */
export const resolveLiveReleaseVersion = (
  releases: readonly { version: number }[],
  release: Pick<ProcessingRelease, "version"> | null,
): number | null => {
  const versions = [...releases.map((item) => item.version), ...(release ? [release.version] : [])]
  return versions.length > 0 ? Math.max(...versions) : null
}
