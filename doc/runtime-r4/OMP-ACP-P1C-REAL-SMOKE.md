# OMP ACP Runtime P1C 真实 Smoke 原始记录

## 运行标识

- 时间：`2026-09-03T12:49:03.8825674+08:00` 至 `2026-09-03T12:49:42.8002680+08:00`
- 分支：`agent/runtime-r4-omp-acp-p1-v1`
- 执行时 HEAD：`a9ee7bc4b18ce8ded6f5fc7fd00d393374cd9589` 加当前未提交 P1C 差异
- 固定 OMP：`@oh-my-pi/pi-coding-agent@18.1.2`
- 源码 revision：`86bf72f52947f62ecaf9bd28e35572812e725a92`
- 完整依赖图位置：`D:\CodexCache\xiaogui-omp-runtime-18.1.2-spike`
- 主包位置：`D:\CodexCache\xiaogui-omp-runtime-18.1.2-spike\node_modules\@oh-my-pi\pi-coding-agent`
- 主包 `package.json` SHA-256：`34571a48e10b2c8860e3ca6531d50611c95deeb0c0eda69bf89b3bb8284a948d`
- 固定主包树摘要：`sha256:159d43dce438cc5a26fde64639d755612f5c97eb8067e8650487542495a685da`
- 固定入口摘要：`sha256:8ed76a9e7a0aa09d7190b4cf700a546b172923a94ea775334ef0f0145235c5cd`
- 主包计量：`3,136` 个文件，`48,326,575` 字节
- 模型配置：使用本机私有配置；路径和内容不进入仓库
- 模型配置 SHA-256：`0499b4b6630c87eb9f0b7ea57fe43e8e84418d25059697b79d5a91519104b29d`

主包位置是非敏感的本机 D 盘复验入口；模型配置路径保持私有。其他复核者可使用自己的有效私有模型配置执行同一命令。

## 等价运行命令

```powershell
$env:XIAOGUI_OMP_P1C_REAL_SMOKE='1'
$env:XIAOGUI_OMP_P1C_REAL_PACKAGE_ROOT='D:\CodexCache\xiaogui-omp-runtime-18.1.2-spike\node_modules\@oh-my-pi\pi-coding-agent'
$env:XIAOGUI_OMP_P1C_MODELS_JSON='<复核者自己的私有模型配置>'
npm run test:unit -- src/main/xiaogui/agent-runtime/omp-acp-production.test.ts
```

## 原始控制台输出

```text
STARTED_AT=2026-09-03T12:49:03.8825674+08:00
PACKAGE_ROOT=D:\CodexCache\xiaogui-omp-runtime-18.1.2-spike\node_modules\@oh-my-pi\pi-coding-agent
PACKAGE_JSON_SHA256=34571a48e10b2c8860e3ca6531d50611c95deeb0c0eda69bf89b3bb8284a948d
MODELS_CONFIG_SHA256=0499b4b6630c87eb9f0b7ea57fe43e8e84418d25059697b79d5a91519104b29d
MODELS_CONFIG_PATH=<redacted-private-path>

> xiaogui-agent-desktop@0.3.0-rc.1 test:unit
> vitest run src/main/xiaogui/agent-runtime/omp-acp-production.test.ts

 RUN  v4.1.9 D:/CodexWorktrees/xiaogui-omp-acp-p1-v1

(node:36068) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  12:49:05
   Duration  37.61s (transform 311ms, setup 168ms, import 651ms, tests 35.57s, environment 618ms)

FINISHED_AT=2026-09-03T12:49:42.8002680+08:00
EXIT_CODE=0
```

`--localstorage-file` 是测试进程既有警告，不改变退出状态或 P1C 断言结果。
