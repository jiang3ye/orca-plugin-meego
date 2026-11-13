# 发布准备

当前版本 `0.1.0-dev.1` 是独立社区集成的开发预览，目标仓库为 `jiang3ye/orca-plugin-meego`，非 Orca、飞书项目或 Meegle 官方产品。已核查的公开 Orca **v1.4.257** 仍没有完整的配套宿主接口；本插件不能声称兼容所有 `>=1.4.258` 的公开安装版。

## 宿主前置条件

配套宿主改动包括：

- `contributes.panels[].location: "settings"` 及原生集成设置页；
- `settings.open`、`agents.available`；
- `workspace.readContext.workspaceId`；
- 使用主线官方 `workspace.create`（按项目及主机选择，独立 `workspace:create` 权限），保留插件侧持久创建记录；
- Agent 启动时序和提示投递修复。

日常 CI 从 [`.github/orca-sdk.json`](../.github/orca-sdk.json) 指定的 `jiang3ye/orca` 源码完整提交构建真实 Orca CLI。固定记录中的 `repository` 与 `commit` 是构建身份的唯一来源；文档不复制提交 SHA，也不以可移动分支或推测版本替代。

v1.4.257 的[面板严格 schema](https://github.com/stablyai/orca/blob/v1.4.257/src/shared/plugins/contributions/plugin-panel-contribution.ts)会在执行插件之前拒绝新的 `location` 字段；其[Host API](https://github.com/stablyai/orca/blob/v1.4.257/docs/reference/plugin-host-api.md)也没有这些扩展。manifest 的 `>=1.4.258` 是开发平台的字段版本下限，不能代替公开宿主兼容证明；不要猜测未来版本号。

源码公开和上游草稿 PR 不代表已满足目录可安装版本的发布条件。配套宿主[PR #41598](https://github.com/stablyai/orca/pull/41598) 仍需上游审查并进入已发布、可获取的官方 Orca 版本；使用该版本的 CLI 重新生成 SDK、校验、类型检查并验收，再更新真正的公开最低版本。日常固定源码构建不能替代这一官方发布门槛。当前已按宿主要求完成隔离 macOS Electron/CDP 桌面流程，覆盖真实插件界面、worker、原生工作区和 Agent 终端；提供方 HTTP 与模型端使用合成 fixture。发布前仍需在首个支持这些 API 的官方宿主版本复验兼容性；该桌面证据不代表真实云端模型、其他系统或远端实机都已验收。

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

日常检查与公开发布使用不同的宿主来源：

| 触发与用途 | 宿主来源 | 检查范围 |
| --- | --- | --- |
| 每次 push / pull request 的默认 CI | 从固定配套宿主源码提交构建的真实 CLI | Linux、macOS、Windows 源码检查，以及 macOS 15 Intel 的完整 `npm run check` |
| 插件 `v*` 标签 / 手动公开版本覆盖 | 已发布且经验证兼容的官方 Orca release，macOS 15 ARM64 | 官方宿主兼容门槛、版本一致性及完整 SDK 检查；不能用配套分支构建代替 |

### 默认源码构建

日常源码检查使用 GitHub 标准 Intel Mac runner，减少 ARM64 资源排队影响；公开 release SDK 的下载与校验仍固定为 ARM64，不混用产物或放宽身份验证。

公开 CI 检出 `.github/orca-sdk.json` 中的完整宿主提交，不下载私有全量宿主 ZIP。它构建并执行宿主真实 CLI，不使用手写 SDK、占位命令或伪造的宿主响应完成插件检查。

在检出的宿主源码中，先安装锁定依赖，再运行 canonical generation 的只读校验和官方 CLI 构建：

```sh
pnpm install --frozen-lockfile
pnpm generate:plugin-declarative-typings --check
pnpm generate:plugin-declarative-runtime --check
pnpm build:cli
```

使用产物前必须确认 `out/package.json.commit` 与固定记录中的完整 `commit` 完全一致。之后将该 CLI 用于插件的 SDK 生成和全部检查。更新固定提交时，生成声明与运行时资源应已通过宿主官方生成流程同步并提交；不能只替换声明，或在插件中添加类型镜像掩盖漂移。

macOS 15 Intel 的 SDK 检查在每次 push 和 pull request 执行完整 `npm run check`：SDK 类型生成、manifest 校验、严格类型检查、离线行为测试、全部面板场景和源码清单检查。当前本地基线为 218 项行为测试和 11 个场景。三系统源码检查仍独立保留，其通过结果不能替代 SDK 检查。

固定提交不可获取、生成资源过期或构建身份不一致时应明确失败，不能降级为仅源码检查或跳过 SDK。每次云端结果见仓库 [Actions](https://github.com/jiang3ye/orca-plugin-meego/actions)。报告某次检查通过时，应以对应提交和运行的完整 SDK job 日志为依据，确认各阶段实际执行并通过；218 项测试和 11 个场景仅是本地验证基线。

### 官方发布门槛

插件 `v*` 标签和手动指定公开宿主版本时，必须选择已发布、可下载并验证包含全部所需 API 的官方 Orca release。该路线核对对应官方 ZIP 的 SHA256、应用身份和 CLI 版本，再执行完整检查；不能回退到配套 fork 的源码构建来满足官方发布条件。

当前没有符合条件的已验证官方公开版本。不要用仍缺少扩展的公开 `v1.4.257`，也不要把配套 fork 或 CI 构建当作官方发布来解除门槛。发布标签在缺少合格官方宿主时必须明确失败。日常源码构建与 SDK 检查通过本身不能替代正式宿主兼容验证或桌面验收。当前隔离 macOS 桌面证据及其合成提供方边界见 README 的验证范围。

工作流不创建或发布插件 GitHub Release；插件正式发布仍按以下步骤执行。

## 正式发布

满足宿主和完整验收条件后，按 [Orca 官方发布流程](https://github.com/stablyai/orca/blob/0184d8187de369349ac447bb50fa0b7f9c68a4f2/docs/reference/plugin-authoring.md#L629-L682)：

1. 确定仓库 `OWNER/REPO`，补齐 manifest 和 package 的 repository URL。保持 `publisher` 省略，身份由仓库 owner 派生为 `OWNER.meego`。
2. 更新 manifest、package 及变更记录中的版本，提交并运行全部检查。不要先打发布标签再补检查。
3. 推送审阅后的源码，为该提交创建 `v<manifest.version>` 标签。发布预览版本时，manifest 也使用对应 semver 预发布版本。
4. 先准备 GitHub Release 草稿，核对版本、提交、兼容性和验证边界，再发布。正式进入插件目录时添加 `orca-plugin` topic。
5. 如需 catalog，使用最终公开仓库和提交运行 `orca plugin release-entry . --json`；不能复用开发仓库的 publisher、commit 或内容 hash。

GitHub 工作流按[官方安全建议](https://docs.github.com/en/actions/reference/security/secure-use)固定 action commit，并使用只读 `contents` 权限。发布操作留给维护者明确执行。
