import { defineConfig } from "tsup"

export default defineConfig({
  // node:sqlite 只能使用带协议的内置模块名，构建时不能改写成第三方 sqlite 包。
  removeNodeProtocol: false,
  // 常驻部署复制单个产物到内置磁盘，不依赖外置工作区中的 node_modules。
  noExternal: [/.*/],
})
