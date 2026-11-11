# 发布准备

当前版本 `0.1.0-dev.1` 是开发预览，目标仓库为 `jiang3ye/orca-plugin-meego`，尚不满足公开稳定发布条件。公开 Orca **v1.4.256** 和核查的公开 main 都没有完整的配套宿主接口；本插件不能声称兼容所有 `>=1.4.255` 的公开安装版。

## 宿主前置条件

配套宿主改动基线为 `9df199efbd6754adcd8944be801028b6634e8e87`，包括：

- `contributes.panels[].location: "settings"` 及原生集成设置页；
- `settings.open`、`agents.available`；
- `workspace.readContext.workspaceId`、工作区创建能力；
- Agent 启动时序和提示投递修复。

公开版本的[面板严格 schema](https://github.com/stablyai/orca/blob/v1.4.256/src/shared/plugins/contributions/plugin-panel-contribution.ts)会在执行插件之前拒绝新的 `location` 字段。[公开 Host API](https://github.com/stablyai/orca/blob/v1.4.256/docs/reference/plugin-host-api.md)也没有这些扩展。manifest 的 `>=1.4.255` 是开发平台的字段版本下限，不能代替公开宿主兼容证明；不要猜测未来版本号。

发布前先让配套宿主改动进入可获取的 Orca 版本，使用该版本的 CLI 重新生成 SDK、校验、类型检查并验收，再更新真正的公开最低版本。完整桌面验收还需按宿主要求使用 Electron 技能和隔离显示环境完成；原生组件截图与分段 API 验证不能代替完整 GUI 流程。

## 本地检查和干净快照

安装兼容的 Orca 后：

```sh
npm ci
npm run check
orca plugin inspect . --json
```

`check` 顺序执行官方 SDK 生成、manifest 校验、严格类型检查、离线测试、面板场景检查和源码清单检查。CLI 随 Orca 应用提供；**不要执行 `npm install orca`**，该 npm 名称不是本项目依赖的 Orca CLI。

检查通过并提交已审阅的改动后：

```sh
npm run release:prepare
```

输出在忽略的 `.orca/release/`，包含 `source/` 和逐文件 SHA256 回执。它是首次公开仓库的源码快照，不是自定义插件安装包；Orca 官方方式直接加载 Git 标签中的源码，无需 `dist` 或 npm 发布。

开发仓库历史曾包含内部验收信息。首次公开时从审阅过的 `source/` 建立干净 Git 历史，**不要直接推送开发仓库的全部历史**。快照不包含 `.git`、`.orca`、`.zcode`、内部计划、用户数据或截图。

## GitHub 检查

仓库工作流默认只运行源码清单检查，并明确标注这不等于 SDK 或桌面验收。`workflow_dispatch` 可指定兼容的公开 Orca release 标签，下载对应架构的官方 macOS ZIP、核对 GitHub 发布资产 SHA256 和应用签名，再运行完整 `npm run check`。

版本标签校验需要仓库变量 `ORCA_SDK_RELEASE` 指向已包含配套改动的公开宿主版本。当前没有可填的已验证公开版本；保持该项未配置，标签检查会明确失败。工作流不创建或发布 GitHub Release。

## 正式发布

满足宿主和完整验收条件后，按 [Orca 官方发布流程](https://github.com/stablyai/orca/blob/0184d8187de369349ac447bb50fa0b7f9c68a4f2/docs/reference/plugin-authoring.md#L629-L682)：

1. 确定仓库 `OWNER/REPO`，补齐 manifest 和 package 的 repository URL。保持 `publisher` 省略，身份由仓库 owner 派生为 `OWNER.meego`。
2. 更新 manifest、package 及变更记录中的版本，提交并运行全部检查。不要先打发布标签再补检查。
3. 推送审阅后的源码，为该提交创建 `v<manifest.version>` 标签。发布预览版本时，manifest 也使用对应 semver 预发布版本。
4. 先准备 GitHub Release 草稿，核对版本、提交、兼容性和验证边界，再发布。正式进入插件目录时添加 `orca-plugin` topic。
5. 如需 catalog，使用最终公开仓库和提交运行 `orca plugin release-entry . --json`；不能复用开发仓库的 publisher、commit 或内容 hash。

GitHub 工作流按[官方安全建议](https://docs.github.com/en/actions/reference/security/secure-use)固定 action commit，并使用只读 `contents` 权限。发布操作留给维护者明确执行。
