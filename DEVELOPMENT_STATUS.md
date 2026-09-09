# 小规开发阶段状态

## 2026-09-09｜固定96a103安装包 C盘实际安装与最短IPC通过

- 主管只读确认C盘独立落点有足够空间后明确授权继续；没有重试被策略拒绝的删除，也没有手动删除、换工具或移动绕过。此前提出的手动清理建议不再作为后续方案，E盘本轮 `dist/win-unpacked` 原地保留。仅将两个外部验收脚本的安装路径改为 `C:/Users/90662/AppData/Local/Programs/XiaoguiInternalRC-4511fc3`，无产品源码或安装器变更。
- 同一96a1030245f37de5df4e755e6ff9fd31d95d54c9c2a2a2085e7a93819366c001包，经原NSIS `/S /currentuser /D=...` 安装：2026-09-09T04:38:13.032Z至04:45:44.538Z，退出0。安装前独立核验旧卸载登记仅指向7d测试程序，新目标不存在。原安装流程替换旧测试程序、未请求删除app data；旧8951包、恢复快照/manifest、所有旧profile和证据保留，旧程序字节可恢复。卸载登记由原安装器正常指向上述C目标，没有手改注册表。
- `node E:/XiaoguiInternalCandidate/final-combination-20260909/install-verify.cjs` 退出0：19864/19864文件匹配，missing=[]、mismatch=[]；四个原缺失ARM64文件全部存在且SHA与打包清单一致，ASAR仍为75ed1dc4adc323fb556aa753b69dbc48c7b3744a982ee706be6fc7e71fead853。结果为同目录 `installation.json`、`installed-verification.json`，不是仅凭安装器退出码判成功。
- `node E:/XiaoguiInternalCandidate/final-combination-20260909/installed-startup.mjs` 退出0，INSTALLED_MAIN_IPC_PASS。实际exe和app.asar来自C安装目录、app.isPackaged=true、版本0.3.0-rc.2；preload invoke可用、真实Main `ipc:xiaogui.mode.get` 返回WORK。截图 `installed-startup.png` 可见正常工作台；记录 `installed-startup.json`。应用已正常关闭。
- 本次最短启动使用E盘新隔离 `final-combination-20260909/installed-startup-profile`，统一模型目录为其pi-agent；没有复制旧会话/Hub凭据，没有发模型请求，没有重跑H1、Word、Office。此前4511真实intake以及已验收Word/Office/H1证据按主管许可复用，当前不声称新两机/Hub联用通过。
- 实际仓库修改仅本记录，文档diff-check通过；固定代码/包来源仍4511fc3，产品身份和旧恢复材料不变。桌面安装候选已完成本轮授权门，回交桌面主管统一复核及联用准备；不合主线、不发布、不制作Portable、不自行启动Hub。

## 2026-09-09｜最终 BCJ NSIS 包核验通过，实际安装待腾空间

- 固定代码/构建来源 `4511fc3c62c526e2d0b6f4b26c42b3520fb4078b`；后续仅记录提交。原 electron-builder/NSIS x64 构建退出0，实际7za进程参数含 `-mf=BCJ`，没有更换压缩器、依赖或产品架构。
- 新安装器 `E:/XiaoguiInternalCandidate/final-combination-20260909/dist/小规 Agent 院内候选-Setup-0.3.0-rc.2-x64.exe`，570468959字节，SHA256 `96a1030245f37de5df4e755e6ff9fd31d95d54c9c2a2a2085e7a93819366c001`。ASAR SHA256 `75ed1dc4adc323fb556aa753b69dbc48c7b3744a982ee706be6fc7e71fead853`。
- `node E:/XiaoguiInternalCandidate/final-combination-20260909/verify-package.cjs` 退出0：198个构建文件与ASAR一致；Word helper 2、LibreOffice 19487、Pi Skills 7、Office viewer 80项与固定来源一致，法律及图标资源相同。完整清单19864文件/2363474257字节；manifest SHA256 `efc08fb2e40a7975850370c0fd18c6366353ec92327345e6b03041aabd51101a`。可复核结果在同目录 `package-verification.json`、`unpacked-manifest.json`、`package.log`。
- 未完成：新NSIS实际安装与已安装Main/IPC核验。E盘剩约2.02GB，不足新程序2.36GB；仅清理本轮已验证可再生 `dist/win-unpacked` 的PowerShell调用被执行环境策略拦截，未删除、未改用其他方式绕过。已请求用户手动清理该单一目录，安装器及清单保留。旧安装器、旧程序恢复清单/快照、用户配置及冻结证据未动。
- 下一步只执行已准备的 `install-verify.cjs` 与 `installed-startup.mjs`：正常NSIS安装至独立 `E:/XiaoguiInstalledRC/4511fc3`、比对全部落盘文件和四项ARM64资源、最短Main/preload/Renderer IPC启动。不得将当前包内PASS当作安装PASS；不重跑模型、H1、Word、Office、Hub或全量测试，不合主线、不发布。
- 本轮仓库实际修改仅本记录；没有源码变更。保护stash仍为 `a6ba3bb91fa5fc68aeb42d7f64897e4b1e862c61`。

## 2026-09-09｜4511真正intake通过，BCJ装配进行中

- 主管已限定批准4511代码（Standards0/Spec0）。纠正此前折叠菜单的无效点选后，用可见搜索完整模型名并实际点击，输入框短名与Renderer当前完整值同时确认为DeepSeek（model-confirmed-search.png、model-current-confirmed.png、model-ui-confirmation.json）。未改settings/JSON；当前空白视图通过正常Composer新会话流程确认model.set，不直接创建业务会话。
- 新报告 `xgti1_0cc136bc-1e52-4eab-bda8-4ecadf5ca611`：12候选=5变量/7固定，仅PAGE_COUNT_UNKNOWN和SCAN_COUNT_UNKNOWN；无MODEL_UNAVAILABLE/OUTPUT_INVALID。该新会话外层全部DeepSeek、唯一intake toolUse；内部completeBatch的临时inspector断点实测first/stop，无repair/异常。源DOCX SHA4983f085dd243b81e1b61bb1774b5e23bfcd4f21a6544582da6b86df5224df55不变。未生成正式模板，不重复Word/Office旅程。
- 集中证据 `E:/XiaoguiInternalCandidate/final-combination-20260909/analysis/evidence/analysis-pass.json`、analysis-debug.json、analysis-result.png。旧401空报告/截图另存prior-401-result.json/png，旧model-selected.png和610f记录保留。该次真正intake已由桌面主管核定通过；应用已正常关闭，不再发模型请求。
- 正在用相同source4511构建out、原electron-builder26.15.3/NSIS、既有ELECTRON_BUILDER_7Z_FILTER=BCJ生成替代包，仅NSIS x64、publish never。仍未形成新安装通过结论。代码不再改，不重测H1/分类/模型/Word等已过组。
- 旧E:/XiaoguiInstalledRC/7d18334程序的完整19861项恢复清单与快速硬链接快照已准备；独立恢复依据为原8951 NSIS+已核内容manifest，以及额外卸载器独立副本（old-recovery-manifest.json、old-extra-independent）。主管允许原NSIS正常替换旧测试程序、保持KEEP_APP_DATA；旧包/profile/原始证据不动，不绕过注册表或安装逻辑。新安装目标必须独立，不能复用旧硬链接。

## 2026-09-09｜4511新隔离实际分析前置未通过（已停）

- 代码source `4511fc3c62c526e2d0b6f4b26c42b3520fb4078b` 与live远端一致；E独立app/out构建通过，未修改原source out。新场景 `E:/XiaoguiInternalCandidate/final-combination-20260909/analysis`，只复制原已授权models/auth及锁定合成DOCX，不复制会话/报告/Hub凭据；节点依赖及只读资源junction指向本候选同版本资源，不冒充安装包。实际Main appPath/userData/agentDir均在新场景，PID54972（identity.json）。
- 现有Node inspector临时断点已准备，无模型prepare通过；最初一次Main evaluate上下文销毁后仅重试无模型prepare，未变更产品。模型菜单点选后截图model-selected.png实际仍显示“选择模型”，root未在发送前及时核对；点击记录不能证明DeepSeek已选定。随后真实新会话为anthropic/claude-opus-4-8，stopReason=error、HTTP401、toolCalls=0，reports=[]、analysis debug=[]。没有intake分析或内部complete发生；不能把本次称为451内部分析故障，也不能算通过。
- 已停止进一步请求并正常关闭本次测试应用；新现场保留。证据：该场景evidence/identity.json、model-selected.png、analysis-result.png、result.json；启动与调试脚本在上级analysis-probe.mjs，构建日志build.log。没有收集正文/思考/认证值，没有再次追查旧7d现场；旧冻结profile完全未动。
- 当前阻断是本次UI选型准备未确认，不根据它新增生产模型修复。已回报主管，等待按最短范围纠正可见选择并确认后的真实intake安排；不直接换模型重试、不重包、不拿旧8951替代。源码6项Renderer模块链及已审0c证据仍保留；本次没有新安装器。

## 2026-09-09｜最终分类/模型预选组合（分析验收前固定）

- H1固定3a36abf已获中台Standards0/Spec0，本轮不再检查H1。已审WORK `0c8819a2ef7075e3c7bb0416073116d6543f3b20` 仅摘Worker分析分类与原对应测试，两个文件与固定源逐字节一致；复用19项/Node已有证据，不重跑分类组，不覆盖WORK分支或文档。
- 共享模型问题先实际复现：真实Renderer `navigateToModeHome→refreshComposerRunDisplay/applyComposerDisplayMeta→materializePendingNewSession`，外围IPC/store为合成替身；原实现把无当前会话的旧Anthropic模型传给新会话model.set，回归失败。修复只在session-display-meta：空白视图不把旧Worker当绑定，用户当前预选先于defaults/last；异步返回若已切会话不写回。正常绑定仍以Runtime为准，无新模型体系/UI。
- `node node_modules/vitest/vitest.mjs run src/renderer/src/lib/model-preselection-lifecycle.test.ts src/renderer/src/lib/__tests__/session-display-meta.test.ts`：6通过（原链1失败，model-red.log/model-green.log）。统一Node/Web typecheck、4文件定向ESLint、diff-check通过；类型/lint日志位于 `E:/XiaoguiInternalCandidate/final-combination-20260909`。Luna已按指定模型max委派，但两轮无落盘后暂停，根owner完成最小代码，不因换模型重做旧组。
- 下一步按已有授权只做一次新隔离合成DOCX实际分析；锁定SHA4983f085dd243b81e1b61bb1774b5e23bfcd4f21a6544582da6b86df5224df55。利用Node inspector临时断点只收阶段/错误类别/stopReason/model，不收正文、思考或凭据，不新增生产观测框架。旧冻结profile和7d历史不再追查，旧MODEL_UNAVAILABLE根因仍未定。
- 本提交是分析前代码固定点，尚无本组合真实分析或新NSIS通过结论。既有Word/Office证据复用；后续BCJ包须绑定本组合真实构建，不混旧8951安装器。

## 2026-09-09｜H1 三ID投影与人工打开入口（待增量复验）

- 固定起点 `4d1016a2e4aae6e6550aa468e5897e8ccad4f2a4`。本轮仅两处：状态元数据不得展开复制凭据，以及同组件重登录后原打开按钮必须服从Main投影；已通过六项/在途隔离不重做。
- `worker-state.ts` 统一使用运行时显式投影，只构造 subjectId/nodeId/keyId 三字段。新upsert、clone/snapshot、旧记录恢复及后续正常persist均复用该投影；不是只改TS类型或单一caller。不改签名/加密/队列框架。没有读取、清理真实配置，也没有实际泄漏或需轮换凭据的证据。
- `HubTaskInboxSection.tsx` 删除 openedAssignmentId 影子状态，仅根据item.openedAt显示原按钮；同实例connect成功后清旧items并按原reload取Main投影（无address时不额外请求收件箱）。不下发node字段、不新增UI、不自动打开；人工再次点击才调用open。React指南用于移除重复派生状态，没有旁支优化。
- 最小红绿：`node node_modules/vitest/vitest.mjs run src/main/xiaogui/hub-task/worker-state-identity-projection.test.ts src/renderer/src/xiaogui/components/HubTaskInboxSection.test.tsx`。原3失败/2通过；修后5/5通过。合成完整node对象经过真实worker-state→worker-persistence→合成backing.set，验证新写入/旧记录恢复仅三ID、已入队receipts/results编码不变；没有打开electron-store真实用户目录。UI在同一mount执行A人工打开→重登录B→同步同assignment openedAt=null→原按钮再次可点，第二次open仅由点击产生。原两条登录测试随同文件运行，无额外扩围。
- 集中证据 `E:/XiaoguiInternalCandidate/h1-projection-ui-20260909`：red.log、green-verified.log、typecheck.log、eslint.log。中间green-final.log的两个失败来自测试把既有enqueue规范化前的字段顺序拿来与已入队数据比较，改为记录身份投影前的真实outbox编码后验证不变；未修改既有enqueue/签名逻辑，不把该夹具问题记为新产品缺陷。
- `npm run typecheck` Node/Web通过；四个变更TS/TSX定向ESLint通过；`git diff --check`通过。类型检查后只调整上述测试编码比较基线，无生产变更。可复现lint：`node node_modules/eslint/bin/eslint.js src/main/xiaogui/hub-task/worker-state.ts src/main/xiaogui/hub-task/worker-state-identity-projection.test.ts src/renderer/src/xiaogui/components/HubTaskInboxSection.tsx src/renderer/src/xiaogui/components/HubTaskInboxSection.test.tsx`。
- 实际修改仅上述四文件及本记录。不运行Hub/模型/Word/Office/Electron/NSIS或全量测试，不混0c/共享模型显示。固定后交桌面主管统一转中台复验；旧安装包仍为7d/8951，未合主线、未发布。

## 2026-09-09｜H1 身份恢复两个 P2 最小返修（待复验）

- 固定起点 `2730172144c5b805606057aef6aa1bd34245df54`；本地/live远端一致、clean、保护stash未变。中台原七项已关闭六项，本轮只修在途发送归属与当前节点送达/打开事实。Terra只读方案后未落盘，已暂停；最终代码与公开调用回归由根owner落地，没有并发改树。
- 在途发送仍是原来的一个私有slot，现在同时保存 credentials identity 和 Promise；只有同subject/node/key才复用，不同身份启动自己的发送。旧finally不能清掉新slot，旧错误仍携带旧身份，不能经B的refresh误清B；真正B的401/403继续清其失效凭据。未创建另一套持久队列或协议。
- 原私有entry增加可选deliveryIdentity归属。首次/新节点接收QUEUED且PENDING/ACCEPTED、NOT_STARTED任务时重置当前openedAt/localDeliveryState并排入NODE_STORED；同任务本机计划保留，包变化原规则不改。旧数据缺字段仅作为未知归属，不清旧签名；旧/坏归属字段不会让normalizeState清空整个队列。四个原upsert消费者共用同一存入动作；await后重核当前身份，迟到旧响应不能写回旧归属。不同已知身份不能沿旧打开事实操作；USER_OPENED仍只由人工open生成。
- 精确旧ACK可确认对应旧证据，但不得更新新节点的打开/执行/结果投影。未ACK历史签名完整JSON保持原字节。NODE_STORED不会自动生成USER_OPENED或START；Hub70保留在退役节点的RUNNING/OUTCOME_UNKNOWN任务不会被新节点自动接收或重跑。公开IPC仍是原手写白名单，未增加节点身份字段。
- 修改文件仅 `worker-service.ts`、`worker-state.ts`、新增 `worker-identity-rebind.test.ts` 及本记录。Hub70/d76、C2 outbox、Apply、dispatch门、Word/Office、0c分类、共享模型显示、安装器均未改。

### 定向证据

集中目录 `E:/XiaoguiInternalCandidate/h1-identity-rebind-20260909`：

- `node node_modules/vitest/vitest.mjs run src/main/xiaogui/hub-task/worker-identity-rebind.test.ts`：原在途A队头→B connect→A晚401/403，两项均因B凭据被清失败（inflight-red.log），修后两项通过（inflight-green.log），同测试继续验证真正B401/403仍正确处理。
- 初版目标 `-t 'rebinds an accepted'`（测试随后参数化为tracked/legacy）原代码因新node没有NODE_STORED失败（delivery-red.log）。修后用固定70源码的subject/node/key、assignment/package、严格sequence与START前置条件验证；不是无条件成功ACK替身，不运行Hub或复测签名算法。
- 最终可执行命令：`node node_modules/vitest/vitest.mjs run src/main/xiaogui/hub-task/worker-identity-rebind.test.ts src/main/xiaogui/hub-task/worker-service-c2-gate.test.ts src/main/xiaogui/hub-task/worker-result-projection.test.ts`：3文件16通过（focused-final.log）。含tracked与旧无归属entry两条同主体重配、人工打开和START序列、重启私有归属保留、旧签名编码不变及晚ACK不污染B；另两项退役RUNNING/UNKNOWN不得重跑。仅带回直接受影响的身份/结果绑定回归，不重跑原六项全组。
- `npm run typecheck` Node/Web通过（typecheck-final.log）。首轮4处类型错误为新测试union未收窄及identity辅助函数参数要求过宽，已纠正，原typecheck.log保留。类型完成后仅补同一测试的legacy参数场景，无生产变化。
- `node node_modules/eslint/bin/eslint.js src/main/xiaogui/hub-task/worker-service.ts src/main/xiaogui/hub-task/worker-state.ts src/main/xiaogui/hub-task/worker-identity-rebind.test.ts`通过（eslint-final.log）；最后legacy测试单文件lint另过；`git diff --check`通过。提交后固定差异基线为2730172144c5b805606057aef6aa1bd34245df54。

这是客户端公开service/state调用与按70规则实现的受控端口测试，不是两机/真实Hub验收。没有模型、Word、Electron、NSIS或全量测试。下一步只交桌面主管统一转中台增量复验；通过前不混入其他候选、不重新出包、不合主线、不发布，旧7d/8951安装证据不代表本次源码。

## 2026-09-09｜H1 桌面组合补充整改（待增量复验）

- 固定起点 `09d8475796c85856aeeaee48ac550d16433ce361`。中台主管固定补充审查七项，范围仅既有生命周期与身份/证据留存；不重开已通过的 dispatch 证据门和终态 saga 读取。复用原 H1 worker/service、TaskHub coordinator、Delivery composer 及私有队列，不新增 Pi Skill/插件、公开协议、权限系统或状态机。
- 生命周期：旧 Attempt 回调必须仍等于 TaskRun 当前 Attempt；`NOT_RUN` 经真实结果 mapper 保留原义；selection 返回失败后仍从权威 Delivery 状态协调。实际 Workflow/Composer 在变更摘要漂移时记 REJECTED，接口失败仍回传该终态，Apply 调用为0。测试使用既有内存 Store 替身与真实 Workflow/Composer/IPC/coordinator，不冒充真实 Hub 或 SQLite 全旅程。
- 身份/留证：发送仅选当前 subject/node/key 的有序队头，精确 receipt/result ACK 同时核对该身份；旧身份证据仍原字节保存在原私有存储，不重签、不删除、不发送。配对后新凭据保存失败只清无效凭据，保留全部未ACK证据并明确UNCONFIGURED。草稿创建先要求当前凭据，并通过现有 downloadAssignment 用当前身份确认同一任务，再核对身份未变与 ACCEPTED/NOT_STARTED；不再凭旧缓存授权。故新草稿创建须当前身份在线确认，已经建立的本机 TaskHub 执行/恢复语义未改。
- 启动：移除 composition 构造中的两个并发 recover；零参数默认 IPC 装配复用既有 coordinator 恢复屏障，Main 等屏障完成后才 poll/refresh。无 reporter 的独立默认 TaskHub 仍串行恢复执行器与 Delivery；普通 CODING 未改。可控 Promise 测试覆盖恢复顺序，构造期探针覆盖“不提前开始”。
- 本轮实际改动文件以 `git diff --name-only 09d8475796c85856aeeaee48ac550d16433ce361..HEAD` 为固定交接清单，包含 worker-service/state、结果 mapper、lifecycle、delivery IPC、runtime/IPC/Main 启动与相应测试及本记录。不改70 Hub、d76、C2 outbox、Apply、Word/Office及安装包。原8951包/安装PARTIAL仍保留；BCJ重新封装已获总控确认，但须等新代码增量复验及最终组合后进行，不能将旧ASAR标成新SHA。

### 已取得的聚焦证据

证据目录 `E:/XiaoguiInternalCandidate/h1-supplement-20260909`。测试 TEMP/TMP 指向本次安装合成场景的 E 盘 temp；无外部模型、Word、Electron或Hub调用。

- `node node_modules/vitest/vitest.mjs run src/main/xiaogui/task-hub/hub-execution-lifecycle.test.ts src/main/xiaogui/task-hub/delivery-ipc.test.ts src/main/xiaogui/hub-task/task-result-projection.test.ts src/main/xiaogui/task-hub/delivery-workflow.test.ts`：4文件24通过（root-focused.log）。前三处最小回归原3失败/8通过（root-red.log）；真实Composer链旧IPC gate的产品红灯单独保存delivery-chain-red.log，修后delivery-chain-v2.log通过。最早delivery-chain.log夹具触发的是另一异常而非REJECTED，不作为目标产品红灯。
- `node node_modules/vitest/vitest.mjs run src/main/xiaogui/task-hub/ipc.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts`：2文件24通过（startup-raw.log）。构造测试初次导入缺Electron宿主替身、0测试（composition-focused.log），补测试宿主后才验证；不改真实配置。
- `node node_modules/vitest/vitest.mjs run src/main/xiaogui/task-hub/execution-orchestrator.test.ts -t 'retains dispatch authority|does not report while'`：4通过/29跳过（dispatch-preserved.log），只检查本轮仍需保留的批准与终态dispatch门，不重跑原35项全组。
- `node node_modules/vitest/vitest.mjs run src/main/xiaogui/hub-task/worker-result-projection.test.ts`：1通过（worker-result.log），真实Worker service→mapper→私有待发结果保存 NOT_RUN，非mock reporter。
- `node node_modules/vitest/vitest.mjs run src/main/xiaogui/hub-task/worker-service-c2-gate.test.ts`：9通过（identity-green.log）；旧 identity-red.log 中第三项同时触发了夹具perform返回值问题，不把该TypeError单独称为目标业务失败。随后补同一准入测试的正确身份成功对照，`-t 'requires the current-token'` 1通过/8跳过（identity-admission-positive.log），该1项不重复累加。并发迟到错误经两个真实service.refresh端口返回验证，不调用私有方法伪造入口。
- `npm run typecheck` Node/Web通过（typecheck-final.log）、增量16个TS/TSX文件 ESLint通过（eslint-final.log）、`git diff --check`通过。类型/lint后仅补上述现有测试的正向断言，单文件lint另过；生产代码无后续修改。提交后可复现lint：`$files = @(git diff --name-only --diff-filter=ACM 09d8475796c85856aeeaee48ac550d16433ce361..HEAD -- '*.ts' '*.tsx'); node node_modules/eslint/bin/eslint.js @files`。代码检查不构成真实两机结论。

### 其他已授权问题的边界

仅从安装合成profile的固定报告提取两个元数据：`versions.model=deepseek/deepseek-v4-flash-vision-exp`，MODEL_UNAVAILABLE消息为“临时模型分析不可用，已安全降级”。已回传WORK owner；不能由此恢复历史内部异常原因。WORK独立0c8819a分类修复已获桌面主管限定APPROVE但尚未摘入，本H1提交不声称关闭安装分析问题。共享模型预选仍在只读生命周期定位，不把直接IPC测试准备或单次403直接当产品绑定缺陷。旧冻结profile未触碰。下一步先交本固定H1增量复验，再进行已授权分类摘入/模型显示接缝补证和唯一新包；不合主线、不发布。

## 2026-09-09｜安装缺失资源根因定位（待重新封装）

- 本轮起点 `c71439f821af12c88f9c1dff5c5ab0e4de48e4ff`，本地/远端一致、工作树干净、保护 stash 未变。没有重构建、重装、回填安装根或重跑模型。
- 最小对照已实跑：取固定载荷 `t64-arm.exe`，使用本次原 7-Zip 24.09 分别生成默认压缩和 `-mf=BCJ` 归档，再由本次原 NSIS `nsis7z.dll` 解压。默认归档实际方法 `ARM64 LZMA2:192k`，进程 exit0 但目标文件不存在；BCJ 归档实际方法 `BCJ LZMA2:192k`，文件存在，源/输出 SHA256 均 `ebc4c06b7d95e74e315419ee7e88e1d0f71e9e9477538c00a93a9ff8c66a6cfc`。因此最小复现支持压缩器自动 ARM64 filter 与固定解压插件不兼容，不再把缺失简单归因于杀软。
- 可复核私有探针：`E:/XiaoguiInternalCandidate/nsis-arm64-probe-20260909/probe.nsi`，同目录 `auto.7z`、`bcj.7z`、`input`、`auto-out`、`bcj-out`。它只有原插件解压两个小归档，无注册表、产品安装或配置操作；留作本阻断证据，非待清理垃圾。
- 现有 `app-builder-lib/out/targets/archive.js` 已支持 `ELECTRON_BUILDER_7Z_FILTER=BCJ`。建议仅对已核验 source7d 的展开产物使用该现有选项重新 NSIS 封装，不升级依赖、不改业务/模型/Office、不制作 Portable。已向总控提交最小修复范围；尚未执行重新封装，旧8951安装包及资源门仍为 PARTIAL，不能把单文件探针当完整安装通过。
- 本轮仅文档 `git diff --check`，不重跑类型/业务测试。后续门为重新封装后的实际安装全资源核验，以及唯一 Hub 的 H1/C3 联用；原模型分析降级记录不变。

## 2026-09-09｜安装后最短验收（部分通过）

- 固定7d源码、8951e165…最终NSIS实际安装exit0到 `E:/XiaoguiInstalledRC/7d18334`，新测试profile在 `E:/XiaoguiInternalCandidate/installed-7d18334-20260909/profile`。实际Main/Renderer来自安装根app.asar、packaged=true、版本/appId正确；未用展开目录或源树冒充安装版。详细证据索引：同测试根 `INSTALLATION-ACCEPTANCE.md`。
- 通过范围：Main稳定确认WORK/CODING切换及H1真实UNCONFIGURED入口；安装Main调用包内Word helper转换锁定DOC，1表/2行/4格保持、源SHA不变；默认UNIVER_PREFERRED真实复核入口、canvas键盘编辑、保存/关闭/重开，标记0→1→1且截图可见，源DOCX SHA不变，无正式模板/确认令牌伪造。Word测试实例按原helper的owner三项检查清理，安装测试Main正常关闭。
- 未闭合：安装后19860文件匹配/0内容差异，但LO Python的4个ARM64启动器缺失（原NSIS载荷有），原因未定、未回填，全资源门PARTIAL。初次预选DeepSeek在新会话中落到默认Anthropic并403；之后实际model_change核DeepSeek再对同一输入重试，唯一START报告仍有MODEL_UNAVAILABLE、10候选未判定、canMaterialize=false。Office保存重开通过不覆盖分析降级；初403和乐观页签检测的旧记录保留，不算一次成功。
- 真实70 Hub配置/启动、H1/C3两机联合门仍未运行；不读秘密/旧冻结profile、不起Hub、不合主线或公开发布。没有重新构建、改包或改生产源码；后续文档HEAD不等于包sourceSHA。

## 2026-09-09｜唯一 NSIS 组合候选已生成（未安装验收）

- 包 sourceSHA `7d18334860a86653e1c5aef480c7608cea3b1919`，包含 f4 组合及本轮 H1 P1 修复。增量独立 Standards APPROVE0 / Spec APPROVE0，原提前开始和中间终态过滤问题均关闭；35项受影响测试/Node类型/四文件lint通过。代码已推送正确remote `xiaogui`（locadds/pi-app），首次连接重置后重试成功；后续本记录为纯文档HEAD，不等同包sourceSHA。
- 最终安装器：`E:/XiaoguiInternalCandidate/nsis-7d18334/dist-final/小规 Agent 院内候选-Setup-0.3.0-rc.2-x64.exe`，557,982,959字节，SHA256 `8951e16576b8e093785dad77684b3301ca72ce4f5371b4e722946c14e900e26e`。产品仍 `小规 Agent 院内候选` / `com.xiaogui.agent.internal` / `0.3.0-rc.2`，Electron43.0.0；唯一NSIS x64目标，不发布Portable或GitHub Release。
- 展开目录 `E:/XiaoguiInternalCandidate/nsis-7d18334/dist/win-unpacked`；ASAR SHA256 `fb476b3f6eaabd4dcce88deedc41d828b0977ce0df9ff074d8042c4aa56c47c0`，Main SHA256 `2e184850440f40bb034d3b4c09764943be9e0a712492ab521fcf5d7b8156cf76`。Main/Preload/Renderer在E独立输出构建，198个构建文件全部与ASAR逐字节一致；本树未改Office viewer/gateway源，复用其既有构建。原运行树out和PID43176未改。
- 资源验证：Word helper源码/包 SHA256 `d4c964f30ef022052216f3728f086fd64807d717bd9033b7f5b0e21c3f8caec3`；Word2、LibreOffice19487、Pi Skill7、Office viewer80个资源文件与本树源逐项hash一致，法律说明/SBOM也一致。包内Electron RUN_AS_NODE仅加载自身better-sqlite3执行内存SELECT通过（Node24.17.0/ABI148），未加载产品Main或模型。
- 展开清单 `unpacked-manifest.json`：19,864文件 / 2,363,468,161字节，SHA256 `651ccdb3da23367263f90a50048746467216eef39020182c1a62f2c6b83042fc`。直接从最终安装器解出应用载荷后，同19,864文件大小和SHA全部一致；未执行安装器。7-Zip识别内嵌7z时提示归档尾部另有数据，原日志保留，提取exit0且全部文件核对通过，不声称无警告或已经安装。
- 集中证据目录 `E:/XiaoguiInternalCandidate/nsis-7d18334`：`code-review.md`、`build.log`、`package-final.log`、`package-verification.json`、`native-probe.log`、`installer-payload-verification.json`、`payload-extract.log`、两个校验脚本和清单。正常安装脚本/身份沿原electron-builder.yml，只将输出定位E并复用已准备native依赖，不在正在运行的源树重建native。
- 装配过程如实保留：初次临时配置yaml解析器不存在，改为已有js-yaml后完成；初包因未先运行原export-app-icon使用默认Electron图标，`dist`初始安装器不采用。运行原图标导出后用冻结builder自身resedit补齐exe图标及resources/build，8幅图像与源一致、代码段与所有非图标资源不变（`icon-completion.json`）；随后仅用原builder --prepackaged/NSIS重新封装至dist-final，未重新编译产品或改安装流程。源码图标ICO SHA256 `06b3b25faeb755a30bf90aed90b82842fd6c5d363b67be0f081a570be74f6e15`。
- 剩余门：安装后身份/资源/最短界面旅程，及主管统一70 Hub实际配置/启动后的H1/C3联合验收；本机Word存在性/实际DOC路径仍属于部署验收。未运行安装器、未读秘密/冻结profile、未调用模型、未启动Hub/pump、未合主线或公开发布。两处失败测试临时目录清理被自动审批拦截，保留现场，不影响候选。

## 2026-09-09｜H1 开始回执 P1 最小整改

- 增量复验定位5dc门的终态回归：原 saga.byAttempt 排除FAILED/SETTLED，runtime先settle再reconcile导致失败/Delivery丢报。已仅为证据读取显式includeTerminal，原resume默认仍只查活动操作。真实monitor回调→settle→coordinator的FAILED与SUCCEEDED/READY_FOR_REVIEW补证旧红新绿，恢复读取也通过；Application/verification为合成端口，未调用模型。最终受影响2文件35/35、Node类型和4文件lint通过，日志 `h1-start-terminal-focused.log` / `h1-start-terminal-typecheck.log` / `h1-start-terminal-eslint.log`。
- `h1-terminal-gate-red.log` 是首次夹具遗漏close导致的失败，不作产品红灯；修正夹具后 `h1-terminal-gate-red-v2.log` 才是两条终态报告0次的产品回归红灯。日志分别保留，不覆盖旧证据。

- 固定起点 f4f7acbec5588b047c913e459582f6c29eb5da82。独立只读审查 Standards0 / Spec1P1：已准备但 Plan/Role 未批准的 Attempt，被新生命周期误当作已执行并上报 EXECUTION_STARTED。旧报告 `E:/XiaoguiInternalCandidate/combined-integration-20260909/f4f7acb-independent-review.md` 保留。
- 仅修改 H1 execution-orchestrator / hub-execution-lifecycle 及对应测试。Main 新增只读 hasDispatchEvidence：既有 saga 必须匹配 address/flow/taskRun/attempt，私有 attempt 必须匹配 flow/taskRun，且存在 Application 写入的 agent_dispatch_outbox 或真实 runtime_session_id；不以 READY/FAILED、runtime selection 或对象存在作为已执行证明。无新表/合同/凭据/审批变更。
- 正常 reconcile 与启动恢复共同使用上述门；实际 dispatch 返回后向原 coordinator 排队 reconcile，覆盖人工批准走 resumeAttempt 不经过原 start IPC 的路径。非等待排队避免与 coordinator.recover 等待执行器恢复形成循环；签名队列既有去重保证重复 reconcile 不新增开始回执。
- 两条新接缝回归使用真实执行器、coordinator、Worker service 和待提交状态，Application/离线网络为合成夹具：旧代码 Plan/Role 未批均失败（各错误产生一条回执），修后均通过；人工批准恢复运行自动生成恰好一条，重复 reconcile 仍一条。红/绿日志 `h1-start-gate-red.log` / `h1-start-gate-green.log` 保留。
- 本轮受影响两文件全量聚焦 33/33、Node typecheck、四文件 ESLint、diff-check 通过，日志同目录 `h1-start-focused.log` / `h1-start-typecheck.log` / `h1-start-eslint.log`。这是新生成的定向lint证据，不补造旧缺失 eslint.log。两条红绿属于33项子集，不累加。未重跑 Word/模型/网页或旧业务全套。
- Word、原 JSON/签名/ACK、Apply、70 Hub包和d76向导未改；PID43176与冻结profile未动。修订固定后只复验本次增量，通过即继续唯一 E 盘 NSIS 构建与资源检查；安装后/真实Hub联合门仍待完成。

## 2026-09-09｜H1 生命周期与 Word DOC 最小组合（代码候选）

- 固定起点 `311216110f19e6f4f05634f594b32e74a0a03062`，仍是独立 `codex/windows-internal-rc-20260908-v1`。用户已批准最终组合包含 H1/C3 与 Word DOC，不再把临时关闭项当最终范围豁免。旧异常 profile 冻结，不强推、不合主线、不公开发布。
- H1 由 Terra 按成熟 `b12a4b5b098a5d88d947864edf5f4e32f661c796` 接缝增量移植，未整树覆盖已验 CODING/TaskHub：恢复 poll/refresh、六项 inbox IPC/白名单、WORK/CODING 人工打开/接受/拒绝/退回/创建本机计划草稿 UI；保留无会话登录与 e232 显式重登录。DESIGN 不增加任务执行能力。
- 生命周期接回 `hub-execution-lifecycle.ts`、TaskHub IPC、execution-orchestrator、Delivery selection 和只读 readLatestDelivery。Main 顺序为构造 H1 service→注入 reporter→装配 TaskHub 协调器/recover→已配置才 poll/refresh。只有真实终态 Delivery 可上报相应结果；运行中或 SUCCEEDED 但无验证/Delivery 不假报 RESULT_READY，失败无验证标为 NOT_RUN。原 TaskHub 人工 Apply 门不变。
- 401/403 清失效凭据并停操作要求显式重登录，但不清签名待提交 evidence；生成、提交、持久队列三个完整 JSON 编码逐字节相同。HTTP 仍直接 JSON.stringify 原 receipt；只有 verified 且精确匹配队头 ACK 才删除。C2 outbox、签名算法、服务器 C3 密钥与状态机均未改。
- Word 接收点 `dc3cd29168fcac2b495dd813273a199ec2bc6b46`，生产 `c6c7124f2230a699c424ef2fbe640467f2f2d9d7`，已获独立 Standards APPROVE0 / Spec APPROVE0。摘取默认 converter/Renderer取消与错误映射、自有 helper及修后测试，恢复 DOC/DOCX 入口；RC appId/profile/Office默认不变。`convert-doc.ps1` 实际 SHA-256 `d4c964f30ef022052216f3728f086fd64807d717bd9033b7f5b0e21c3f8caec3` 与源相同；win.extraResources 增加 word-converter，保留 LO 资源/脚本。Windows+已安装 Word 是部署事实，不分发 Word，不回退 LO、不新增选择页/依赖。
- 实际文件以本提交 `git diff 3112161..HEAD` 为完整清单：H1 shared白名单/Main hub-task及TaskHub lifecycle/协作UI；Word converter/Renderer/错误映射/选择入口/helper/资源声明/README与许可证用途记录；本记录。没有写知识库散片或提交私有配置/原始会话。

### 聚焦证据

- `npx vitest run src/main/xiaogui/hub-task/worker-service-c2-gate.test.ts src/main/xiaogui/hub-task/worker-ipc-c2-gate.test.ts src/main/xiaogui/task-hub/hub-execution-lifecycle.test.ts src/main/xiaogui/task-hub/ipc.test.ts src/main/xiaogui/task-hub/delivery-ipc.test.ts src/renderer/src/xiaogui/components/HubTaskInboxSection.test.tsx`：6文件25通过，`E:/XiaoguiInternalCandidate/h1-integration-20260909/h1-focused.log`。
- 补完整字节及装配顺序后，`npx vitest run src/main/xiaogui/hub-task/worker-service-c2-gate.test.ts src/main/xiaogui/hub-task/worker-ipc-c2-gate.test.ts`：2文件5通过；其中401/403两条反例均核签名原编码保留。`h1-receipt-byte-retention.log` 为该补证；计数与前组有重叠，不累加宣称独立30项。
- `node node_modules/vitest/vitest.mjs run src/main/xiaogui/work-document-review-renderer-composition.test.ts src/main/xiaogui/work-document-review-renderer.test.ts src/main/xiaogui/work-docx-template-intake-worker-tool.test.ts src/renderer/src/xiaogui/components/WorkHomeView.test.tsx`：4文件24通过，`E:/XiaoguiInternalCandidate/combined-integration-20260909/word-seams.log`。Word平台fixture单文件10/10为源owner已验且独立复验采信，移植未改，不重跑Word/模型。
- 本组合 `npm run typecheck` Node/Web通过（combined-integration-20260909/typecheck.log），所有新增/修改TS/TSX定向 ESLint 通过（eslint.log），diff-check通过。提交后复现定向lint：`$files = @(git diff --name-only --diff-filter=ACM 311216110f19e6f4f05634f594b32e74a0a03062..HEAD -- '*.ts' '*.tsx'); node node_modules/eslint/bin/eslint.js @files`。
- 既有新隔离默认Office/Skill/CODING证据保留，详见下节；不声称本H1/Word未构建组合已经完成同一窗口或安装包旅程。Word首次MODEL_UNAVAILABLE、明确重试及人工修正等源限制不抹去；没有全量CI/第二Hub/额外模型验证。

### 明确余项

本候选待组合审查/构建与唯一 NSIS 实际资源检查及安装后最短旅程；新 H1/C3 仍需中台唯一 Hub/Web `70c93d0dd1fda4e48475af513b705938ac87f1af` 和配置向导 `d76fe2866d4e927a5eb95baf15e9e4c567e7f430` 的实际启动/release回执与受控测试数据。未启动 Hub，不从文档固定地址猜已上线。未完成验证前不得宣称整个最终版本通过。

## 2026-09-09｜新隔离默认 Office 草稿保存重开（限定场景完成）

- 用户经总控要求继续最终组合；旧异常 profile/非测试文档仍冻结。新场景仍只使用 `E:/XiaoguiInternalCandidate/office-isolated-20260908-v2`，本次 PID 43176，源码/实际构建为 `c7440dd8ed0043c9636bb33fd9da4ec438341e7a`，不把并行未构建的 H1 源码算入窗口证据。
- 在现有失败会话通过统一模型 UI 发出真实 model.set；JSONL 新 model_change 和新私有 settings 默认 provider/model 均确认 `deepseek/deepseek-v4-flash-vision-exp`。原 runtime.getState 对该 SDK 的 model 字段未返回值，未用空值冒充绑定成功，以实际 setModel、Pi 持久模型事件和随后真实调用模型三者核对。旧403保留；不自动绑定陌生默认模型。
- 随后准确 title 的单次测试 dialog 返回锁定合成 DOCX，finally 恢复；实际主消息、报告源和样本 SHA 一致。唯一成功 intake START 生成11候选（3 VARIABLE、2 EXCLUDE、6 FIXED）及2警告；这是此合成样本结果，不声称模型普遍稳定或旧 DOC 转换已解决。
- 从报告实际“开始复核”进入 TEMPLATE_DRAFT，默认 UNIVER_PREFERRED（没有 OFFICE_TEST/SURFACE 环境覆盖）。试填项目名称 `OFFICE_ISOLATED_SAVE_REOPEN_20260909` → “同步到全文2处” → iframe“保存工作副本”显示已保存 → “关闭并保存草稿” → 同报告“继续文档复核”。重开截图已目视正文两处标记仍在；侧栏试填框恢复示例值不是正文丢失，未用侧栏值冒充保存结果。
- `evidence/office-save-reopen-result.json`：私有快照 `27d8d2ac048151f4e3a9fdddfcb47dff46da4483ee971c0e56b334861063e697.json` 的 dataStream 保存前/重开后标记均2处。快照文件 SHA 分别 `f18b12acd033ddf3e4873a1ec860db037ef2fb1d8dcfbd80d6366afc49b567fb`、`28f192b48e14e914b432d626ec5fcf5029b7ce1803b55231f41c3a9539d83d8c`；源 DOCX SHA 仍 `4983f085dd243b81e1b61bb1774b5e23bfcd4f21a6544582da6b86df5224df55`。没有确认字段、物化、建库或修改源文件。
- 证据 `office-edited-before-save.png`、`office-saved.png`、`office-reopened.png` 均在新 evidence。保存/重开脚本初次已保存关闭，因测试按钮 accessible name 写错而超时；依据真实按钮“继续文档复核”修正测试定位，仅续跑重开，不伪造状态或重复模型。复现命令：`node E:/XiaoguiInternalCandidate/office-isolated-20260908-v2/evidence/office-save-reopen.mjs --resume-after-close`，输出 OFFICE_SAVE_REOPEN_DISK_PASS。该续跑命令仅适用于已保存关闭现场，不能声称从空白开始一步重现整个准备。
- 限制：这不是 NSIS/安装后验收，也不是 DOC Word 转换验收；合成表格原有窄列导入提示保留，不宣称 Word 像素级一致。此前直接 out/main 启动的 gateway 失败与本次 package 根正常启动分开记录，未增加生产路径兜底。当前继续由 Terra 补 H1 固定接缝；Word 增量纳入决定已明确，待独立技术复验通过直接承接，不再回问是否纳入。

## 2026-09-08｜全新 Office 隔离场景与 Prompt 1.2.2（准备点）

- 总控重新授权仅新隔离场景。旧 `E:/XiaoguiInternalCandidate/test-profile`、非测试文档与旧会话继续冻结；继续工作不等于用户承认旧选择。新根 `E:/XiaoguiInternalCandidate/office-isolated-20260908-v2` 实查不存在后创建 profile/pi-agent、project、evidence、temp，只从原统一 Pi 目录复制 models.json/auth.json，不复制异常 profile 的会话、报告、绑定或 Token。
- 唯一样本 `project/office-input.docx`，8985 bytes；源与副本 SHA-256 `4983f085dd243b81e1b61bb1774b5e23bfcd4f21a6544582da6b86df5224df55` 一致。新场景要求从真正 package 根启动、核 Main/Worker 身份、默认 UNIVER_PREFERRED，不设置 XIAOGUI_OFFICE_TEST。准确 title 的 dialog.showOpenDialog 仅为该 PID 单次返回锁定样本，finally 恢复，不再采用全局原生键盘/UIAutomation。
- 本源码点仅承接已定向批准的 `7ffbc22bc2023c4df7d56a1500ef4bad041c7187` Prompt 小差异：template-intake-analysis 1.2.1→1.2.2、逐项 suggestedName 约束、合法 VARIABLE 示例；源对应两测试和 prompt inventory 版本引用。没有更改 schema、解析器、修复循环、DOC 转换、Office、C‑01 coding.workspace 或模式/授权规则。
- Terra 执行：`npx vitest run src/main/__tests__/pi-prompt-catalog-effective.test.ts src/worker/xiaogui-work-docx-template-intake-tool.test.ts`：2 文件 / 19 通过；`npx vitest run src/worker/handlers/worker-handlers-turn.test.ts -t "P16 reuses a Worker while a neutral CODING EXECUTE turn gets the default workspace tools"`：1 通过 / 12 未选中。三个受影响 TS 文件 ESLint、diff-check 通过。日志分别为新 evidence 下 `work-prompt-1.2.2-focused.log`、`c01-default-tools-focused.log`。没有重复模型、DOC转换或全量测试。
- 下一步先固定此源码/构建点并回报无模型身份核验，再只允许该 DOCX 一次必要 intake→复核→私有 Office 草稿编辑/保存/关闭重开；不物化、不建库、不再分析。当前仍是准备点，不是 Office/DOC/最终包通过。
- H1/C3 只读接缝清单已回协调者：需在固定输入放行后恢复现有 polling/refresh、inbox IPC/Preload allowlist、人工接收/计划草稿 UI，保留 e232 显式重登录；不能整树覆盖已验 TaskHub/CODING。Hub 70c93d0 复用 H1 协议，无新桌面 C3 状态机；d76 向导完整引用待回收。用户已明确所有目标机有 Microsoft Word，后续等待 WORK 的 Word DOC 主转换固定输入，不新增无 Word 兜底或转换选择页。
- 固定源码 `c7440dd8ed0043c9636bb33fd9da4ec438341e7a` 已推送；E 新根 build/out 的 Electron-vite Main/Preload/Renderer 构建通过，main SHA-256 `12759ffa2b4fa862375d3729b857a91b1405dd3cd453d636a52a0d15716f72ca`。沿用本树已构建且未修改的 Office 产物，不制作安装包。
- 无模型目录身份前置通过，证据 `evidence/preflight.json`：appPath 为真正 package 根，userData/Main agentDir/实际 Worker sessionFile 均在新 root，cwd 为新 project，Office 覆盖变量未设置且实际 `UNIVER_PREFERRED`。测试控制 stdin 关闭和模型菜单点击超时曾导致两次仅本轮新 profile 重启，前两份 preflight 保留，没有对旧异常 profile 操作。
- 新场景实际22:55主请求未达到验收：准确 title 单次返回锁定 `office-input.docx`，实际消息名称匹配；但运行时为 `anthropic/claude-opus-4-8` 而非测试选定模型，返回403，JSONL仅 user 与 assistant/error，未记录 toolCall/START，未生成新报告。已停，不自动切换或重复请求。只读发现无会话模型选择只更新 Renderer runState，没有发 model.set；缺少运行时实际选型确认，不能把菜单点击当模型绑定通过，也未据此修改生产模型逻辑。待明确恢复后须通过统一模型选择与 runtime.getState 核实，再决定是否继续唯一实际 intake；当前 Office 仍未通过。
- d76完整引用现已核对为 `d76fe2866d4e927a5eb95baf15e9e4c567e7f430`：仅70c93d0部署包的仓外配置向导，不是新桌面协议；C3服务器内部密钥不能搬入桌面，实际Hub根址待中台启动/release回执。本轮没有执行向导、读取其私密env或启动Hub。

## 2026-09-08｜Office 联用准备：输入选择未闭环（未通过）

- 协调者已对 `e232a360815a81dc80b436d75e8e0d7a9e6c0884` 的 MODE 与显式重登录返修给出 Standards CLEAR / Spec CLEAR，允许继续 Office；这不等于最终整版或 NSIS 通过。
- 同 E profile 的生产 IPC 返回 Office `UNIVER_PREFERRED`，未使用 `XIAOGUI_OFFICE_TEST`。文件页普通 DOCX 只有系统打开，不能拿它替代 Office Surface；可编辑 Surface 来自模板草稿，该测试 profile 尚无草稿。
- 为准备草稿，点击正常 DOCX 整理入口并尝试在本候选原生选择器选择 E 盘合成样本；UIAutomation 定位到本候选 PID 的对话框/文件名控件后设值、点击打开，但实际会话提交的文件名不等于预定合成样本。因此输入证据不闭合，不能计为合成 DOCX 或 Office 通过。
- 已停止后续业务操作，仅检查事件元数据：该次 intake 和模型回复在检查时已经结算，不能把点击停止表述成成功取消。未在仓库提交该文档、正文、报告或原始会话。私有现场继续保存在 E profile 及 `evidence-20260908/local-app.log`，已向协调者回传精确私有索引。
- 元数据补核：当地时间 18:40:14 `START`（参数仅 action），18:40:17 工具成功返回 DRAFT、2 个 FIXED 候选、`SCAN_COUNT_UNKNOWN`、有模型分析版本；18:40:20 回复结算。产品已完成读取和报告处理，不能从主用户消息只含文件名推定子分析未接收正文；未检查原始模型 HTTP 载荷，不推断确切上传全文范围。`canMaterializeTemplate=false`，未打开该报告复核或生成正式模板。
- 在协调者随后收紧为仅临时替换目标 dialog 返回值的指令到达前，已收到 WORK owner 的正常草稿前置及其 WM_SETTEXT/BM_CLICK 辅助方法，另开空对话选择同 E 合成样本；实际提交名称及源 SHA-256 `4983f085dd243b81e1b61bb1774b5e23bfcd4f21a6544582da6b86df5224df55` 已核对。此第二次 DOCX 报告 10 个 UNRESOLVED / 3 警告，分析仍 PARTIAL，未拿它抵消旧 DOC 丢表格问题。
- 第二次合成报告点击真实开始复核后，Office gateway 提前退出 1，界面降级 HTML；没有编辑/保存/重开通过证据。源码网关依据 app.getAppPath 解析入口，而本次测试 launcher 直接以 out/main/index.js 启动，存在测试 appRoot 语义疑点，未据此认定安装产品缺陷或修改代码。收到最新暂停口径后，已停止新选择、模型及业务操作，仅回传上述元数据；后续只允许使用协调者批准的精确目标 dialog 单次返回合成样本、finally 恢复方法，不再依赖未闭环的 UIAutomation 值提交。
- 尚不能判定选择不一致来自人工并发操作或原生自动化提交语义，未据此修改生产选择器、权限或文件路由。下一步等待既有 Office 无新分析入口/合成 fixture 回收或明确选择确认，再继续编辑、保存与关闭重开。本次没有 Office 保存/重开 PASS，也没有最终安装包结论；源码保持 e232a360 不变。

## 2026-09-08｜RC 基础返修：模式重建诊断与显式重登录（候选）

- 固定父提交 `f9455671f402109863defdc945bb1747066e53bb` 已推送独立 RC 分支；协调者基础审查 Standards CLEAR、Spec 1 项 P2（已配置后无重新登录入口）。模式切换是另条已批准的基础使用阻断。最终 DOC/H1/C3/NSIS 未完成的边界不变。
- MODE 原因收敛：已 await 的可信 Worker 初始化完成后，handler 额外调用依赖前台槽位的通用诊断 RPC；`session.setVisible(null)` 可撤销该槽位，额外查询因此抛 `Worker not started`。Terra 只修改 `src/main/xiaogui/ipc-handlers.ts`，读取同一次 `WorkerInitResult.promptDiagnostics`；缺失诊断、错误模式、活动回合/权限窗和失败回滚仍拒绝，不改 phase、可信能力、JSONL cwd 或权限矩阵。
- 回归在 `ipc-handlers-scope-lookup.test.ts` 和 `worker-manager-session-isolation.test.ts`。后者使用真实 WorkerManager/消息处理、fake transport 的真实 `init-done` 事件形状，证明 start 在初始化前不结算、撤销前台后旧诊断查询会失败；不是外部模型或 OS 子进程测试。handler 的可控故障与其配对，不能把一处 mock 返回值当完整旅程。
- 红灯：`E:/XiaoguiInternalCandidate/mode-switch-red-foreground-race-f945567.log`，旧实现 2 failed / 30 passed。修复后 `npx vitest run src/main/xiaogui/ipc-handlers-scope-lookup.test.ts src/main/__tests__/worker-manager-session-isolation.test.ts`：2 文件 / 33 通过；`mode-switch-fixed-f945567.log`。三文件定向 ESLint、diff-check 通过。
- `npm run typecheck`：Node/Web 通过（`evidence-20260908/mode-switch-typecheck.log`）。`node node_modules/electron-vite/bin/electron-vite.js build --outDir E:/XiaoguiInternalCandidate/mode-switch-build/out`：Main/Preload/Renderer 通过（`mode-switch-build.log`）；未重建无改动的 Office viewer/gateway。约 19 MB 新生成产物复制至当前测试树 out，主入口源/目标 SHA-256 均 `fccf0fffaa4268200634bedef26c41c50ba61dc25116b212bcf6ee96984e1007`。不是打包或 NSIS 证据。
- 根 Agent 使用原 E profile 重启并运行 `node E:/XiaoguiInternalCandidate/evidence-20260908/mode-switch-ui-probe.mjs fixed-live-worker`：无模型通过；打开既有 CODING 历史后通过已有授权 `workspace.ensureWorker` IPC 实际启动 Worker，再点击 WORK，主进程真实 Ready/init/Init done → abort/dispose → 新 Ready/init/Init done，WORK 选中、无新 MODE 错误。`mode-switch-fixed-live-worker.json/png` 留证。显式无模型启动是探针步骤，不宣称恢复历史本身必然启动 Worker。
- 首次真实失败仍保留；基线的普通窗口重试曾成功（历史恢复是 lazy，没有保证触及重建分支），不将这些成功当红灯或修复依据。最终复验用上述显式初始化的探针补齐真实进程链。
- C2 P2：Terra 只修改 `HubTaskInboxSection.tsx`，已配置状态显示显式“重新登录并配对此小规”，点击仅展示原表单；提交才调用原 connect，失败保留重试，成功回到已配置视图。不新增认证系统、设置页、后台轮询，不清凭据或 C2 outbox。
- 新 `HubTaskInboxSection.test.tsx` 用真实组件和 IPC mock 验证已配置/未配置、点击入口不 connect、首次提交恰好一次、失败再次提交、成功收起表单。根将合成测试密码改为符合 Main 长度要求的值，并补成功退出表单断言。`node node_modules/vitest/vitest.mjs run src/renderer/src/xiaogui/components/HubTaskInboxSection.test.tsx`：2/2 通过（`evidence-20260908/relogin-final-test.log`）；组件两文件 ESLint 与最终 Web typecheck 通过，Node 文件在上述 typecheck 已通过且此后无生产修改。这是聚焦组件证据，不是过期真实 Hub token 联调。
- MODE 窗口使用的构建早于最后 C2 重登录微调，不能称最终 HEAD 全部 UI 的构建/安装验收。协调者允许此处只跑重登录聚焦 UI 门；完整组合构建仍在最终候选装配执行。下一步提交独立分支后等待定向复验，不交 NSIS、不合主线。


## 2026-09-08｜Windows 院内 RC 基础集成（未完成最终交付）

- 输入：已验证集成基线 `8d7222f102b09fbfcf6e4092a42575f035aea9f2`；独立分支 `codex/windows-internal-rc-20260908-v1`。不合入 WORK、阶段线或主线，不发布 Release。
- 当前目标已由协调者明确扩展为 DOC 分析、H1/C3、C2、CODING 和 Office 的同一 Windows 安装候选。本文记录的是可审查基础，不是范围全部完成的验收。
- 产品固定为 `小规 Agent 院内候选`、`com.xiaogui.agent.internal`、`0.3.0-rc.2`；仅候选身份/版本元数据变更，没有升级 Pi、OMP 或其他依赖。Main 最早初始化统一 `userData/pi-agent`，尊重显式 `PI_CODING_AGENT_DIR`，不引入第二模型配置。
- C2 按固定 `14f3616533b34d7fb7d42ddabf6ad80d099e65e7` 的窄模块移植，不整分支合并 H1 祖先。复用 Pi Resource Loader 的公开 `skillsOverride`、现有 Hub 登录组件与 safeStorage；不新建 Skill 加载器。新增 BOM 恢复只在 skills hook，不修改既有 extensions hook、角色保护或直接 CODING 工具权限。
- Office 默认 `UNIVER_PREFERRED`；显式 OFF 和未知值仍 OFF，不改变既有 DOCX/HTML 降级。当前 DOC intake 禁用和 H1 task inbox 不轮询是等待固定候选的临时门，不能作为最终范围豁免。C2 自身 receipt outbox 保持独立可运行。静态 APP 从社区浏览器打开，没有新增桌面 APP 按钮。
- 尚未完成：DOC/H1/C3 最终固定输入及窄差异集成、真实隔离 Hub 的 C2 组合、最终 NSIS/安装后旅程。不得据当前基础构建宣布这些已通过。Nexus 已由中台在本日确认恢复；等待其唯一新 Hub BaseURL，不自行启动平行服务。

### 本轮修改及复用来源

- 根 Agent：`package.json`、`package-lock.json`、`electron-builder.yml`、`sbom.cdx.json`、共享 product/office/intake 契约及对应测试、`src/main/bootstrap-profile.ts`、WORK intake composition/service/tool、`WorkHomeView` 及测试、本记录。
- Terra：共享 C2/Hub 契约和 IPC、`src/main/xiaogui/c2/`、Hub 连接所需 `hub-task/` 模块及门测试、secret-store、Main/Preload/Renderer 装配、`C2ArtifactInstallDialog`、`HubTaskInboxSection`、`CollaborationHubPanel`、Pi resources/Skill BOM hook。最终精确文件以本阶段 Git 提交 diff 为准。
- C2 来源链：`4d52588` 核心、`1756a2c` hardening、`2aa7d45` 无会话登录、`8dc9f81` BOM、`14f3616` Pi 公开 hook；不引入浮动依赖或陌生插件。已有第一方 `resources/pi-skills/xiaogui-work-documents/SKILL.md` 通过 Pi 原生命令实际展开验证；不以 Skill 数量替代行为证据。

### 已执行验证（不替代最终安装验收）

- 新树独立 `npm ci --offline --ignore-scripts --no-audit --no-fund`：1197 包完成；独立 Electron 43.0.0、better-sqlite3 native 和 LibreOffice 26.2.5 按既有校验脚本准备通过。没有使用另一工作树的 node_modules 链接。
- `npm run build`：Main/Preload/Renderer/Office gateway 构建通过；这是第一次基础构建，早于最后的无会话登录/静态 APP 按钮删减，不能冒充最终 HEAD 构建。
- `npm run typecheck`：Node/Web 通过（Terra 集成门）。
- `npx vitest run src/main/xiaogui/c2/archive-installer.test.ts src/main/xiaogui/c2/deep-link-dispatcher.test.ts src/main/xiaogui/c2/install-coordinator.test.ts src/main/xiaogui/c2/receipt-outbox.test.ts src/main/xiaogui/c2/static-app-url-policy.test.ts src/main/xiaogui/hub-task/worker-credentials.test.ts`：6 文件 / 11 项通过。
- `npx vitest run src/main/xiaogui/hub-task/worker-service-c2-gate.test.ts src/main/xiaogui/hub-task/worker-ipc-c2-gate.test.ts`：2 文件 / 2 项通过；连接保存不启动任务轮询，status/connect 白名单成立。
- 无 scope 末端修正由根 Agent 完成：Terra 恢复任务停在 pending_init，停止该未启动任务后只在原空态加回同一个连接组件。`node node_modules/vitest/vitest.mjs run src/renderer/src/xiaogui/components/CollaborationHubPanel.test.tsx --testNamePattern='没有 canonical 会话'`：1 通过 / 29 未选中；原空态提示、登录入口和不读取/执行协作计划均保留。没有新增 Hub 入口页或自动配对。
- `npx vitest run packages/shared/xiaogui-office-surface-mode.test.ts packages/shared/xiaogui-product.test.ts src/main/xiaogui/work-docx-template-intake-service.test.ts src/renderer/src/xiaogui/components/WorkHomeView.test.tsx --testNamePattern='院内候选|产品身份|三个|快捷'`：4 文件 / 7 通过 / 18 未选中；未选中不是额外通过证据。
- 原始基础构建/准备及根测试日志：`D:/CodexTemp/xiaogui-windows-internal-rc-20260908`。Terra 的前两组输出来自工具返回，没有虚构不存在的日志附件。
- 末端验证日志在 `E:/XiaoguiInternalCandidate/evidence-20260908`：`no-scope-login-test.log`、`base-typecheck.log`、`base-eslint.log`。最终差异 ESLint 的提交后复现命令为 `$files = @(git diff --name-only --diff-filter=ACM 8d7222f102b09fbfcf6e4092a42575f035aea9f2..HEAD -- '*.ts' '*.tsx'); node node_modules/eslint/bin/eslint.js @files`，不是在干净工作树上检查零文件；本轮实际运行覆盖所有已改及新增 TS/TSX，退出 0。
- 末端 typecheck 首跑发现 gate 删减时遗漏 `invalidInput` helper（TS2304），恢复固定来源原函数，不改变错误枚举；同一 IPC 门测试补入非法输入不连接断言，重跑 1/1 通过（`base-ipc-test.log`）。保留 `base-typecheck.log` 红灯，不拿前次类型检查覆盖后续删减。
- helper 修复后 `npm run typecheck` Node/Web 最终退出 0（`base-typecheck-final.log`），两个受影响 IPC 文件 ESLint 退出 0；暂存区检查发现新增移植文件 EOF 空行后仅规范末尾换行，再执行 `git diff --cached --check` 通过，没有改逻辑或重复跑成熟套件。
- 本地窗口采用统一 `E:/XiaoguiInternalCandidate/test-profile`，实际 agentDir 为其 `pi-agent`；证据 `E:/XiaoguiInternalCandidate/evidence-20260908/local-profile-identity.json`，`packaged=false`。仅复制用户统一模型配置到私有测试目录，原配置不变，仓库不收原配置或凭据。
- 原生选择框返回值由 Playwright 提供合成项目目录，随后走真实 Main 选择/登记链；不是用户手点原生选择器的证据。该项目仅包含合成文档。
- 真实 Skill：用户配置模型 `deepseek/deepseek-v4-flash-vision-exp`；JSONL 中有 Pi 展开的完整 `<skill name="xiaogui-work-documents">` 后产生正常回复，未调用工具（任务明确要求不调用）。截图 `native-skill-response.png` 和原始会话留 E 盘私有证据。该结论只覆盖 Skill 展开与模型使用，不覆盖模型自主选择 Skill 或 DOC 分析。
- 同 E profile 真实 CODING：首次 write 未及时确认，JSONL 为 `USER_OR_POLICY_DENIED`；明确重试后实际 UI 逐次允许 write/read，两次 `isError=false`。磁盘 `rc-coding-proof.txt` 为 23 bytes `RC_UNIFIED_PROFILE_PASS`，SHA-256 `31616b353177a94b786df1947386d2121451840fa7b404d2990aa62216bba7ba`，与回读一致。截图 `coding-write-permission.png`、`coding-read-permission.png` 实含来源项目、来源对话、操作、相对路径和两选项；`coding-response.png` 为最终回复。记录的是已允许的真实工具执行，不宣称截图等于用户亲自验收。
- 私有会话索引（同 `test-profile/pi-agent/sessions/--E--XiaoguiInternalCandidate-test-project--/`）：Skill `2026-09-08T09-57-46-647Z_01a08073-c817-7f0d-be0a-b4aef787fc50.jsonl`；CODING `2026-09-08T09-59-08-619Z_01a08075-084b-7f64-a48f-171b01011ad0.jsonl`。原始文件不提交仓库。

### 风险与下一门

- 本轮 built 窗口实际阻断：CODING 写读成功后点击 WORK，Main `ipc:xiaogui.mode.switch` 报 `XIAOGUI_MODE_WORKER_REBUILD_FAILED: Worker not started`，随后日志出现 Init done，但界面仍 CODING。原始 `local-app.log` 与 `mode-switch-failure.png` 留 E；已停止 Office 旅程并通知协调者，未现场扩大修复，Office 编辑/保存/重开未验证。文件页的 DOCX“系统打开”入口不作为 Office Surface 失败证据。
- 协调者随后批准在基础固定点之后处理上述最小模式切换问题包：先无模型真实 IPC/Worker 就绪回归，再按查实原因修复、回同一 UI 验证；本基础提交不包含该修复，不据旧同名故障猜测根因。
- 观察：原生 Skill 展开后侧栏历史标题显示 `<skill ... location=...>` 片段；这条证据不证明公开展示已脱敏。本基础未修改相关历史标题投影。
- D 盘余量快速波动；新 profile、测试临时文件、大型输出固定 E 盘。没有删其他树、保护 stash 或旧证据；源树保持原样。未制作 NSIS/Portable。
- 上游 Linux Quality 仍有既有红灯，未扩大本轮修复或重新跑全量。最终安装包、ASAR、协议冷/热启动与同 profile 核验仍待完成。
- 下一步：冻结基础提交供审查；等待 DOC/H1/C3 通过后的固定窄差异，保留 `coding.workspace` 默认四工具，最后只制作一套完整 NSIS；不交范围不全的最终包。

## 2026-09-07｜B-E2E-M4F：跨平台临时目录修正（Windows定向通过）

- 固定输入 `0f4e26fd2a512d0eeba5d9303b0826bb62dc9a5a`；用户原包内目录准备授权由协调者确认。本轮仅 Terra 修改 `e2e/xiaogui-delivery-baseline-recovery.spec.ts`，主 Agent 更新本记录；没有生产、依赖、权限、模式、TaskHub或workflow变更。
- 上一候选 Quality run [34129144681](https://github.com/locadds/pi-app/actions/runs/34129144681) 实际 headSha=0f4e26f…，最终 failure：8 job成功；Ubuntu E2E 17pass/1skip/1fail，M4F首次bootstrapAddress的native选择之后workspace.open拒绝，重试相同，第二个冷启动app未到；Windows限定三角色正常skip。
- 已查明该fixture原 TEMP_ROOT=`E:\\CodexTemp\\m4f-electron-journey`，EVIDENCE_ROOT=`E:\\Codex\\evidence\\coding-m4f\\electron-journey`；它覆盖外层D TEMP/TMP，因此上一记录“所有新E2E均D盘”过宽，M4F为沿用E盘的明确例外。Linux下这些字面量不是合法绝对盘路径。本轮没有将E简单改为D，而是用 node:os tmpdir()+子目录，Windows尊重外层D，Linux使用主机真实临时目录。
- bootstrap和第二app使用同一个tempRoot；截图、rows和失败debug使用testInfo.outputDir。保留run-*目录、真实打开链、全部正负业务断言/超时；finally仍核对run目录处于临时根之下才清理。未新增skip，未更改生产路径判断。
- 定向命令（cwd本集成树，TEMP/TMP和npm cache同上轮D设置）：`node node_modules/@playwright/test/cli.js test e2e/xiaogui-delivery-baseline-recovery.spec.ts --max-failures=1 --output=D:/CodexTemp/xiaogui-integration-e2e-prep-20260907/e2e-results-07`；`node node_modules/eslint/bin/eslint.js e2e/xiaogui-delivery-baseline-recovery.spec.ts`；`git diff --check 0f4e26fd2a512d0eeba5d9303b0826bb62dc9a5a`。
- e2e-07-m4f-tempdir.log：Windows M4F 1/1通过，17.1s；单文件eslint和diff-check通过。证据位于e2e-results-07，临时项目位于D盘外层TEMP下并由原finally清理。其余18项无代码变化，不重复；不重build、不跑外部模型。Linux修复结果须由新SHA远端E2E证明，不能用Windows成功代替。
- 旧CI完整日志已保留D证据目录：quality-linux-e2e.log、quality-unit.log；不清除红灯、不取消或重写原run。新最小候选推送后只运行原Quality一次，不更改工作流以筛掉失败job。

### 旧CI全量unit：初步分类，未逐项判定

- 原unit job101764806342：63 failed files /375passed /1skip；35 failed tests /2171passed /7skip；1 unhandled error。失败文件数包含装载/收集失败，不能等同63个产品Bug。
- 环境/装载类：attempt-workspace、application等Main测试报 `Cannot bundle Node.js built-in node:sqlite`，提示客户端环境打包问题；不是本次E2E文件的生产diff。
- Electron配置mock类：skills-resources、prompt-abort-isolation报缺少 `projectName`，实际栈进入electron-store/conf。
- 跨平台fixture类：worker-session-creation-operation把Windows D盘字面量与Linux resolve后的 /home/runner/.../D:/... 比较；执行租约测试报 WORKER_AUTHORIZED_CWD_REQUIRED，需另门逐项确认路径fixture。
- 旧mock/断言类：extension-ui-channel mock缺resetExtensionDialogDedupe；worker-session-branch-actions旧调用断言；WORK materialize提示词仍期望“聊天确认只保留为后备路径”，生产文案已要求预览按钮授权。
- 以上仅据日志给代表例，未对其余失败逐项归因或整改，不声称全部都是测试问题。它们超出本包范围，保留为独立全量基线门；本轮不修63文件，也不把全量unit未清零当成Windows19项未运行。


## 2026-09-07｜B-E2E：可信目录准备契约同步（19项分批通过，待固定SHA Quality与复验）

### 目标、固定点与实际修改

- 用户经协调者明确批准：从 `e973bec29745cad5455705b1224a14c073dac1bb` 继续，仅修旧 E2E 的可信目录准备并处理远端 Quality 调度。开工核实 HEAD/上游/GitHub 一致、工作树 clean、保护 stash `a6ba3bb91fa5fc68aeb42d7f64897e4b1e862c61` 未变；仍在独立 `codex/work-coding-integration-c01-v1`。
- 遇到原协作展示断言过时后先暂停，用户随后明确批准“同意，仅同步旧展示断言”。仅按现有Panel/组件测试同步根任务就绪、后继等待依赖，补足无running/verifying/done，保留跨会话隔离、DESIGN保留、取消和刷新恢复；未扩展生产行为。
- Terra 负责测试代码，主 Agent 负责真实运行、失败分类及记录；实际文件仅 `e2e/helpers.ts`、`e2e/m1-canonical-scope.spec.ts`、`e2e/xiaogui-collaboration.spec.ts`、`e2e/xiaogui-delivery-baseline-recovery.spec.ts`、`e2e/xiaogui-real-three-task-journey.spec.ts` 和 DEVELOPMENT_STATUS.md。
- 复用现有 Electron 测试 Main evaluate、原生 dialog.showOpenDialog、真实 ipc:dialog:openDirectory / workspace.open / session.list / session.prepare，不新增产品功能或框架。不修改 src、权限、Scope/Worker实现、模型、WORK/TaskHub语义、构建配置或依赖，不引入新 Skill/插件。

### 实现与边界

- helper 只临时模拟 Electron 原生目录选择返回；调用真实 Main dialog handler 产生登记，再调用真实 workspace.open；finally 恢复原 dialog 函数。没有直接写可信登记库，没有 mock 授权/Scope/Worker 成功返回，没有增加 PI_E2E 放行。
- fixture 保留真实公开 scope.set 初始化模式，随后首次 list→prepare(bind:false)→侧栏刷新。prepare 核对非空会话 ID 和准确文件；移除 Renderer settings.set currentProject/recentProjects 的旧造数。M1 通过第二次原生选择盘符大小写变体保留项目唯一性验证，未删除去重场景。
- 原 Scope lookup NOT_FOUND/PROJECT_MISMATCH 失败注入负例保留，仅验证失败不切换，不用于伪造授权成功。
- 协作 fixture 的地址仅显式投影 projectId/sessionKey，避免把 sessionMode 附加字段传入 strict AddressSchema；原 ok=true 断言增加真实响应诊断，未降低预期。
- Main/Preload/Renderer 构建产物摘要前后相同（记录在 build-input-sha256.json），复用已验构建；没有重跑 build、130项聚焦、288项脚本或完整类型检查。原 node/web tsconfig 不包含 E2E，本轮不宣称它覆盖新测试；修改的测试由 ESLint 和真实 Playwright 转译执行覆盖。

### 命令与证据

cwd 均为本集成树；本轮私有证据目录为 `D:/CodexTemp/xiaogui-integration-e2e-prep-20260907`。新 E2E 使用独立 profile，外层配置为D盘 TEMP/TMP/cache；M4F原fixture曾覆盖成E盘，此例外及随后修正见上方B-E2E-M4F记录。不使用日常配置，不调用外部模型。

```powershell
$env:TEMP='D:/CodexTemp/xiaogui-integration-e2e-prep-20260907'
$env:TMP=$env:TEMP
$env:npm_config_cache='D:/CodexCache/npm'
$env:PI_CODING_AGENT_DIR='D:/CodexTemp/xiaogui-integration-e2e-prep-20260907/agent'
$env:PI_RENDERER_SANDBOX='1'
node --test scripts/tests/e2e-env.test.mjs
node node_modules/eslint/bin/eslint.js e2e/helpers.ts e2e/m1-canonical-scope.spec.ts e2e/xiaogui-collaboration.spec.ts e2e/xiaogui-delivery-baseline-recovery.spec.ts e2e/xiaogui-real-three-task-journey.spec.ts
node node_modules/@playwright/test/cli.js test --max-failures=1 --output=D:/CodexTemp/xiaogui-integration-e2e-prep-20260907/e2e-results-02
node node_modules/@playwright/test/cli.js test e2e/xiaogui-collaboration.spec.ts --max-failures=1 --output=D:/CodexTemp/xiaogui-integration-e2e-prep-20260907/e2e-results-05
node node_modules/@playwright/test/cli.js test e2e/xiaogui-delivery-baseline-recovery.spec.ts e2e/xiaogui-real-three-task-journey.spec.ts e2e/xiaogui.spec.ts --max-failures=1 --output=D:/CodexTemp/xiaogui-integration-e2e-prep-20260907/e2e-results-06
git diff --check e973bec29745cad5455705b1224a14c073dac1bb
```

- e2e-env.log：既有相关脚本 3/3；eslint-final.log：五文件通过；diff-check通过。没有扩展到完整脚本/全量模型套件。
- e2e-01.log：3 passed /1 failed/15未跑。已越过原trusted_project_open_required，但新增helper提前list导致三模式首先固化为WORK；只读确认scope.set仅改legacy而不覆盖canonical。按协调确认调整为先原真实模式初始化后首次list，保留此红灯记录，不修改生产模式机制。
- e2e-02.log：13 passed /1 failed/5未跑，46.0s。M1完整原断言通过（含三模式、盘符变体去重、跨模式打开、clone/fork和查询失败不变更）；13项还包括既有单独sandbox=0诊断用例，它未替代sandbox=1构建启动证据。第14协作seedDraft只记录ok=false。
- e2e-03-collaboration-diagnostic.log：单项诊断失败，真实响应 INTERNAL；只读确认 parseIpc 对 strict schema 失败即返回此代码。session.list 返回 canonicalScope 含sessionMode，而旧 fixture 直接透传整个对象。修正为两个字段的精确地址；不放宽 Main schema。
- e2e-04-collaboration.log：单项重跑，已过建稿、刷新恢复和批准，38.6s后停在原 `PENDING_DISABLED` 断言。真实界面为“可执行／就绪／等待依赖”；旧下一行“执行能力将在后续 CODING Adapter 接入”未运行到，不计为第二失败。现有组件及其测试早已有 READY→就绪 语义，先暂停并取得上述用户明确批准后才同步测试。
- e2e-05-collaboration.log：1/1通过，11.3s。WORK根collect为就绪、后继write等待依赖；CODING根fix就绪；两者running/verifying/done组均为0，未自动执行；原刷新恢复、跨会话隔离、DESIGN保留和取消均通过。
- e2e-06-remaining.log：剩5/5通过，1.5min、exit0。M4F旧基线漂移零写入及新批次可应用（17s）；三角色串行/检查点恢复/真实Diff/受控交付（1.1min）；最后3项品牌/模式/执行控件。三角色使用既有Scripted Runtime，不是外部模型旅程，证据目录 `D:/CodexTemp/xiaogui-hub-m4g-real-journey-v1/evidence/run-1788788541856` 有 journey-rows.json、journey-events.jsonl、检查点和06-apply-succeeded.png；交付截图已查看。
- 原19项最终按02前13+05协作1+06剩5分批全覆盖通过；不是声称某一次全套命令19/19。每次只在新改动/明确失败后重跑受影响部分，没有重复前13项；本地无剩余未跑E2E。

### 当前结论及未完成

- 本包可信目录选择、会话发现/prepare、M1模式/去重真实门和获批的旧展示断言已同步；19项E2E分批通过。没有源码/架构偏差；行为只变测试准备及对既有真实语义的断言，不据此宣称WORK所有PARTIAL项完成。
- CI 原404原因已由协调者与用户处理：fork首次Actions启用后Quality列表可见，id=352321368、active；没有修改main、workflow或提升token权限。待本测试候选提交推送后，仅触发Quality并核对run.headSha；Release不得触发。冻结提交前不宣称新SHA CI已跑。
- 本阶段仍未合任何主线/WORK/阶段线、未发布。WORK PARTIAL、Office默认OFF、DOC分析降级、Portable仅历史build/hash、历史缺toolResult投影P2均继续保留；后续只按协调/用户批准范围处理剩余门。


## 2026-09-07｜B：WORK / CODING 独立集成（阶段候选，E2E 未通过）

### 固定输入与集成范围

- 已收到协调验收者对 A `f564d691b9add672d80102734409d589c8ae5043` 的 APPROVE，以及按 A→B 顺序继续独立集成的批准。下方 A 的“待复验”为当时交付历史，不代表当前状态。
- 本树 `D:/CodexWorktrees/xiaogui-work-coding-integration-c01-v1`，分支 `codex/work-coding-integration-c01-v1`。输入固定为 CODING `e50b7f8a047cfe50c2f76909bf6a47cfbcb40a2d`（包含已验 C-01 `4a2bdf4d968baca3df381fe8ad22371d59ef55f1`）、WORK `c1adfd44514ccea622185a9bee028adcf99dd441`、上述已验 A。
- 普通合并保留父历史：`898fe26f4302a7885869b5858e3409611d7713c5` 父为 e50/c1；`4924bc024fbf5dd9fab70570833dd59976569555` 父为 898fe26/f564。只冲突 DEVELOPMENT_STATUS.md，手工保留两侧阶段记录；没有整文件选 ours/theirs。
- 本轮没有新写生产功能、没有升级依赖；只集成上述固定实现并追加本记录。相对 e50 的实际集成文件清单使用 `git diff --name-only e50b7f8a047cfe50c2f76909bf6a47cfbcb40a2d..4924bc024fbf5dd9fab70570833dd59976569555`（40 文件）。主要接缝为 Prompt Matrix/Capabilities、WORK intake/save、共享 Sandbox 打开和 Main Renderer 寻址，具体来源保留在两个 merge 的父提交中。
- Pi/Skill/插件复用边界不变：复用锁定 Pi 0.84.1 及两条已验分支的现有 Module，没有新增能力需要选型，也没有引入 OMP Runtime/UI/模型配置。源 CODING/WORK/A HEAD 与干净状态未变；保护 stash 仍为 `a6ba3bb91fa5fc68aeb42d7f64897e4b1e862c61`。

### 独立装配与构建版启动

- node_modules/out/userData/agent 均为本树或本轮 D 盘私有目录，不链接源树；只复用 D 盘下载缓存。`npm ci --ignore-scripts --offline --no-audit --no-fund` 成功安装 1197 包；本树 Electron 43.0.0 install.js 和 electron-builder install-app-deps 成功。未重建其他工作树 native 模块。
- `npm run build` 成功，包含 Main/Preload/Renderer/Office 产物，未制作安装包或 Portable。字体同步仅造成 OFL.txt 工作区换行标记，核实内容 diff 为空后 git add 归一，无字体或许可证净修改。
- 构建版命令：设置 `PI_CODING_AGENT_DIR=D:/CodexTemp/xiaogui-work-coding-integration-20260907/agent`、`PI_RENDERER_SANDBOX=1`，运行 `node node_modules/electron/cli.js out/main/index.js --remote-debugging-port=9353 --user-data-dir=D:/CodexTemp/xiaogui-work-coding-integration-20260907/built-user-data`。本次环境没有 ELECTRON_RENDERER_URL，不使用开发服务器。
- 真实 CDP：URL 为 `file:///D:/CodexWorktrees/xiaogui-work-coding-integration-c01-v1/out/renderer/index.html`，title=小规 Agent，window.piDesktop=object，ping=pong。截图 `built-startup.png` 已人工查看，WORK 主页和模式入口可见；通过 Browser.close 正常退出。日志没有本轮 ERR_FILE_NOT_FOUND 或 binding.startupData 异常；仍有开发构建 CSP 警告和托盘图标提示，不冒充安装包证据。

### 可复现检查与结果

以下命令 cwd 均为本集成树。输出保留在 `D:/CodexTemp/xiaogui-work-coding-integration-20260907`；环境 TEMP/TMP 使用该目录，npm 缓存使用 D:/CodexCache/npm。

```powershell
$env:TEMP='D:/CodexTemp/xiaogui-work-coding-integration-20260907'
$env:TMP=$env:TEMP
$env:npm_config_cache='D:/CodexCache/npm'
node node_modules/vitest/vitest.mjs run packages/shared/xiaogui-prompt-matrix.test.ts packages/shared/xiaogui-prompt-capabilities.test.ts src/worker/xiaogui-prompt/behavior-fixtures.test.ts src/main/trusted-session-access.test.ts src/main/ipc/handlers/trusted-open-handler-chain.test.ts src/renderer/src/lib/activate-workspace.test.ts src/renderer/src/lib/__tests__/activate-workspace-switch.test.ts src/renderer/src/lib/subagent-session-navigation.test.ts src/office-gateway/server.test.ts src/office-gateway/save-reliability.test.ts src/office-viewer/core/gateway-client.test.ts src/office-viewer/app-save.test.tsx src/main/xiaogui/office-surface/gateway-supervisor.test.ts
npm run typecheck
npm run lint
npm run test:scripts
$env:PI_CODING_AGENT_DIR='D:/CodexTemp/xiaogui-work-coding-integration-20260907/e2e-agent'
$env:PI_RENDERER_SANDBOX='1'
npm run test:e2e -- --max-failures=1 --output=D:/CodexTemp/xiaogui-work-coding-integration-20260907/e2e-results
git diff --check e50b7f8a047cfe50c2f76909bf6a47cfbcb40a2d..HEAD
```

- focused.log：13 文件 / 130 项通过（模式/阶段默认工具、可信会话、Sandbox 打开、必要保存接缝）。typecheck.log：Node/Web 均通过；lint.log：0 error，timeline.tsx:800 有 1 条既有 unused eslint-disable warning。test-scripts.log：96 文件 / 288 项通过。
- 首次 E2E 启动在 npm 写默认 C 盘 cache 日志时 ENOSPC（e2e.log），Playwright 尚未执行，不算产品失败。未清理用户 C 盘；显式设置上述 D 盘 npm cache 后，执行同一批准门，真实结果记录在 e2e-d-cache.log。
- 实际 E2E：3 passed / 1 failed / 15 did not run，8.7s，exit 1。前三项 composer 通过；第 4 项 `m1-canonical-scope.spec.ts:104` 在 line 161 调用 workspace.open 时得到 `trusted_project_open_required`，立即按 max-failures 停止，没有重复跑同类失败或关闭沙箱绕过。
- 只读定位：该 fixture 创建文件/JSONL 后直接向 Renderer IPC 传路径，未经过原生目录选择登记；Main workspace.open 首先要求 Main 项目能力，因此拒绝。该测试和相关授权实现相对 e50 没有改动，当前证据说明旧测试准备与受信打开契约不匹配，不支持宣称生产授权门损坏；本轮不现场改测试或放宽 Main 门。
- 协调者再次独立核对并同意先记录/推送/Quality、暂不修测试。另在该文件 line 192 静态发现 Renderer 写 recentProjects 的旧准备方式，尚未执行到，不计作第二实际失败。最小后续包仅在 Electron 测试端模拟原生目录选择结果，走真实 dialog/open/list/prepare，不 mock 授权模块、不写注册库/Scope数据、不新增 PI_E2E 放行，保留原断言和负例；须待本轮 CI 结果汇齐后再由用户决定开工。
- 未运行 15 项：settings 3、smoke 3、workspace 3、协作 M2A 1、M4F 旧基线交付恢复 1、三角色 CODING 1、小规窗口/模式/执行控件 3。原 smoke 中有独立 sandbox=0 用例，但本轮未运行到它；不能把它当作 sandbox=1 启动替代证据。

### 状态、偏差、风险与下一步

- 协调者已对固定组装 4924bc0 完成独立双轴审查：Standards CLEAR 0、Spec CLEAR 0；确认父历史、Matrix隔离、A打开顺序、Renderer/preload、保存队列/fieldId、Office默认OFF无组合冲突。这是代码组合通过，不代替 E2E/CI 或完整产品验收。
- 构建版页面/Preload/IPC、130 项接缝、脚本、类型、lint 门通过；完整 19 项 E2E 尚未通过，所以本集成只能称阶段候选。已向协调验收者发送真实失败原句和日志位置，等待其决定最小测试准备整改包；不自动扩大生产整改。
- WORK 保持 PARTIAL：Office 默认 OFF；已验保存/Word 证据不重复运行也不夸大；DOC 分析的 MODEL_OUTPUT_INVALID / 7 UNRESOLVED 仍未关闭；Portable 仅历史 build/hash、未独立解包启动。CODING 历史授权中断无工具结果时的投影误报仍是既有 P2，未在本轮修复。
- 远端 Quality：本候选提交推送后，按批准使用现有 quality.yml 的 workflow_dispatch，必须核对实际 run headSha。冻结前只读查询 actions/workflows 数量为 0，Actions enabled=true，默认 main 的 quality.yml 文件存在；这些信息不等于 CI 已执行。调度结果及 run/实际 SHA 另以私有日志和交付回执记录，不通过改 main/PR/工作流绕过服务端拒绝。
- 不合入 WORK、阶段线或主线，不发布、不制作新安装包；不重跑 OMP、802 MB 装配、外部模型或 Word。下阶段先由协调验收者审阅本固定组合、决定 E2E 准备修复范围，之后才讨论合并许可。


## 2026-09-07｜A：Sandbox 冷打开可信发现时序修复（独立候选，待定向复验）

### 固定输入、目标与所有权

- 从 CODING `e50b7f8a047cfe50c2f76909bf6a47cfbcb40a2d` 建立 `codex/coding-sandbox-reopen-v1`，工作树 `D:/CodexWorktrees/xiaogui-coding-sandbox-reopen-v1`。WORK 固定 `c1adfd44514ccea622185a9bee028adcf99dd441`，本轮不合入、不修改。
- Terra 唯一负责 Renderer 实现与聚焦测试；主 Agent 负责独立依赖、身份核对、冷重启证据和交付。实际修改仅 `src/renderer/src/lib/activate-workspace.ts`、`activate-workspace.test.ts`、`__tests__/activate-workspace-switch.test.ts` 和本记录。
- 只修明确选择的既有会话打开顺序：持久 Sandbox 项目登记不等于重启后 Main 的会话候选登记。原 explicitPick 不等待后台列表，可能在 recordListedSessions 完成前 setPendingBind。

### 实现与复用

- explicitPick 先成功 await workspace.open，再 await 既有 `session.prepare({workspaceId,sessionFile,bind:false})`。项目打开失败即停止；prepare 拒绝、无有效 ID、目标路径不匹配、导航过期均不继续绑定，不回退旧 metadata ID 或最近会话。
- `bound:false` 不参与成功判断；必须非空字符串 sessionId、既有 `sessionFilesEqual` 确认精确文件、navToken 有效，才使用 Main 返回的 ID/路径调用 openSessionIntoWorker。UI 列表刷新置于可信 prepare 之后。
- Main gate、项目/会话持久记录、权限、Worker、TaskHub、模型、Office 默认状态均未修改。WORK/CODING 模式保持原值。
- 实查复用候选：Pi 0.84.1 SessionManager；e50 的 Main session.prepare/discoverTrustedSessions/recordListedSessions；Renderer prepareCanonicalSessionOpen。最后一个仅封装 scope.lookup+mode.switch，不提供可信发现，因此不强行调用或平行扩展。Skill/插件不拥有此 Renderer 导航竞态，采用已批准的最小现有接缝，不新增依赖或会话平台。

### 身份差异与合成现场

- 只读源码核对：Sandbox metadata 保存 Main session.new 回执 ID；Worker currentSessionId 来自 Pi session.sessionId，并非另定义的公开别名。Pi 0.84.1 打开尚未落盘的明确路径时会 newSession 生成新 ID，同时保留路径。独立无模型探针验证了这一机制；不能据此推定原 WORK 现场的完整历史，也没有修改原 JSONL/metadata。
- 本轮使用独立 userData/agent/out/node_modules。Main `workspace.sandbox.create` + `session.new(mode:WORK)` 创建受管 Sandbox `748e22a4`，然后正常退出 Electron。只在该新合成会话中使用 Pi SessionManager.open/appendMessage 写入明确标记的无模型测试消息，产生与原现场相同的“元数据齐全、ID可不一致、重启内存登记为空”条件；没有伪造项目登记或直接写原业务配置。
- 新合成 metadata ID `01a07bf0-7214-7813-a7ee-9a8db25bb8ba`；Pi 首行 ID `01a07bf0-cc3b-7f78-af06-4d2fcc61118f`。文件名保留原 ID；恢复后 UI currentSessionId 为后者，historyLoading=false，正文 `SANDBOX_COLD_REOPEN_SYNTHETIC_NO_MODEL` 可见、模式 WORK。
- 完全重启后通过真实侧栏“A包无模型冷重启”按钮打开，未手动预调用 session.list/prepare 预热。Main 日志无 trusted_session_not_listed / open sandbox failed；未调用模型。metadata 前后 SHA-256 均 `d695884ede9e83b5bbfbd119e4f3067e9e9013a11177a72c3ed1fa744fbb8986`，没有静默改写 ID。
- 截图已实际查看：`D:/CodexTemp/xiaogui-sandbox-reopen-20260907/cold-reopen-pass.png`。同目录 `pi-id-probe.mjs`、`electron-live.log`、`electron-restart.log` 与合成 userData/agent 保留复验，不含原业务内容/模型凭据。

### 必要检查与独立装配

```powershell
node node_modules/vitest/vitest.mjs run src/renderer/src/lib/activate-workspace.test.ts src/renderer/src/lib/__tests__/activate-workspace-switch.test.ts src/renderer/src/lib/subagent-session-navigation.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit
node node_modules/eslint/bin/eslint.js src/renderer/src/lib/activate-workspace.ts src/renderer/src/lib/activate-workspace.test.ts src/renderer/src/lib/__tests__/activate-workspace-switch.test.ts
git diff --check e50b7f8a047cfe50c2f76909bf6a47cfbcb40a2d
```

- 聚焦 `3 files / 18 tests passed`，覆盖延迟 prepare、有效 bound:false、空/空白 ID、错误文件、拒绝、workspace.open 失败、过期导航、两模式保持及既有导航。Node/Web 类型检查、定向 ESLint、diff-check 通过；独立依赖装完后复跑同门记录在 `focused-final.log`。
- 独立 npm ci 首两次遇 registry ECONNRESET；定位锁定 tesseract.js-core 7.0.0 下载后，按 lock SHA-512 核验复用本机旧 tarball 到 D 缓存，最终 `npm ci --ignore-scripts --offline --no-audit --no-fund` 成功（1197 packages）。没有修改锁文件、镜像或源树 node_modules；本树 node_modules realpath 就是本树目录，非链接。
- Electron 43.0.0 复用已缓存下载 ZIP（SHA-256 `a195f798837e4c5719b462d3210c47619f6fc44ce032d06dbdcfbc88327b26e0`），由本树 install.js 安装；本树 electron-builder install-app-deps 成功装配 better-sqlite3。装配命令显式指定 D 盘 npm/Electron/builder/devdir 缓存与 TEMP，原生目标为本树，未重建源树原生模块。
- 真实窗口命令：设置 `PI_CODING_AGENT_DIR=D:/CodexTemp/xiaogui-sandbox-reopen-20260907/agent`，运行 `node node_modules/electron-vite/bin/electron-vite.js dev --remoteDebuggingPort 9351 -- --user-data-dir=D:/CodexTemp/xiaogui-sandbox-reopen-20260907/user-data`；Main/Preload 编译和真实进程冷重启通过。本门使用开发服务器 Renderer，不冒充 B 的构建版寻址/E2E门。

### Standards / Spec 与交付边界

- Standards：独立只读审查 CLEAR，0 finding。
- Spec：最初要求补两模式保持断言，已补齐并独立复核 CLEAR，0 remaining finding。不是协调验收者的最终批准。
- A 提交推送后停在定向复验内部交接点；只有收到协调验收者通过通知才开始 B。B 将从两固定输入和已验 A 提交建立独立集成候选，手动合并开发记录，保持父历史，复用 WORK renderer 修复。
- B 的构建版 Renderer/preload、sandbox startupData 异常、19项 E2E 和新 SHA Quality workflow_dispatch 尚未执行；WORK 仍整体 PARTIAL、Office 默认 OFF、DOC 分析降级等事实不变。未制作新包、未发布、未合主线。两个源工作树 HEAD/clean 与保护 stash `a6ba3bb91fa5fc68aeb42d7f64897e4b1e862c61` 未变。

## 2026-09-07｜C-01 合并前检查与集成准备（检查候选，E2E 阻断未关闭）

### 目标与范围

- 用户已正式验收 C-01 `4a2bdf4d968baca3df381fe8ad22371d59ef55f1`。本轮只补合并检查和集成准备，不再返修日常配置/权限功能，不合主线、不发布。
- Terra 只同步过期测试契约并隔离 E2E profile；生产源码、依赖、权限与工作区架构均未修改。历史“授权中断且缺少工具结果时投影可能误报”的 P2 继续登记，不在本轮修复。
- 实际修改：`e2e/helpers.ts`；`scripts/tests/` 下 `e2e-env.test.mjs`、`ipc-capability-boundaries.test.mjs`、`ipc-schema-validation.test.mjs`、`rewind-navigate-stable.test.mjs`、`session-live-switch-binding.test.mjs`、`worker-load-session-guard.test.mjs`、`worker-pool-config.test.mjs`；本记录。

### 已完成

- 修复测试仍要求旧裸 sessionFile/旧 payload/已删除函数名的问题。断言改为 Main 可信项目登记、会话 binding、明确可见会话身份；保留缺失身份拒绝、prepare 不启动 Worker、非前台会话不抢 foreground 的约束，没有削弱生产门。
- E2E 未显式指定 `--user-data-dir` 时使用独立临时目录；已指定的目录原样保留。测试进程 TEMP/TMP 指向 D 盘，未使用日常 userData，不重跑外部模型。
- 构建的字体同步仅改变工作副本换行，Git 归一后无内容差异，没有提交字体/许可证变更。
- 本次是既有测试对已验收接缝的同步，不新增 Pi/Skill/Extension 或功能。复用现有 Playwright 启动器和 CI 脚本，无第二套测试运行器。

### 固定命令与结果

证据目录 `D:/CodexTemp/xiaogui-c01-premerge-20260907`，日志不提交仓库。

```powershell
$env:TEMP='D:/CodexTemp/xiaogui-c01-premerge-20260907'
$env:TMP=$env:TEMP
npm run lint
node scripts/ci-audit.mjs
npm run build
npm run test:scripts
npm run test:e2e -- --max-failures=3 --output=D:/CodexTemp/xiaogui-c01-premerge-20260907/e2e-results
npm run typecheck
npm exec eslint -- e2e/helpers.ts scripts/tests/e2e-env.test.mjs scripts/tests/ipc-capability-boundaries.test.mjs scripts/tests/ipc-schema-validation.test.mjs scripts/tests/rewind-navigate-stable.test.mjs scripts/tests/session-live-switch-binding.test.mjs scripts/tests/worker-load-session-guard.test.mjs scripts/tests/worker-pool-config.test.mjs
git diff --check 4a2bdf4d968baca3df381fe8ad22371d59ef55f1
```

- 全量 lint：退出 0，0 errors / 1 warning（timeline.tsx 既有 unused eslint-disable），`lint.log`。修改后的八个测试文件定向 ESLint 通过。
- ci-audit：退出 0，无 critical；21 high / 2 moderate 按现有脚本为非阻断，`audit.log`。未执行自动升级或 audit fix。
- 完整 build（Main/Preload/Renderer/Office）：退出 0，`build.log`；Node/Web typecheck 通过。
- test:scripts 原先逐批停在过期断言；每次同步后才继续检查。最终 `96 files / 8 batches / 288 passed / 0 failed`，`scripts-verified.log`。中间失败日志保留便于追溯，不当作最终结果；单独测试门 57/57、9/9、10/10 通过。
- E2E：`19` 项中 `3 failed / 16 did not run`，按 max-failures 停止，`e2e.log` 与 `e2e-results/`。尚未通过，不能继承开发窗口验收的通过标签。

### E2E 阻断与集成接缝

- 实际 CDP 页面加载 `out/main/renderer/index.html`，日志明确 `ERR_FILE_NOT_FOUND`；该路径不存在，构建产物 `out/renderer/index.html` 存在。三个 composer 场景在 launchApp 阶段 60 秒超时，不是模型或授权失败。
- 同一日志还出现 sandbox renderer `binding.startupData` 为 null 的异常；尚未证明它完全由路径错误引起，集成后必须重新观察，不隐去或预先认定已解决。
- 已实查本地 WORK 候选 `92bdc99160cf765f9fb7682f9e77dac62915e50d` 包含 `resolveMainWindowRenderer(app.getAppPath())` 并替换上述 __dirname 寻址。为避免双重实现，本轮没有复制该生产修复；其验收和远端固定点应由 WORK 流程确认后再集成。
- 参考产品集成目标：GitHub `xiaogui/feat/xiaogui-integration@f9f333beb0d29d195ca3f63a30ec1ad887e332a5`；C-01 相对它领先 27 个提交、195 个文件，目标侧独有提交为 0。`origin/main` 是第三方上游，不作为此次自动合并目标。
- 只读预演命令 `git merge-tree --write-tree 4a2bdf4d968baca3df381fe8ad22371d59ef55f1 92bdc99160cf765f9fb7682f9e77dac62915e50d` 退出 0，树为 `b7bbfa0865f683fd04691e3320e83e43335d8671`；仅说明固定两点没有文本冲突，不代表行为验收。未创建 merge commit、集成分支或修改 WORK 工作树。
- GitHub 对 `4a2bdf4` 的 Actions 查询为 0 条；Quality workflow 仅自动监听 main 的 push/PR，并支持手动触发。本地 ci-audit 不等于远程完整 CI，远程 CI 仍未覆盖。

### 下一步与交付边界

- 本轮测试准备提交推送后停止。建议下一门：确认 WORK 已验收且推送的固定 SHA，再获准在独立集成分支整合 C-01 与 WORK；先复跑构建版启动，解决/核实 sandbox 异常后再继续完整 E2E 和对应新 SHA 的 CI。不得直接合主线。
- 原 C-01 功能验收保持通过；本轮合并前门尚未通过，阻断为构建版 E2E/未覆盖远程 CI。安装包、ASAR、Portable、发布仍未执行。
- 日志与失败上下文保留 D 盘；清理测试临时 profile 的命令被工具策略拒绝，未绕过限制，临时目录暂留。保护 stash 不动；知识库只更新既有 progress 记录。

## 2026-09-07｜P2 失败工具展示修复及日常配置补验（阶段候选，待人工复验）

### 目标、修改和决定

- 从 `a60041e3bd7a8a3c34b41547da05d42755f7a696` 追加。Terra 编写最小 Renderer 修复，主 Agent 核对代码、执行真实拒绝及恢复验证；不改 Main、Worker、权限矩阵、Scope、TaskHub 或 OMP。
- 实际修改：`src/renderer/src/features/timeline/` 下 `timeline-turn-activity.ts`、`tool-call-row.tsx`、`tool-previews.tsx` 及 `timeline-turn-activity.test.ts`、`tool-call-row-skill.test.tsx`；`src/renderer/src/locales/en/timeline.json`、`src/renderer/src/locales/zh/timeline.json`；本记录。
- 根因：过去按写入工具名称/参数生成成功变更，没等工具结果。现在单条增删数、折叠摘要、变更卡和预览统一要求 `toolPhase=end && isError!==true`；未完成和错误保留记录，不显示成功 diff。具有同 run/path 的文件事件也核对工具状态，复用既有工作区相对展示路径归一，避免绝对事件路径与相对参数不匹配。
- 同一文件先成功、后拒绝的成功记录保留；没有用“失败”删除全部历史变更。无新增架构/依赖；复用 Pi 0.84.1 已有结果字段与现有 Renderer 汇总接缝。Skill/插件无法替代既有 Renderer 对结果的误读，本轮不新增能力或复测 OMP。

### 聚焦验证

```powershell
npm exec vitest run src/renderer/src/features/timeline/timeline-turn-activity.test.ts src/renderer/src/features/timeline/tool-call-row-skill.test.tsx
npm run typecheck
npm exec eslint -- src/renderer/src/features/timeline/timeline-turn-activity.ts src/renderer/src/features/timeline/timeline-turn-activity.test.ts src/renderer/src/features/timeline/tool-call-row.tsx src/renderer/src/features/timeline/tool-call-row-skill.test.tsx src/renderer/src/features/timeline/tool-previews.tsx
git diff --check a60041e3bd7a8a3c34b41547da05d42755f7a696
node D:/CodexTemp/xiaogui-c01-p2-retest-20260907/verify-scope.cjs
```

- 修复前新增回归 `1 failed / 1 passed`，失败信号为 pending write 被统计进 files；最终 `2 files / 5 passed`，包含 pending/error/缺失 phase、同文件成功后拒绝，以及绝对事件/相对参数匹配。定向 ESLint、Node/Web typecheck、diff-check 通过。
- 使用日常配置的实际 Electron 开发构建：`node node_modules/electron-vite/bin/electron-vite.js dev --remoteDebuggingPort 9345 -- --user-data-dir=D:/AppData/Roaming1/xiaogui-agent-desktop`。启动构建通过；Electron 二进制由共享 node_modules 提供，项目入口/构建/Renderer 均为本隔离工作树。
- 只新增一次真实模型拒绝请求：沿用用户所选 `deepseek/deepseek-v4-flash-vision-exp`，要求创建 `c01-denied-p2.txt`，明确拒绝后不重试。等待授权时无“已编辑”或成功增删数；截图后点拒绝，结果显示 `write 失败`，无该项变更卡。只读 SQLite 显示 `WRITE / SETTLED / USER_OR_POLICY_DENIED`，测前测后文件都不存在。
- 之前成功的 `c01-proof.txt` 写入/回读证据继续有效，内容及 SHA-256 `df986f26f4274f8fecfd873ea426d9801a9b680bc8cfead14f6f3e00937d1a99` 不变；先前拒绝项 `c01-denied.txt` 仍不存在。没有重跑成功模型旅程。

### 旧项目与重启补验

- 本轮私有备份与证据：`D:/CodexTemp/xiaogui-c01-p2-retest-20260907`。Scope 备份 SHA-256 `9de853d8e2505f2f8cc88d48f36679dca3e717fa4657bf5d31cef020366df8a7`。
- 用户通过原生选择框重选日常配置中既有 `9c13edc9` 项目；真实 `session.list → session.open` 返回原会话 `01a03e9f-214a-76c4-b3d9-8261a5f288fd`，模式 `WORK`，未发送模型消息。没有将 WORK 样本改成 CODING。
- 前后深比较：30 个项目、67 个会话全保留；session/sandbox 绑定、projectModeMap/sessionModeMap/projectBaseline 全部不变；仅选中旧项目 null 补录身份，待确认数 `28 → 27`，其余项目不静默授权。核验脚本为上列 `verify-scope.cjs`。
- 经窗口关闭、CDP `Browser.close` 正常结束 Electron（原进程退出，Worker dispose），重新启动并在 UI 选择 5211game 的原测试会话。会话 ID 仍 `01a07b5a-3ae1-76d1-a9d6-2c28f98d07f9`，sessionKey 仍 `xgs1_a712b6d80211e5a0598084d0e9c70ad8b7884a43113edebe45b456763f0cb669`，projectId 仍 `xgp1_08cb0d4edf4d11159278ca3fc17900e403229883fdde5cfee94040f3e8d8c3b1`，模式 CODING；成功和失败历史均正确显示。重启没有再次调用模型。
- 真实截图：`permission-pending-fixed.png`（完整来源字段及等待状态）、`denial-fixed.png`、`history-fixed.png`、`restart-session.png`。证据保留本机，不提交原始历史会话截图/配置到 GitHub。

### 未完成、偏差、风险和下一步

- 本轮已补齐上轮记录的 P2 展示问题、日常旧项目重选和 CODING 会话重启恢复证据；最终结论仍待人工复验，不自行宣布整体验收通过。
- 不扩展旧 WSL 迁移、Main 权限、完整 AUTO、OMP 或新 UI 功能；等待阶段使用既有“正在运行”文案，不声称修改成功。此处统计仍依赖工具成功事件，不代表对任意第三方工具副作用的独立磁盘审计。
- 不跑全量测试/OMP/Portable。全量 lint、test:scripts、E2E、CI audit、安装包/ASAR 仍是后续合并/发布门。追加提交推送本隔离分支后停止，保护 stash 不动，不合入 WORK、阶段线或主线。

## 2026-09-07｜WORK 单机保存与自然语言文档闭环（阶段候选，待人工验收）

- 共同基线 `a60041e3bd7a8a3c34b41547da05d42755f7a696`；隔离分支 `codex/work-document-stability-v1`，固定实现 `2817547bff293b44574fd5d064dcb3abef01f8eb`。原候选的 Timeline 修改与主线均未触碰。文档收尾提交不改变已测构建内容。
- WORK：Gateway 保存排队并在持久化成功后提交内存版本；失败可重试、同版本竞争至多一个成功，Supervisor 等待子进程退出后释放路径所有权，Viewer 保留失败及保存期间的新编辑。5 文件 / 15 项聚焦验证通过；真实 Univer 工作副本修改、保存、关闭重开通过。
- 共享能力：按模式/执行阶段/授权装配 WORK 工具，正常措辞不再隐藏文档工具；仍沿用 Pi 原生 Skill 与 setActiveToolsByName。保留 CODING 边界及 Host 确认；“继续”未触发正式写入，明确“确认”后才另存。
- 真实缺陷修复：构建版 Renderer 路径 `92bdc99`；intake WHOLE_FRAGMENT 字段说明和 repair 原文上下文 `e068a2c`；缺少 suggestedName 的精确反馈 `df24b49`；SELECT_TEMPLATE 将 Host 的真实 fieldId 映射放入模型可读 content `2817547`。没有新增工具、中央路由或宽松校验。
- 真实模型证据：合成 DOCX→只读整理报告→实际字段复核/预览确认→正式模板落库→按模板成品→系统 Word 打开修改、保存与关闭重开。固定版本增量对应的调用与输出 SHA 已记录。PDF 只读报告与伪 PDF 格式拒绝通过，没有进入模板物化。
- 根启动补齐 Office 构建；独立 npm ci、不复用 junction 或历史 Office 输出；类型检查与构建通过。打包配置 `ac16d934346d614c6166d6b6d539600e30a15b9a` 补齐显式 GitHub 仓库，最终 Windows 打包退出 0；NSIS 安装及最终替换均退出 0。新安装配置的随包 Skill、Office 保存重开、模板落库、Word 生成及系统 Word 编辑重开通过。asar 与业务冻结版本逐字节相同，最终替换后又复核更新配置、资源与冷启动。
- 完整功能验收仍为 PARTIAL：安装版 DOC 转换/只读报告成功，但出现一次 MODEL_OUTPUT_INVALID 安全降级，具体原因未稳定复现，不将单独探针成功替代失败记录。Portable 生成但未单独运行，人工验收与发布均未通过。安装器与 Portable 大小/摘要、实测配置和产物摘要见统一交接。
- 保留边界：Office 仍需既有单机试验模式，未修改默认 OFF；Sandbox 冷启动 trusted_session_not_listed 交 CODING 统一处理，未放松 Main gate。模型事实性表述、内部字段编号复述、Univer 合成表格宽度提示列为已知体验限制，不声称全部产品验收通过。
- 交接与逐门证据见 `doc/WORK-REMEDIATION-HANDOFF-2026-09-06.md`、`doc/WORK-SAVE-EVIDENCE-2026-09-07.md`、`doc/WORK-CAPABILITY-EVIDENCE-2026-09-07.md`。未进入主线、未晋级或发布；人工批准后再处理集成。

## 2026-09-07｜日常配置 C-01 真实旅程（未通过完整门，停止待审）

- 前置候选 `8cf17ec5885d9f1c72e1670722ee5cbead7d855c` 已获人工定向批准；本次只做验收，不修改源码。启动前 SHA/远端一致、工作树干净、保护 stash 为 `a6ba3bb91fa5fc68aeb42d7f64897e4b1e862c61`。
- 使用真实日常 userData `D:/AppData/Roaming1/xiaogui-agent-desktop`，不是空配置；三个配置 JSON 已备份至 `D:/CodexTemp/xiaogui-c01-daily-profile-20260907/backup`。Scope 备份 SHA-256：`f57ed2f48c8d565ac2aefafbf911c6e57097a797fa9f33fc642e852c8a13b31a`。
- 必要启动构建通过：`node node_modules/electron-vite/bin/electron-vite.js dev --remoteDebuggingPort 9343 -- --user-data-dir=D:/AppData/Roaming1/xiaogui-agent-desktop`。用户原生选择项目 `5211game`，手动选择统一模型 `deepseek/deepseek-v4-flash-vision-exp`，界面 CODING、逐条确认。
- 用户批准首轮写入；真实审计 WRITE、READ 均 `SETTLED / TOOL_SETTLED / is_error=0`。`c01-proof.txt` 测前不存在，现内容严格为 `C01_EXISTING_PROFILE_PASS`，SHA-256 `df986f26f4274f8fecfd873ea426d9801a9b680bc8cfead14f6f3e00937d1a99`。不把用户点击误判为权限绕过。
- 为补拒绝证据，另发一次只写 `c01-denied.txt` 的模型任务，明确拒绝后不重试。测前文件不存在；截图后通过真实 UI 点击“拒绝”，审计 `WRITE / SETTLED / USER_OR_POLICY_DENIED`，测后仍不存在。
- 权限截图 `permission-deny.png` 已实际查看：来源项目、来源对话、写入动作、相对路径、“允许一次／拒绝”齐全；`after-denial.png` 留存拒绝后界面。均位于上述 D 盘证据目录，不提交历史对话截图到仓库。

### 新发现与未覆盖项

1. 拒绝后的界面仍显示“编辑了 c01-denied.txt”“1 个文件已更改”和该文件的 `+1/-1`，与磁盘不存在、审计拒绝不一致。仅确定真实 UI 现象，尚未诊断具体消费者；不可将其称为真实 Diff。按约定停止旅程，不现场修代码，建议单独交 Terra 最小诊断/修复。
2. 配置对比证明原 29 项 project、66 项 session 全部逐项不变，无删除；新增后为 30/67，null 仍 28。所选项目实际上是新登记，未完成既有待确认项目的原生重选恢复门；不能用此前配置副本 WORK 样本替代本轮日常配置证据。
3. 因遇到上述界面问题停止，未执行重启恢复，不再调用模型。完整日常配置旅程仍待验收；不合主线、不发布。

### 验证、交付与下一步

- 本轮没有源码变化，不重跑 38 项单测、typecheck、全量 lint、E2E、OMP、Portable。实际修改仅本记录；同步既有 Obsidian `progress.md`，不创建分散研究稿。
- 可重核文件：`Test-Path D:/5211game/c01-denied.txt`（False）；`Get-FileHash D:/5211game/c01-proof.txt -Algorithm SHA256`。UI 来源通过 `agent-browser --session c01-daily connect 9343`、`tab t1`、`screenshot` 取得；SQLite 以 Node `DatabaseSync(...,{readOnly:true})` 查询 `xiaogui_direct_coding_calls_v2` 的 operation/relative_path/state/reason_code/is_error，未改审计。
- 文档门：`git diff --check 8cf17ec5885d9f1c72e1670722ee5cbead7d855c..HEAD`。追加记录提交并推送后停止，等待人工决定 UI 问题的最小处理范围；全量合并与发布门仍未完成。

## 2026-09-07｜既有 Scope 身份待确认兼容修复（阶段候选，待人工复验）

### 目标、范围和实际修改文件

- 基线：`512aa5ae472fdc211fad47034e3d46cd693b37d1`；保留其 preload 修复和干净配置 C-01 条件通过结论。
- 仅修改 `src/main/xiaogui/scope-store.ts`、`src/main/xiaogui/scope-store.test.ts` 和本记录。Terra 负责代码及测试，主 Agent 负责真实配置副本验证和交付。
- 根因是 V1 缺失摘要被转换成 V2 `null` 后，再读被误判损坏；且 pending lookup 抛错阻断了可信目录重选后的既有提交路径。

### 已完成及安全边界

- 仅将 V1 缺失摘要、V2 显式 `null` 识别为待确认状态；非字符串、非法摘要、V2 缺失值、孤立绑定仍拒绝。
- 待确认查询先核验项目及会话指纹，再返回 `NOT_FOUND`，不写入、不签发授权；通过现有 Main 可信打开和实测身份的提交路径补录摘要，保留原模式。
- 聚焦回归覆盖 V1/V2 往返、多个待确认项目连续补录、CODING/DESIGN 模式保留、查询无写入、指纹伪造和非法摘要拒绝。未改变权限、Worker、TaskHub 或模型配置。
- 复用调查：既有 `scope-store`、`scope-resolver` 和原生可信目录登记直接拥有本次持久化契约。Pi 0.84.1 的 SessionManager/ResourceLoader、Skill 或 Extension 不拥有 Main 的 canonicalScopeBindings 迁移入口；本次修复既有校验分支，不引入新插件、依赖或框架接缝，不复测成熟 OMP 能力。

### 可复现验证命令与结果

在本工作树执行：

```powershell
npm exec vitest run src/main/xiaogui/scope-store.test.ts src/main/xiaogui/scope-resolver.test.ts
npm run typecheck
npm exec eslint -- src/main/xiaogui/scope-store.ts src/main/xiaogui/scope-store.test.ts
git diff --check 512aa5ae472fdc211fad47034e3d46cd693b37d1
node D:/CodexTemp/xiaogui-scope-null-compat-20260907-1600/verify-copy.cjs
```

- 聚焦测试 `2 files / 38 passed`；Node/Web typecheck、两文件 ESLint 通过。
- 真实旧配置先备份，再复制至隔离 userData；原文件与备份 SHA-256 均为 `f57ed2f48c8d565ac2aefafbf911c6e57097a797fa9f33fc642e852c8a13b31a`。原配置没有修改。
- 本轮 Electron 开发构建启动命令：`node node_modules/electron-vite/bin/electron-vite.js dev --remoteDebuggingPort 9341 -- --user-data-dir=D:\CodexTemp\xiaogui-scope-null-compat-20260907-1600\profile`。
- 通过真实原生目录选择框重新确认一个既有项目，然后在真实 preload IPC 上执行 `session.list` 和 `session.open`：列表返回 1 个 WORK 会话，打开返回 `opened=true, mode=WORK`；没有发送消息或调用模型。
- 副本验证：项目 `29`、会话 `66` 均保留；空摘要 `28 → 27`，仅选中项目的摘要改变。所有 session/sandbox 绑定、projectModeMap、sessionModeMap、projectBaseline 均与备份深比较一致。其余项目保持待确认，不静默授权。
- 私有证据及核验脚本位于 `D:\CodexTemp\xiaogui-scope-null-compat-20260907-1600`，不提交配置或路径清单。截图命令因连接超时未产出；本次证据是实际原生选择、真实 Handler 返回及磁盘前后对比，不宣称截图验收。

### 未完成、风险、偏差和下一步

- 本次未重跑外部模型、完整 C-01、OMP、802 MB 装配、Portable 或全量测试；历史真实样本保留的是 WORK 模式，CODING/DESIGN 保留由聚焦测试覆盖。
- 前一记录将既有配置称为“损坏”不够准确：本次证明是可识别的旧迁移待确认状态；不代表所有损坏配置均可自动修复。用户原配置仍需使用修复版本经原生目录重选确认。
- 无新增产品/架构决策；仅修复既有契约的升级兼容。全量 lint、test:scripts、E2E、CI audit 仍是合并前未完成门；安装包/ASAR 和权限弹窗完整截图证据仍未补验。
- 追加提交并推送隔离分支后停止，等待本兼容包定向人工复验；不合入 WORK、阶段线或主线，不处理保护 stash。

## 2026-09-07｜Electron preload 稳定寻址与 C-01 Windows Host 真实旅程（阶段候选，待人工复验）

### 本阶段目标

只修复 Electron Main 被 Rollup 拆分到 `out/main/chunks` 后错误寻址 preload 的问题，恢复 `window.piDesktop` IPC 桥。IPC 恢复后继续执行 C-01 的 Windows Host 真实模型＋Electron 验收；不修改 WORK、Prompt Matrix、权限矩阵、TaskHub、OMP、模型配置、UI 产品逻辑或其他功能。

### 实际修改文件

- `src/main/utility-entry-path.ts`
- `src/main/window.ts`
- `src/main/__tests__/utility-entry-path.test.ts`
- `src/main/__tests__/utility-entry-build-smoke.test.ts`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 新增 `resolveMainWindowPreload()`，以 Electron `app.getAppPath()` 为稳定锚点解析 `out/preload/index.cjs`；同时兼容测试或工具传入已构建 `out/main` 目录的情况。
2. 主窗口不再使用拆分 chunk 的 `__dirname` 推导 preload。修复前该表达式会落到不存在的 `out/main/preload/index.cjs`；修复后始终落到实际构建产物 `out/preload/index.cjs`。
3. 路径单测覆盖应用根与 `out/main` 两种输入，并明确拒绝旧的重复 `out/main/preload` 形状；构建冒烟同时核验 Main utility entry 和 preload 产物存在。
4. 真实 Electron 开发窗口中确认 `window.piDesktop` 为对象并暴露 `15` 个桥接方法；“打开文件夹”能弹出原生“选择项目目录”窗口并将测试项目登记到 CODING。
5. 在独立干净 Electron userData 下完成 C-01 真实旅程：选择 `k3-256k`，模型真实发起 `write`；“逐条确认”弹窗显示来源项目 `xiaogui-c01-electron-acceptance-20260907-125543`、来源对话 `01a07a55` 和相对目标 `c01-proof.txt`；只批准“允许一次”后，Pi 实际写入并继续调用 `read` 回读。
6. 最终文件长度 `37` 字节，去除允许的末尾换行后内容严格等于 `C01_REAL_MODEL_ELECTRON_PASS_20260907`，SHA-256 为 `0e98842c03ec49051592c7986b92360c0249b3f631832cb8bffb8d1f47db3386`。界面最终答复也明确报告写入与回读一致。
7. 前两次未在约 `55` 秒内完成授权，系统均以 `USER_OR_POLICY_DENIED` 安全拒绝且没有创建文件；第三次测试自动化只在来源项目、写入动作和 `c01-proof.txt` 三项完全匹配时点击“允许一次”。该自动化只用于本次验收，不进入产品代码。

### 未完成内容

- 当前用户既有 Electron 配置中的 `canonicalScopeBindings` 数据会触发 `CANONICAL_SCOPE_STORE_CORRUPT`；常规配置下的首次旅程在模型启动前安全停止。本阶段按用户边界没有修复、清理或迁移该既有持久化状态，真实 C-01 通过证据来自全新隔离 userData。
- 未运行 Portable、打包安装版或无关全量测试；未合入 WORK、阶段线或主线，未发布。
- 当前结论仍是隔离分支阶段候选，等待人工复验；不能把干净配置旅程扩大表述为所有历史本机配置均已恢复。

### 与规格文档存在的偏差

- preload 修复没有改变任何冻结产品或架构决策，也没有引入新启动模式、配置面或依赖。
- C-01 的干净配置 Windows Host 真实模型＋Electron 主链已通过；既有配置损坏属于本阶段之外的独立已知缺口，已如实登记，没有在本提交中扩大修复范围。

### Pi／Skill／插件复用调查

- 本次缺口属于 Electron 构建产物的 preload 路径寻址，Pi、Skill 或插件不拥有 BrowserWindow preload 装载能力，不能替代该框架接缝。
- 实现复用仓库既有 `utility-entry-path.ts` 作为统一路径模块，并使用 Electron 原生 `app.getAppPath()`；没有新增依赖、Skill、插件、运行时或平行路径系统。

### 测试命令和测试结果

~~~powershell
npm exec vitest run src/main/__tests__/utility-entry-path.test.ts src/main/__tests__/utility-entry-build-smoke.test.ts
npm run typecheck
npm exec eslint -- src/main/utility-entry-path.ts src/main/window.ts src/main/__tests__/utility-entry-path.test.ts src/main/__tests__/utility-entry-build-smoke.test.ts
node node_modules/electron-vite/bin/electron-vite.js build
npm exec vitest run src/main/__tests__/utility-entry-build-smoke.test.ts
git diff --check

# Windows Host 真实模型＋Electron（隔离 userData，仅用于验收）
node node_modules/electron-vite/bin/electron-vite.js dev --remoteDebuggingPort 9337 -- --user-data-dir=D:\CodexTemp\xiaogui-c01-electron-acceptance-20260907-125543\_isolated-profile\Chromium2
~~~

- 聚焦测试：`2 files / 4 tests passed`；构建完成后单独复跑构建冒烟：`1/1 passed`。
- Node/Web typecheck：通过。
- 四个变更 TS 文件定向 ESLint：通过。
- Electron Main、Preload、Renderer 构建：通过；仅保留仓库既有动态导入提示。
- `git diff --check`：通过。
- 真实窗口：preload IPC 桥可用，原生目录选择可用；真实 `k3-256k` 完成 `write → 允许一次 → read`，磁盘文件内容和 SHA-256 核验通过。
- 截图证据：`D:\CodexTemp\xiaogui-c01-electron-acceptance-20260907-125543\_evidence\c01-real-model-electron-pass.png`（不提交仓库）。测试产物位于同一 D 盘临时项目，不影响用户项目。
- 按范围未运行 OMP、802 MB 装配、Portable 或无关全量测试。

### 已知风险

1. 既有用户配置的 canonical scope 持久化损坏仍会阻止新会话；它与 preload 寻址无关，但会影响该具体本机配置继续试用，需要另行授权后才能修复或迁移。
2. 本轮真实旅程使用 Electron 开发构建和隔离 userData，尚未覆盖安装包或 Portable 的路径布局。
3. 权限弹窗有超时语义；本轮已证明超时安全拒绝和精确“允许一次”均按预期工作。

### 下一阶段计划

- 只追加一个提交并推送当前隔离分支，随后立即停止，等待人工复验。
- 未获人工批准前不合入 WORK、阶段线或主线，不处理既有配置损坏，不进入发布或其他功能开发。

## 2026-09-06｜CODING-C-01 默认工作区能力（测试契约返修候选，待定向复验）

### 本阶段目标

只让既有 `coding.workspace` 成为 CODING 的默认 Capability，使普通 CODING 在每个 EXECUTE 回合都向 Pi Provider 暴露真实 `read/bash/edit/write` active tools，不再依赖用户输入命中代码关键词。保持 ASK／PLAN 阶段门、Main 权限、普通 CODING 直接写入、TaskHub Attempt、WORK、WSL、检查点、UI、OMP 和统一模型配置不变。

### 实际修改文件

- 生产事实源：`packages/shared/xiaogui-prompt-matrix.ts`、`packages/shared/xiaogui-prompt-capabilities.ts`
- 契约与默认上下文回归：`packages/shared/xiaogui-prompt-matrix.test.ts`、`packages/shared/xiaogui-prompt-capabilities.test.ts`、`src/main/xiaogui/prompt-context.test.ts`、`src/worker/xiaogui-prompt/behavior-fixtures.test.ts`
- 真实回合／工具生命周期回归：`src/worker/handlers/worker-handlers-turn.test.ts`、`src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.test.ts`
- 阶段记录：`DEVELOPMENT_STATUS.md` 及既有 Obsidian 总控、进度和 CODING 研究记录

### 已完成内容

1. Prompt Matrix `1.1.0` 将 `coding.workspace` 在 CODING 中由 `ALLOWED` 改为 `DEFAULT`，并将其加入既有 `XIAOGUI_DEFAULT_CAPABILITIES_BY_MODE_V1.CODING`；没有新增能力表、选择器或 Runtime。
2. Main 创建 CODING Prompt Context 时直接携带 `coding.workspace`。Worker 每回合的既有选择器也会从同一 Matrix 得到 `MODE_DEFAULT`，因此中性表达不再让能力掉回 `NO_MATCH`。
3. EXECUTE 的 Provider-facing active tools 固定为已注册集合与既有阶段／角色策略的交集；在当前 Pi 核心工具全集下为 `bash/edit/read/write`。ASK 仍只有 `read`，PLAN 仍只允许 `read` 和既有计划工具，写入与命令仍经过原 Main 权限链。
4. 使用此前真实失败表达“做一个单文件 HTML 贪吃蛇，直接写到项目中”验证：默认选择得到 `coding.workspace`，四个工具真实激活，随后真实 `tool_call` 进入既有 Direct Coding preflight／begin／settle 生命周期并由 Pi `write` 写入临时项目；无外部模型。
5. 首次定向复验发现既有 P08 跨模式行为夹具仍保留 C-01 前的断言。本次只同步该契约：`MODE_BLOCKED` 继续保留，`work.template-intake` 继续不激活，同时默认 `coding.workspace` 和 `bash/edit/read/write` 不再消失；另将错误描述 CODING 的 WORK 测试标题改回其真实语义。生产文件未再修改。

### 未完成内容

- 尚未运行 Windows Host 外部模型＋Electron 人工旅程；本轮自动证据只证明真实 Pi 工具生命周期和文件写入，不证明模型一定选择工具或 UI 交互已经通过。
- 当前仍为隔离分支阶段候选，未合入 WORK、阶段线或主线。

### 与规格文档存在的偏差

- 无。C-01 只调整已冻结 Prompt Matrix 的 CODING 默认策略；没有改变 ASK／PLAN、授权、检查点、TaskHub 或其他一级模式的产品语义。

### Pi／Skill／插件复用调查

- 当前锁定的 `@earendil-works/pi-coding-agent@0.84.1` 原生提供 `read/bash/edit/write`、`getAllTools()`、`setActiveToolsByName()` 和真实 Extension `tool_call` 生命周期，已满足 C-01；本轮直接复用这些接口及既有小规 Direct Coding Extension。
- 缺口只在小规既有 Prompt Matrix 把 `coding.workspace` 标为非默认，Skill 或第三方插件无法在 Provider schema 冻结前可靠补回被隐藏的 Host Tools。Pi 原生已经满足后即停止候选链，不新增 Skill、插件、依赖或框架。

### 测试命令和测试结果

~~~powershell
# TDD 红灯与单文件绿灯
npm exec vitest run src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.test.ts

# 最终聚焦门
npm exec vitest run packages/shared/xiaogui-prompt-matrix.test.ts packages/shared/xiaogui-prompt-capabilities.test.ts src/main/xiaogui/prompt-context.test.ts src/worker/handlers/worker-handlers-turn.test.ts src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.test.ts

# 首次定向复验后的测试契约返修门
npm exec vitest run packages/shared/xiaogui-prompt-matrix.test.ts packages/shared/xiaogui-prompt-capabilities.test.ts src/main/xiaogui/prompt-context.test.ts src/worker/handlers/worker-handlers-turn.test.ts src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.test.ts src/worker/xiaogui-prompt/behavior-fixtures.test.ts
npm run typecheck
$changedTs = @(git diff --name-only --diff-filter=ACMR) | Where-Object { $_ -match '\.(ts|tsx)$' } | Sort-Object -Unique
npm exec eslint -- $changedTs
git diff --check
~~~

- 红灯：`1 file / 1 failed / 18 passed`；真实失败表达被选为 `NO_MATCH`，实际 `capabilityIds=[]`。
- 最小 Matrix 修改后单文件 `19/19 passed`；最终聚焦门 `5 files / 87 tests passed`。
- 首次定向复验单跑遗漏的行为夹具得到 `1 failed / 15 passed`；只修正测试断言和测试标题后，规定的返修门为 `6 files / 103 tests passed`。
- Node/Web typecheck、两处返修测试文件定向 ESLint及 `git diff --check` 通过。
- 按范围未运行 TaskHub 回归、WORK 回归、外部模型、Electron、OMP、802 MB 装配、Portable 或无关全量测试。

### 已知风险

1. 自动测试没有调用外部模型，因此只能证明 Provider 每轮可见工具及真实 Pi 工具调用链；自然语言模型是否发起预期 `tool_call` 留给下一道人工门。
2. C-01 让 CODING/EXECUTE 始终暴露四个工作区工具，但 Bash、写入和删除的权限与恢复风险没有放宽，继续受 R3.3 已有硬门约束。

### 下一阶段计划

- 完成唯一追加提交并推送当前隔离分支后立即停止，等待一次 C-01 定向代码复验。
- 只有定向复验通过，才进入 Windows Host 真实模型＋Electron 人工验收；此前不合入 WORK、阶段线或主线。

## 2026-09-06｜CODING-P1D-B-R3.3-CLOSEOUT TaskHub 旧 ProjectId 定向兼容（阶段候选，待人工复验）

### 本阶段目标

按用户最新边界，只修复 TaskHub 既有 Attempt 所持旧版全小写 WSL `projectId` 的唯一项目兼容解析及碰撞拒绝。撤回上一候选 `46ab7015a866fe72c7433cc952e654235f998534` 中超出该边界的 WSL 会话／Scope 迁移及新增架构说明；不改写历史，不修改普通 CODING、WORK、TaskHub 状态机、权限矩阵、UI 或 OMP。

### 实际修改文件

- 唯一生产修改：`src/main/xiaogui/task-hub/project-workspace-resolver.ts`
- 唯一行为回归：`src/main/xiaogui/task-hub/project-workspace-resolver.test.ts`
- 阶段记录：`DEVELOPMENT_STATUS.md`
- 范围纠偏：`46ab701` 中对 `path-key`、Scope Resolver／Store、中英文 README 和架构说明的改动全部恢复为 `2b599a8640e31f28f99ee42c900863e1c9f5120b` 状态；这些文件没有形成新的净功能差异。

### 已完成内容

1. TaskHub 项目工作区解析器仍先使用当前 `normalizePathKey` 生成当前 ProjectId；仅对规范化后的 WSL UNC 候选额外计算旧版全小写 key，并将其作为旧 Attempt ProjectId 的兼容别名。
2. 兼容别名只参与候选匹配。最终返回值仍来自 `realpath`，旧小写 key 不会成为执行 cwd，也不会改写 Attempt、Scope 或任何持久化记录。
3. 旧 ProjectId 只匹配一个真实根时正常恢复；匹配两个不同真实根时沿用现有 `PROJECT_AMBIGUOUS` fail-closed 语义，不猜测归属。
4. `46ab701` 的 WSL 会话迁移、canonical V3 migration ledger、Scope 错误码和架构扩展均已撤回。

### 未完成内容

- WSL 会话／Scope 历史身份迁移明确不做；本阶段也不新增相关架构。
- 外部模型与 Electron 用户旅程仍未运行，等待本次定向复验通过后再进入该人工验收门。
- 当前仍为隔离分支阶段候选，未合入 WORK、阶段线或主线。

### 与规格文档存在的偏差

- 无新增产品或架构偏差。实现局限在既有 `ProjectWorkspaceResolverV1` Adapter 内，没有新增契约、存储或迁移 Module。
- 上一候选 `46ab701` 超出用户最新边界，本提交通过追加纠偏撤销；历史提交保留，不改写 Git 历史。

### Pi／Skill／插件复用调查

- 本次是小规 TaskHub 自有 opaque ProjectId 的向后兼容解析，Pi、Skill 和插件不持有该 ID，也不能替代既有 `ProjectWorkspaceResolverV1`。因此只在原 Adapter 内增加最小兼容分支，不引入依赖或框架。

### 测试命令和测试结果

~~~powershell
# TDD 红灯与绿灯均使用同一唯一行为测试
npm exec vitest run src/main/xiaogui/task-hub/project-workspace-resolver.test.ts

npm run typecheck
$changedTs = @((git diff --name-only --diff-filter=ACMR 46ab7015a866fe72c7433cc952e654235f998534 HEAD); (git diff --name-only --diff-filter=ACMR); (git ls-files --others --exclude-standard)) | Where-Object { $_ -match '\.(ts|tsx)$' } | Sort-Object -Unique
npm exec eslint -- $changedTs
git diff --check 46ab7015a866fe72c7433cc952e654235f998534 HEAD
~~~

TDD 红灯为 `1 file / 2 failed / 6 passed`：旧 ProjectId 返回 `PROJECT_NOT_FOUND`，碰撞也未进入 `PROJECT_AMBIGUOUS`。最小实现后为 `1 file / 8 passed`。不运行 WSL 会话／Scope、OMP、802 MB 装配、外部模型、Electron、Portable 或无关全量测试。

### 已知风险

1. 旧版全小写 WSL ProjectId 天然丢失路径主体大小写；存在两个真实候选时只能安全停止，不能自动判断用户原意。
2. 该兼容解析依赖当前／最近项目候选仍包含旧 Attempt 对应项目；候选缺失时继续返回 `PROJECT_NOT_FOUND`，不会扩大磁盘搜索范围。

### 下一阶段计划

- 完成定向验证、追加提交和推送后立即停止，等待一次定向人工复验。
- 仅当该复验通过，才进入 Windows Host 真实模型＋Electron 人工验收；此前不得合入 WORK、阶段线或主线。

## 2026-09-06｜CODING-P1D-B-R3.3-CLOSEOUT 路径全消费者与多级子会话收口（阶段候选，待人工复验）

### 本阶段目标

只整改 `d795bde501124c974ce77a9b97d25e3318fd670b` 人工复验确认的三个遗漏消费者：恢复普通 CODING 的 DirectCodingModuleV2 真实执行链；让 WSL 混合大小写项目完成 `session.new` Scope 注册；让已验证的嵌套子 Agent 会话在顶层列表刷新后继续作为下一层子会话的可信父项。普通 CODING、TaskHub、WORK、权限矩阵、UI、OMP 和统一模型配置均不改变。

### 实际修改文件

- 执行路径与比较键：`src/main/project-root-identity.ts`、`src/main/xiaogui/path-key.ts`、`src/main/xiaogui/scope-resolver.ts`、`src/main/xiaogui/coding-extensions/direct-coding-module.ts`、`src/renderer/src/lib/session-file-key.ts`
- 多级子会话信任链：`src/main/trusted-session-access.ts`
- 聚焦回归：`src/main/xiaogui/scope-resolver.test.ts`、`src/main/xiaogui/path-key.test.ts`、`src/main/xiaogui/scope-derive.test.ts`、`src/renderer/src/lib/__tests__/session-file-key.test.ts`、`src/main/ipc/handlers/trusted-open-handler-chain.test.ts`、`src/main/__tests__/trusted-worker-seam-architecture.test.ts`
- 阶段记录：`DEVELOPMENT_STATUS.md`、`doc/README.md`、`doc/README.zh-CN.md`、`doc/architecture/xiaogui-oh-my-pi-acp-runtime.md`，以及既有 Obsidian 总控、进度和 CODING 研究记录

### 已完成内容

1. `DirectCodingModuleV2` 删除本地旧 `pathKey`，目录归属继续使用真实执行路径，项目身份相等判断统一使用 `projectRootComparisonKeyV2`。人工复验发现的已有文件、新文件、Bash、未知结果和检查点恢复六项失败已恢复。
2. `SessionScopeResolverV1` 明确分离 `execution` 与 `comparison`：目录实体核验和返回给会话的 cwd 使用保留真实大小写的执行路径；Opaque ID、旧模式查找和相等判断只使用比较键。比较键不会再反向进入 `readProjectRootIdentityV2`。
3. Main 与 Renderer 的会话路径键同步支持 WSL UNC：只统一 `wsl.localhost/wsl$` 和发行版选择器，Linux 路径主体保留大小写；普通 Windows 盘符和 UNC 的既有大小写不敏感语义不变。
4. 顶层 SessionManager 列表刷新时，只保留能从本次新鲜顶层列表逐边重新验证的派生后代。每一层都重新核对项目身份、JSONL 元数据、`realpath` 和父项固定私有产物树；孤立、过期或结构不合法的派生证据自动丢弃，不会因为历史记录获得能力。
5. 新增架构门，防止 Scope 再用比较键核验实体，也防止 DirectCodingModule 再引入局部 `pathKey`。新增两级子会话真实 Handler `prepare → open` 回归及真实 WSL 混合大小写 Scope 回归。

### 未完成内容

- 尚未运行外部模型或 Electron 人工旅程；自动证据不能替代真实用户界面验收。
- 当前仍是独立 CODING 分支阶段候选，未合入 WORK、阶段线或主线，未发布、未制作 Portable。

### 与规格文档存在的偏差

- 无新增产品或架构偏差。本轮只原子迁移 `canonicalRoot` 的遗漏生产消费者并修复多级合法会话，不降低 Main 唯一权威，不恢复 Renderer／JSONL 自证，不改变 List/Preview 不签发能力、TaskHub V1 或 OMP 边界。
- `d795bde` 的阶段记录曾将“一层嵌套通过”和“项目登记保留大小写”误述为完整链路通过；本记录明确更正为必须同时覆盖 DirectCodingModuleV2、真实 WSL Scope 和两级 Handler 链。

### 测试命令和测试结果

~~~powershell
npm exec vitest run src/main/xiaogui/coding-extensions/direct-coding-module.test.ts
npm exec vitest run src/main/xiaogui/scope-resolver.test.ts src/main/xiaogui/path-key.test.ts src/renderer/src/lib/__tests__/session-file-key.test.ts
npm exec vitest run src/main/ipc/handlers/trusted-open-handler-chain.test.ts
npm exec vitest run src/main/xiaogui/coding-extensions/direct-coding-module.test.ts src/main/xiaogui/scope-resolver.test.ts src/main/xiaogui/path-key.test.ts src/main/xiaogui/scope-derive.test.ts src/main/trusted-session-access.test.ts src/main/trusted-project-registration.test.ts src/main/session-prepare.test.ts src/main/ipc/handlers/trusted-open-handler-chain.test.ts src/main/__tests__/trusted-worker-seam-architecture.test.ts src/renderer/src/lib/__tests__/session-file-key.test.ts src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.test.ts src/worker/worker-path-bridge-direct-coding.test.ts
npm exec vitest run src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.test.ts src/worker/worker-path-bridge-direct-coding.test.ts src/worker/handlers/worker-runtime-tool-registry.test.ts src/main/ipc/handlers/prompt-trusted-session.test.ts src/main/ipc/handlers/trusted-open-handler-chain.test.ts src/main/__tests__/worker-manager-session-isolation.test.ts
npm exec vitest run src/main/xiaogui/task-hub/attempt-workspace.test.ts src/main/xiaogui/task-hub/change-apply.test.ts src/main/xiaogui/coding-extensions/checkpoint-module.test.ts src/main/xiaogui/coding-extensions/permission-module.test.ts
npm exec vitest run src/main/xiaogui/scope-derive.test.ts src/main/__tests__/trusted-worker-seam-architecture.test.ts
npm run typecheck
$changedTs = @(git diff --name-only --diff-filter=ACMR d795bde501124c974ce77a9b97d25e3318fd670b 2b599a8640e31f28f99ee42c900863e1c9f5120b) | Where-Object { $_ -match '\.(ts|tsx)$' } | Sort-Object -Unique
npm exec eslint -- $changedTs
git diff --check d795bde501124c974ce77a9b97d25e3318fd670b 2b599a8640e31f28f99ee42c900863e1c9f5120b
~~~

TDD 红灯分别为：DirectCodingModuleV2 `6 failed / 4 passed`；真实 WSL Scope `1 failed / 12 passed`，错误为 `PROJECT_ROOT_MISSING`；两级子会话 Handler `1 failed / 2 passed`，错误为 `trusted_session_not_listed`。修复后 DirectCodingModuleV2 `10/10`、WSL/路径键 `3 files / 26 tests`、两级 Handler `3/3`、TaskHub V1 `4 files / 45 tests`、架构与 Scope ID `2 files / 12 tests` 通过。原 `12 files / 89 tests` 和 Worker/Handler `6 files / 83 tests` 使用占位命令，无法从记录复现，现已撤销这两个分组数字的证据资格并补全可执行文件清单。Node/Web typecheck、固定 `d795bde5..2b599a86` 的 `12` 个变更 TS/TSX 文件定向 ESLint及差异检查通过。

按范围未运行 OMP、802 MB 装配、外部模型、Electron、Portable 或无关全量测试。

### 已知风险

1. 标准嵌套目录仍绑定 Pi 0.84.1 当前的 `parent/run-id/run-N/session.jsonl` 结构；上游布局变化时会安全拒绝，需要先更新契约和回归。
2. WSL 自动回归依赖本机存在可访问发行版；本轮测试实际执行而非跳过，但其他无 WSL 环境会跳过该单条平台用例。
3. 没有外部模型和 Electron 证据，不能把本阶段表述为完整用户验收。

### 下一阶段计划

- 完成固定差异审查、唯一追加提交和推送后立即停止，等待人工或审查 Agent 复验。
- 复验通过前不得合入 WORK、阶段线或主线，不进入发布、Portable 或其他施工阶段。

## 2026-09-06｜CODING-P1D-B-R3.3-CLOSEOUT 合法 WSL／嵌套会话回归补正（阶段候选，待人工复验）

### 本阶段目标

只修复 `f45371cf866c8cb8995abb8871d25da6ff0b4046` 人工复验发现的两条合法流程回归：WSL 项目执行路径不得被比较键改成小写；Pi 顶层列表未递归返回的合法嵌套子 Agent 会话，必须能通过已登记父会话完成 `prepare → open`。不修改普通 CODING 产品主链、UI、权限矩阵、OMP、TaskHub 或 WORK 行为。

### 实际修改文件

- WSL 执行路径与比较键：`src/main/project-root-identity.ts`、`src/main/trusted-project-registration-core.ts`、`src/main/worker-execution-identity.ts`、`src/main/trusted-project-registration.test.ts`
- 嵌套子会话来源证明：`src/main/session-prepare.ts`、`src/main/trusted-session-access.ts`、`src/main/ipc/handlers/session.ts`、`src/main/ipc/handlers/trusted-open-handler-chain.test.ts`
- 阶段记录：`DEVELOPMENT_STATUS.md`、`doc/README.md`、`doc/README.zh-CN.md`、`doc/architecture/xiaogui-oh-my-pi-acp-runtime.md`，以及既有 Obsidian 总控、进度和 CODING 研究记录

### 已完成内容

1. `ProjectRootIdentityV2.canonicalRoot` 现在只保存 `realpath` 返回的、保留真实大小写的执行路径；新增比较专用 key，Windows 本地路径按大小写不敏感比较，WSL 只统一 UNC server／distro，Linux 路径主体继续区分大小写。比较 key 不再作为 Worker cwd 返回。
2. 项目登记和 Worker 复用比较统一消费比较专用 key，实际启动、打开和授权仍使用保留大小写的执行根。当前机器通过真实 `\\wsl.localhost\Ubuntu\tmp\XiaoguiCaseRoot-*` 目录证明返回 cwd 可实际访问。
3. `resolvePreparedSessionFile` 对标准 Pi 子 Agent 产物路径同时返回精确父会话证据。Main 只有在该父会话已由 SessionManager 顶层列表登记、项目身份一致，并且子会话 `realpath` 位于父会话私有产物树的固定 `run-id/run-N/session.jsonl` 形状内时，才登记该子会话。
4. 派生登记仍只是 Open 前证据，不在 List/Preview 中签发会话能力；任意 JSONL、伪造父路径、越界或链接写穿不能借此获得 Worker 启动权。合法嵌套子会话已通过真实 handler 级 `prepare → open` 回归。

### 未完成内容

- 尚未执行外部模型或 Electron 人工旅程；本阶段自动证据只覆盖真实 WSL 文件系统、Main handler、会话信任模块及既有 TaskHub 回归。
- 当前仍是独立 CODING 分支阶段候选，未合入 WORK、阶段线或主线，未发布、未制作 Portable。

### 与规格文档存在的偏差

- 无新增产品或架构偏差。本轮只恢复两条被 CLOSEOUT 安全收口误伤的合法流程，不降低“Main 是 Worker 项目根唯一权威”、不恢复 Renderer／JSONL 自证，也不改变 List/Preview 不签发能力的冻结边界。
- WSL 真实回归在本机固定 Ubuntu 发行版上执行；无该发行版的环境会跳过此单条平台测试，但本轮人工证据中的该用例实际执行并通过。

### 测试命令和测试结果

~~~powershell
npm exec vitest run src/main/trusted-project-registration.test.ts src/main/ipc/handlers/trusted-open-handler-chain.test.ts
npm exec vitest run src/main/trusted-project-registration.test.ts src/main/trusted-session-access.test.ts src/main/session-prepare.test.ts src/main/ipc/handlers/trusted-open-handler-chain.test.ts src/main/ipc/handlers/session-preview-authorization.test.ts src/main/ipc/handlers/session-preview-invalidation.test.ts src/main/__tests__/worker-manager-pool.test.ts
npm exec vitest run src/main/xiaogui/task-hub/attempt-workspace.test.ts src/main/xiaogui/task-hub/change-apply.test.ts src/main/xiaogui/coding-extensions/checkpoint-module.test.ts src/main/xiaogui/coding-extensions/permission-module.test.ts
npm run typecheck
$changedTs = @((git diff --name-only --diff-filter=ACMR); (git ls-files --others --exclude-standard)) | Where-Object { $_ -match '\.(ts|tsx)$' } | Sort-Object -Unique
npm exec eslint -- $changedTs
git diff --check
~~~

红灯先稳定复现两项失败：WSL 注册返回全小写且目标不存在；嵌套子会话被 `trusted_session_not_listed` 拒绝。修复后两条直接回归 `2 files / 6 tests` 通过；受影响链 `7 files / 78 tests` 通过；TaskHub V1 核心回归 `4 files / 45 tests` 通过；Node/Web typecheck 和 `8` 个变更 TS 文件定向 ESLint 通过。最终差异检查在提交前再次执行。按范围未运行 OMP、802 MB 装配、外部模型、Electron、Portable 或无关全量测试。

### 已知风险

- 标准子 Agent 目录形状仍由 Pi 0.84.1 当前 `parent/run-id/run-N/session.jsonl` 约定决定；未来 Pi 改变产物布局时会安全拒绝，需要先更新契约与回归，不会退回任意递归信任。
- 没有外部模型和 Electron 人工旅程证据，不能把本候选表述为完整用户验收。

### 下一阶段计划

- 完成差异审查、唯一追加提交和推送后立即停止，等待人工或审查 Agent 复验。
- 复验通过前不得合入 WORK、阶段线或主线，不得进入发布、Portable 或下一阶段施工。

## 2026-09-06｜CODING-P1D-B-R3.3-CLOSEOUT 信任来源补正（阶段候选，待人工复验）

### 本阶段目标

只关闭 `fed469a` 人工复验发现的两条能力签发旁路：Renderer 可写的 `currentProject`／`recentProjects` 不得成为项目授权；任意自报 cwd 的 JSONL 不得成为会话授权。普通 CODING、TaskHub、WORK、OMP、权限矩阵和界面产品定义均不改变。

### 实际修改文件

- 项目信任登记：`src/main/trusted-project-registration-core.ts`（新增）、`src/main/trusted-project-registration.ts`（新增）、`src/main/trusted-project-registration.test.ts`（新增）、`src/main/trusted-workspace.ts`、`src/main/__tests__/trusted-workspace.test.ts`
- Main 原生选择与项目入口：`src/main/ipc/handlers/dialog.ts`、`src/main/ipc/handlers/workspace.ts`、`src/main/ipc/schemas.ts`
- Main 会话发现与能力签发：`src/main/trusted-session-access.ts`、`src/main/trusted-session-access.test.ts`、`src/main/ipc/handlers/session.ts`、`src/main/ipc/handlers/session-preview-authorization.test.ts`、`src/main/ipc/handlers/session-preview-invalidation.test.ts`、`src/main/xiaogui/coding-extensions/checkpoint-default-composition.ts`
- 真实 Handler 攻击链：`src/main/ipc/handlers/trusted-open-handler-chain.test.ts`（新增）、`src/main/__tests__/trusted-worker-seam-architecture.test.ts`
- Renderer 消费迁移：`src/renderer/src/lib/activate-workspace.ts`、`src/renderer/src/lib/ensure-workspace-worker.ts`、`src/renderer/src/features/workspace/project-context-menu.tsx`
- 阶段记录：`DEVELOPMENT_STATUS.md`、`doc/README.md`、`doc/README.zh-CN.md`、`doc/architecture/xiaogui-oh-my-pi-acp-runtime.md`，以及既有 Obsidian 总控、进度和 CODING 研究记录

### 已完成内容

1. 新增 Main 私有项目登记。只有原生目录选择器的实际选择结果和 Main 创建／验证的受管 Sandbox 可以写入登记；登记只保存来源、规范根和目录实体摘要，每次签发内存能力前重新核验实体。
2. `settings.set` 不再接受 `currentProject` 或 `recentProjects`。这两项继续可用于 UI 显示和候选排序，但不能注册项目，也不能签发能力。
3. `workspace.open`、`workspace.switch` 和 `workspace.ensureWorker` 改为只消费既有 Main 登记；未登记路径在修改配置、创建 Worker 或装配上下文前失败。应用启动遇到仅存在于旧 UI 配置的路径时安全回到空白会话，不静默升级授权。
4. Main 会话列表在已授权项目根下发现会话，并记录精确 `session id + session file + project identity` 作为显示后可打开证据；列举本身不签发会话能力或启动 Agent Worker。
5. `session.open`、`setPendingBind`、`prepare`、`navigateTree` 只有命中 Main 列表登记、原子 New/Fork/Clone 回执或精确 live binding 时才能继续。Checkpoint 的持久化记录仍只是待复核证据，恢复前重新执行项目授权和 Main 会话发现。
6. 新增真实 handler 级负例，串起 `settings.set → workspace.open/switch/ensureWorker` 和 `sessionFile → open/prepare/navigate/prompt`。伪造请求不会创建 Worker、聚焦会话、装配 CODING 上下文、调用模型或提交消息；合法原生选择与 Main 列举后的打开路径仍可通过。

### 未完成内容

- 尚未运行“自然语言 → 外部模型 → Electron 用户界面”的人工旅程；自动证据只覆盖 Main/IPC/Worker 的确定性信任接缝和既有真实 Pi 工具生命周期。
- 当前仍是独立 CODING 分支的阶段候选，未合入 WORK、阶段线或主线，未发布或制作 Portable。

### 与规格文档存在的偏差

- 无新增产品或架构偏差。`fed469a` 中“Renderer／IPC 不能取得能力”只约束了句柄形态、未约束签发来源，本轮已将该表述补正为“句柄不可构造且签发依据只能来自 Main 原生选择、受管 Sandbox、Main 会话列表、原子创建回执或 live binding”。
- 首次使用本轮实现时，只有旧 `currentProject/recentProjects`、没有 Main 登记的历史项目不会被静默打开；用户需通过既有原生目录选择器重新确认一次。这是 fail-closed 迁移，不新增界面或模式。

### 测试命令和测试结果

~~~powershell
npm exec vitest run -- --reporter=dot src/main/ipc/handlers/trusted-open-handler-chain.test.ts src/main/trusted-project-registration.test.ts src/main/trusted-session-access.test.ts src/main/__tests__/trusted-workspace.test.ts src/main/ipc/handlers/prompt-trusted-session.test.ts src/main/ipc/handlers/session-preview-authorization.test.ts src/main/ipc/handlers/session-preview-invalidation.test.ts src/main/xiaogui/coding-extensions/checkpoint-production-composition.test.ts src/main/xiaogui/coding-extensions/checkpoint-session-binding-registry.test.ts src/main/xiaogui/coding-extensions/checkpoint-module.test.ts src/main/__tests__/worker-manager-session-isolation.test.ts src/main/__tests__/worker-manager-pool.test.ts src/main/__tests__/trusted-worker-seam-architecture.test.ts src/worker/worker-runtime-session-execution-lease.test.ts src/worker/handlers/worker-handlers-session.test.ts src/worker/handlers/worker-handlers-turn.test.ts src/main/xiaogui/task-hub/attempt-workspace.test.ts src/main/xiaogui/task-hub/change-apply.test.ts src/renderer/src/lib/activate-workspace.test.ts src/renderer/src/lib/__tests__/activate-workspace-switch.test.ts
npm run typecheck
$changedTs = @((git diff --name-only --diff-filter=ACMR); (git ls-files --others --exclude-standard)) | Where-Object { $_ -match '\.(ts|tsx)$' } | Sort-Object -Unique
npm exec eslint -- $changedTs
git diff --check
~~~

结果：TDD 红灯先证明未登记 JSONL 仍可打开且项目登记模块缺失；实现后最终聚焦回归 `20 files / 190 tests` 全部通过，Node/Web TypeScript 通过，`19` 个变更 TS/TSX 文件定向 ESLint 通过，最终差异检查通过。按范围未运行 OMP、802 MB 装配、外部模型、Electron、Portable 或无关全量测试。

### 已知风险

- Main 项目登记是本机私有证据，不是跨设备凭据；主进程仍会在每次能力签发时重验目录实体。
- Main 会话列表登记只在当前进程内有效；重启后必须重新列举或走原子创建／live binding，不能依靠 Renderer 缓存恢复执行权。
- 没有外部模型和 Electron 人工旅程证据，不能把本候选表述为完整用户验收。

### 下一阶段计划

- 完成定向 lint、差异审查、唯一追加提交和远端一致性核对后立即停止，等待人工或审查 Agent 复验。
- 复验通过前不得合入 WORK、阶段线或主线，不得进入发布、Portable 或下一阶段施工。

## 2026-09-06｜CODING-P1D-B-R3.3-CLOSEOUT Pi Worker 项目根唯一权威收口（阶段候选，待人工复验）

### 本阶段目标

只收口一个不变量：任何创建、恢复或重新绑定 Pi Worker 的操作，都必须消费 Main 内存中签发的可信能力；JSONL `cwd` 只能用于一致性比较，不能决定执行目录。保留 R3.3 已通过的 V4 授权路径、后台来源绑定权限框和 Unicode Bidi 防护，不改变 UI、OMP、权限矩阵、TaskHub V1 或 WORK 产品流程。

施工基线固定为 `840a7773728830d640dd3e6da91a3f379ba9d021`。本记录随唯一追加候选提交固化；最终提交 SHA 以 Git 与交付回执为准。

### 实际修改文件

Main 可信能力、创建操作与 Worker 装载：

- `src/main/trusted-worker-capability.ts`（新增）
- `src/main/trusted-worker-control.ts`（新增）
- `src/main/worker-session-creation-operation.ts`（新增）
- `src/main/trusted-session-access.ts`
- `src/main/trusted-workspace.ts`
- `src/main/worker-manager.ts`
- `src/main/worker-manager-pool.ts`
- `src/main/worker-manager-types.ts`
- `src/main/worker-manager-new-session.ts`
- `src/main/session-bind-state.ts`
- `src/main/completion-notification.ts`

Main IPC 与直接 CODING / Checkpoint 接缝：

- `src/main/ipc/handlers/extensions.ts`
- `src/main/ipc/handlers/model-runtime.ts`
- `src/main/ipc/handlers/pi-sdk.ts`
- `src/main/ipc/handlers/prompt.ts`
- `src/main/ipc/handlers/session.ts`
- `src/main/ipc/handlers/skills-resources.ts`
- `src/main/ipc/handlers/workspace.ts`
- `src/main/xiaogui/ipc-handlers.ts`
- `src/main/xiaogui/coding-extensions/checkpoint-default-composition.ts`
- `src/main/xiaogui/coding-extensions/checkpoint-session-binding-registry.ts`
- `src/main/xiaogui/coding-extensions/context-composition.ts`
- `src/main/xiaogui/coding-extensions/plan-worker-tool.ts`

Pi Worker：

- `src/worker/worker-port-types.ts`
- `src/worker/worker-path-bridge.ts`
- `src/worker/worker-runtime.ts`
- `src/worker/handlers/worker-handlers-session.ts`
- `src/worker/handlers/worker-handlers-turn.ts`

新增或修改的聚焦测试：

- `src/main/trusted-worker-capability.test.ts`（新增）
- `src/main/worker-session-creation-operation.test.ts`（新增）
- `src/main/__tests__/trusted-worker-capability-fixture.ts`（新增）
- `src/main/__tests__/trusted-worker-seam-architecture.test.ts`（新增）
- `src/worker/worker-runtime-session-execution-lease.test.ts`（新增）
- `src/main/trusted-session-access.test.ts`
- `src/main/__tests__/worker-manager-coding-role.test.ts`
- `src/main/__tests__/worker-manager-extension-ui.test.ts`
- `src/main/__tests__/worker-manager-pool.test.ts`
- `src/main/__tests__/worker-manager-session-isolation.test.ts`
- `src/main/ipc/handlers/prompt-trusted-session.test.ts`
- `src/main/ipc/handlers/session-delete-trusted-workspace.integration.test.ts`
- `src/main/ipc/handlers/session-preview-authorization.test.ts`
- `src/main/ipc/handlers/session-preview-invalidation.test.ts`
- `src/main/xiaogui/coding-extensions/checkpoint-production-composition.test.ts`
- `src/main/xiaogui/coding-extensions/checkpoint-session-binding-registry.test.ts`
- `src/worker/handlers/worker-handlers-session.test.ts`
- `src/worker/handlers/worker-handlers-turn.test.ts`
- `src/worker/handlers/worker-runtime-tool-registry.test.ts`
- `src/worker/worker-path-bridge.test.ts`

阶段记录：

- `DEVELOPMENT_STATUS.md`
- `doc/README.md`
- `doc/README.zh-CN.md`
- `doc/architecture/xiaogui-oh-my-pi-acp-runtime.md`
- `doc/runtime-r4/OMP-ACP-P1-EXECUTION-GATES.md`
- `D:\Codex\longtime_memory\projects\小规Agent\施工总控.md`
- `D:\Codex\longtime_memory\projects\小规Agent\progress.md`
- `D:\Codex\longtime_memory\projects\小规Agent\research\2026-09-03-CODING研究-OMP-ACP-P1C验收与P1D装配规划.md`

### 已完成内容

1. 新增由对象身份和 `WeakMap` 承载的 Main 内存能力。项目与会话句柄自身不含路径、摘要或可序列化授权数据；Renderer、IPC、Worker 和持久化层均不能构造或取得完整绑定。
2. `WorkerManager` 的启动、装载、聚焦、恢复、新建、Fork 和 Clone 接口只接受 Main 内部句柄。裸 `loadSession(sessionFile)`、`ensureSessionWorker(sessionFile, cwd)`、字符串 workspace hint 和 JSONL cwd 执行兜底均已退出生产调用图。
3. Main→Worker 使用一次性执行租约，下发本次操作的 cwd、会话文件、项目摘要、slot 摘要和 nonce。Worker 核对租约与初始化 slot，只消费一次；冷装载调用 Pi `SessionManager.open(..., cwdOverride)`，热切换调用 `switchSession(..., { cwdOverride })`。
4. 项目实体身份只由 Main 读取和复验。Worker 不跨 Windows/WSL 重算设备号或 inode；进程创建前和初始化完成后均复验项目实体，变化时终止 Worker。
5. New/Fork/Clone 使用一次性创建操作，把 nonce 与精确来源 Worker、slot、项目能力和预期会话目录绑定。Main 核验回执、来源及路径后原子签发新会话能力；重复、伪造、来源变化或越界回执均拒绝。
6. Prompt、Open、Prepare、Navigate、Checkpoint 恢复及共享 WORK 底层入口统一消费可信会话能力。JSONL cwd 只作会话归属一致性比较；持久化 Checkpoint 只保存待复核证据，恢复时必须由 Main 重新检查项目和会话后签发新能力。
7. List/Preview 保持纯展示：不会因列出或预览会话签发能力，也不会冷启动 Worker。只有可信 Open、Main 原子 New/Fork/Clone 或精确 live Worker 可以建立会话能力。
8. 直接 CODING 上下文装配使用同一能力中的授权根；AgentSession、SessionManager、ResourceLoader、项目 Skill/规则和工具不再分别从 JSONL 或 Renderer 参数猜测 cwd。
9. 增加最小 WORK 新建／打开／发送回归，确认共享底层接口迁移没有改变 WORK 的 UI、产品流程、状态语义和工具能力。TaskHub Attempt 工作树、Checkpoint V1、Delivery 和人工 Apply 仍保持原语义。

### 未完成内容

- 尚未执行“自然语言 → 外部模型 → Electron 用户界面”的人工旅程；自动证据只覆盖真实 Pi 工具生命周期、真实文件写入以及 Main/Worker/IPC 的确定性接缝。
- 当前仍是独立 CODING 分支阶段候选，未合入 WORK、阶段线或主线，未发布、未制作 Portable。
- 内存能力在主进程重启后按设计失效；恢复必须经过可信 Open 或重新核验，不提供静默兼容兜底。

### 与规格文档存在的偏差

- 无产品或架构偏差。为满足“List/Preview 不得顺便签发能力”，列表对没有精确同项目 live Worker 的会话只返回显示数据，不再为了列表冷启动 Worker。
- 允许迁移 WORK 使用的共享 `WorkerManager` 底层接口，但没有修改 WORK 的 UI、产品流程、状态语义或工具能力。

### 测试命令和测试结果

~~~powershell
npm exec vitest run -- --reporter=dot packages/shared/xiaogui-direct-coding.test.ts src/main/xiaogui/scope-resolver.test.ts src/main/xiaogui/scope-store.test.ts src/main/__tests__/worker-execution-identity.test.ts src/main/__tests__/worker-manager-session-isolation.test.ts src/main/__tests__/worker-manager-extension-ui.test.ts src/main/__tests__/worker-manager-pool.test.ts src/main/trusted-session-access.test.ts src/main/ipc/handlers/prompt-trusted-session.test.ts src/main/ipc/handlers/session-preview-authorization.test.ts src/main/direct-extension-ui.test.ts src/main/xiaogui/coding-extensions/coding-authorization-module.test.ts src/main/xiaogui/coding-extensions/direct-permission-ui-adapter.test.ts src/main/xiaogui/coding-extensions/direct-coding-worker-tool.test.ts src/main/xiaogui/coding-extensions/direct-coding-module.test.ts src/main/xiaogui/worker-host-tool-router.test.ts src/worker/worker-path-bridge-direct-coding.test.ts src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.test.ts src/renderer/src/features/extension-ui/coding-permission-dialog.test.tsx src/renderer/src/lib/extension-ui-channel.test.ts src/renderer/src/stores/__tests__/extension-ui-store.test.ts src/renderer/src/features/composer/use-composer-send.test.tsx src/renderer/src/lib/subagent-session-navigation.test.ts src/main/xiaogui/coding-extensions/permission-module.test.ts src/main/xiaogui/coding-extensions/checkpoint-module.test.ts src/main/xiaogui/task-hub/attempt-workspace.test.ts src/main/xiaogui/task-hub/change-apply.test.ts src/main/trusted-worker-capability.test.ts src/main/worker-session-creation-operation.test.ts src/main/__tests__/trusted-worker-seam-architecture.test.ts src/worker/worker-runtime-session-execution-lease.test.ts src/main/ipc/handlers/session-preview-invalidation.test.ts src/main/ipc/handlers/session-delete-trusted-workspace.integration.test.ts src/main/xiaogui/coding-extensions/checkpoint-production-composition.test.ts src/main/xiaogui/coding-extensions/checkpoint-session-binding-registry.test.ts src/worker/handlers/worker-handlers-session.test.ts src/worker/handlers/worker-handlers-turn.test.ts src/worker/handlers/worker-runtime-tool-registry.test.ts
npm run typecheck
$codingFiles = @((git diff --name-only --diff-filter=ACMR); (git ls-files --others --exclude-standard)) | Where-Object { $_ -match '\.(ts|tsx)$' } | Sort-Object -Unique
npm exec eslint -- $codingFiles
git diff --check
~~~

结果：`38` 个聚焦测试文件、`361` 项全部通过；Node/Web TypeScript 通过；全部 `48` 个变更 TypeScript/TSX 文件定向 ESLint 通过；差异检查通过。覆盖不透明能力、租约单次消费、New/Fork/Clone 回执、冷/热 Pi cwdOverride、伪造 JSONL、登记缺失、项目实体替换、普通与 Sandbox 首条消息、WORK 新建/打开/发送、TaskHub V1 回归、真实 Pi 工具生命周期与真实文件写入及 WSL 路径接缝。
- 按范围未运行 OMP、802 MB 装配、外部模型、Electron、Portable 或无关全量测试。

### 已知风险

- 没有外部模型和 Electron 人工旅程证据，不能把本阶段表述为完整用户验收。
- Worker 内的一次性租约 nonce 只保留有界历史；达到上限后该 Worker fail-closed，需重建 Worker，不会回退到不受信路径。
- Main 重启会丢失内存能力；这是安全边界，不是持久化恢复完成的证明。

### 下一阶段计划

- 推送唯一追加提交后立即停止，等待人工或审查 Agent 对固定 SHA 复验。
- 复验通过前不得合入 WORK、阶段线或主线，不得进入发布、Portable 或下一阶段施工。

## 2026-09-05｜CODING-P1D-B-R3.3 路径、可信会话与后台授权返修（阶段候选，待人工复验）

### 本阶段目标

在 R3.2 阶段候选上只追加一个整改提交，关闭人工复验提出的四项阻断：WSL 相对路径不得被错误转换到发行版根目录；授权路径必须成为 Pi 的唯一实际执行路径；后台 CODING 权限请求应携带真实来源并可在当前窗口确认；Prompt、Session Open、Prepare 和 Navigate 必须共用 Main 权威的可信会话访问；Bash 命令中的 Unicode 双向控制字符必须在 Worker、Main 和 Renderer 三层拒绝。

产品边界不变：普通 CODING 仍由单一 Pi Harness 直接修改用户项目；TaskHub 仍使用 Attempt 工作树、Delivery 和人工 Apply；不接入 OMP 产品表面、独立配置或第二模型体系。

### 实际修改文件

共享契约与安全校验：

- `packages/shared/ipc-contract.ts`
- `packages/shared/worker-host-tools.ts`
- `packages/shared/xiaogui-direct-coding.ts`
- `packages/shared/xiaogui-direct-coding.test.ts`（新增）

Main、可信会话与后台权限：

- `src/main/trusted-session-access.ts`（新增）
- `src/main/trusted-session-access.test.ts`（新增）
- `src/main/direct-extension-ui.ts`
- `src/main/direct-extension-ui.test.ts`
- `src/main/worker-manager.ts`
- `src/main/__tests__/worker-manager-extension-ui.test.ts`
- `src/main/ipc/schemas.ts`
- `src/main/ipc/handlers/prompt.ts`
- `src/main/ipc/handlers/prompt-trusted-session.test.ts`（新增）
- `src/main/ipc/handlers/session.ts`
- `src/main/ipc/handlers/session-preview-authorization.test.ts`
- `src/main/xiaogui/coding-extensions/direct-coding-module.ts`
- `src/main/xiaogui/coding-extensions/direct-coding-module.test.ts`
- `src/main/xiaogui/coding-extensions/direct-coding-worker-tool.ts`
- `src/main/xiaogui/coding-extensions/direct-coding-worker-tool.test.ts`
- `src/main/xiaogui/coding-extensions/direct-permission-ui-adapter.ts`
- `src/main/xiaogui/coding-extensions/direct-permission-ui-adapter.test.ts`
- `src/main/xiaogui/worker-host-tool-router.ts`
- `src/main/xiaogui/worker-host-tool-router.test.ts`

Pi Worker 与 Renderer：

- `src/worker/worker-host-tool-channel.ts`
- `src/worker/worker-path-bridge.ts`
- `src/worker/worker-path-bridge-direct-coding.test.ts`（新增）
- `src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.ts`
- `src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.test.ts`
- `src/renderer/src/features/composer/use-composer-send.ts`
- `src/renderer/src/features/composer/use-composer-send.test.tsx`
- `src/renderer/src/lib/extension-ui-channel.ts`
- `src/renderer/src/lib/extension-ui-channel.test.ts`
- `src/renderer/src/lib/load-session-history.ts`
- `src/renderer/src/lib/open-session.ts`
- `src/renderer/src/lib/subagent-session-navigation.ts`
- `src/renderer/src/lib/subagent-session-navigation.test.ts`
- `src/renderer/src/stores/extension-ui-store.ts`
- `src/renderer/src/stores/__tests__/extension-ui-store.test.ts`

阶段记录：

- `DEVELOPMENT_STATUS.md`
- `doc/README.md`
- `doc/README.zh-CN.md`
- `doc/architecture/xiaogui-oh-my-pi-acp-runtime.md`
- `doc/runtime-r4/OMP-ACP-P1-EXECUTION-GATES.md`
- `D:\Codex\longtime_memory\projects\小规Agent\施工总控.md`
- `D:\Codex\longtime_memory\projects\小规Agent\progress.md`
- `D:\Codex\longtime_memory\projects\小规Agent\research\2026-09-03-CODING研究-OMP-ACP-P1C验收与P1D装配规划.md`

### 已完成内容

1. 新增独立 V4 preflight/begin 契约。只有首次 `preflight ALLOW` 与首次 `begin EXECUTING` 返回同一 `authorizedRelativePath`；重复调用统一拒绝且不返回路径，不重复询问、不创建检查点、不再次执行 Pi。
2. Worker 不再把授权只当提示。它比较两阶段规范路径，并以复制后的参数调用 Pi；原始参数不原地修改。项目内绝对路径由 Main 规范成相对路径后执行。
3. WSL 路径桥只转换 Linux 绝对路径；`src/a.ts` 与 `./src/a.ts` 保持项目相对语义。
4. 新增 `TrustedSessionAccessModuleV1` 作为 Prompt、Session Open、Prepare 和 Navigate 共用 Seam。Renderer 的 `workspaceId + sessionFile` 不能互相证明可信；Prompt 只能消费 Main 已登记的新建、可信打开、Sandbox 或 live Worker 绑定，JSONL cwd 不再作为 Prompt 冷绑定依据。
5. `session.prepare` 只有解析并授权成功后才写 pending bind；`prompt.send` 在 Worker 创建、上下文装配和消息提交之前完成可信访问检查；`steer/followUp` 还要求精确的活动 Worker。
6. 新会话 JSONL 尚未落盘时，普通项目和临时 Sandbox 可依靠 Main 新建登记及既有 scope 发送首条消息。
7. 后台直接 CODING Worker 可在当前小规窗口发起权限请求。权限框显示安全处理后的来源项目和来源对话，不自动切换会话；用户响应后再次核验精确 Worker、session、cwd 和运行时身份。
8. 切换会话时只保留具有结构化 `DIRECT_SESSION + schemaVersion: 3` 身份的直接权限请求；其他 Extension 请求仍取消。来源 Worker 退出只关闭自身直接权限请求，不影响其他来源队列。
9. Worker、Main 与 Renderer 共用命令安全校验，拒绝非法 ASCII 控制字符及 U+061C、U+200E–U+200F、U+202A–U+202E、U+2066–U+2069；正常换行、制表符、完整命令和 64 KiB 上限保持不变。项目名、对话名仅作安全显示清理，不参与权限身份判断。

### 未完成内容

- 尚未运行“自然语言 → 外部模型 → Electron 用户界面”的完整人工旅程；自动证据仅覆盖真实 Pi 工具生命周期、真实文件写入、Main/Worker/Renderer 接缝和确定性组件行为。
- 当前仍是独立 CODING 分支阶段候选，未合入 WORK、阶段线或主线，未发布、未制作 Portable。
- 历史 OMP 研究源码仍只作隔离证据保留；本阶段没有启动、装配、复测或接入。

### 与规格文档存在的偏差

- 无产品或架构偏差。普通 CODING、TaskHub V1、统一模型配置及 OMP 产品边界保持冻结。
- V4 是替换生产调用的窄契约，不向 V2/V3 类型偷加执行路径，也不建立平行权限或工作树系统。
- 按“非必要不要做那么多测试”的要求，没有运行 OMP、802 MB 装配、外部模型、Electron、Portable、完整构建或无关全量测试。

### 测试命令和测试结果

聚焦回归、无外部模型的 WSL 路径接缝、TaskHub V1 回归及“真实 Pi 工具生命周期与真实文件写入冒烟”：

~~~powershell
npm exec vitest run -- --reporter=dot packages/shared/xiaogui-direct-coding.test.ts src/main/xiaogui/scope-resolver.test.ts src/main/xiaogui/scope-store.test.ts src/main/__tests__/worker-execution-identity.test.ts src/main/__tests__/worker-manager-session-isolation.test.ts src/main/__tests__/worker-manager-extension-ui.test.ts src/main/__tests__/worker-manager-pool.test.ts src/main/trusted-session-access.test.ts src/main/ipc/handlers/prompt-trusted-session.test.ts src/main/ipc/handlers/session-preview-authorization.test.ts src/main/direct-extension-ui.test.ts src/main/xiaogui/coding-extensions/coding-authorization-module.test.ts src/main/xiaogui/coding-extensions/direct-permission-ui-adapter.test.ts src/main/xiaogui/coding-extensions/direct-coding-worker-tool.test.ts src/main/xiaogui/coding-extensions/direct-coding-module.test.ts src/main/xiaogui/worker-host-tool-router.test.ts src/worker/worker-path-bridge-direct-coding.test.ts src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.test.ts src/renderer/src/features/extension-ui/coding-permission-dialog.test.tsx src/renderer/src/lib/extension-ui-channel.test.ts src/renderer/src/stores/__tests__/extension-ui-store.test.ts src/renderer/src/features/composer/use-composer-send.test.tsx src/renderer/src/lib/subagent-session-navigation.test.ts src/main/xiaogui/coding-extensions/permission-module.test.ts src/main/xiaogui/coding-extensions/checkpoint-module.test.ts src/main/xiaogui/task-hub/attempt-workspace.test.ts src/main/xiaogui/task-hub/change-apply.test.ts
~~~

结果：`27` 个测试文件、`268` 项全部通过。覆盖 V4 授权路径、重复调用拒绝、WSL 路径、可信会话、后台来源、Bidi 三层拒绝、真实 Pi write、直接文件检查点，以及 TaskHub V1 权限/检查点/工作树/Apply。

~~~powershell
npm run typecheck
$codingFiles = @(git diff --name-only --diff-filter=ACMR | Where-Object { $_ -match '\.(ts|tsx)$' })
npm exec eslint -- $codingFiles
git diff --check
~~~

结果：Node/Web TypeScript、定向 ESLint 和差异检查通过。

### 已知风险

1. 真实多窗口 Electron 的后台权限框显示、会话切换保留和来源退出关闭仍待人工旅程确认。
2. Bash 仍不是 OS 沙箱；本阶段只保证完整命令可见、逐次确认、Bidi/控制字符拒绝和审计，不承诺撤销外部副作用。
3. Main 内存中的可信会话登记在应用重启后不会自动信任旧 JSONL；旧会话必须通过可信打开流程重新登记，这是预期的 fail-closed 行为。
4. V4 生产契约已替换旧 direct preflight/begin 通道；未来升级必须保持“授权路径等于实际执行路径”和重复调用不执行。

### 下一阶段计划

提交并推送当前隔离分支后立即停止，等待人工或审查 Agent 复验。通过也不自动授权真实模型/Electron 旅程、合入 WORK、阶段线、主线、发布或 Portable。

## 2026-09-05｜CODING-P1D-B-R3.2 来源绑定与大文件安全返修（阶段候选，待人工复验）

### 本阶段目标

在不改变 R3.1 产品主链的前提下，关闭人工验收提出的六项缺口：会话不得换绑到另一个项目；Pi 的项目内绝对路径和 `./` 相对路径必须可用；Bash 授权必须展示完整真实命令；权限框必须绑定发起它的项目、对话和前台窗口；授权前 Main 不得同步读取整份文件；同一路径的项目目录被替换后必须停止执行。

本阶段继续保持普通 CODING 直接修改用户项目、TaskHub Attempt 工作树交付链不变、OMP 不进入产品或验收范围。

### 实际修改文件

共享契约：

- `packages/shared/worker-host-tools.ts`
- `packages/shared/xiaogui-direct-coding.ts`

Main、会话身份与授权接缝：

- `src/main/project-root-identity.ts`（新增）
- `src/main/worker-execution-identity.ts`
- `src/main/worker-manager.ts`
- `src/main/ipc/handlers/session.ts`
- `src/main/ipc/schemas.ts`
- `src/main/xiaogui/scope-resolver.ts`
- `src/main/xiaogui/scope-store.ts`
- `src/main/xiaogui/coding-extensions/coding-authorization-module.ts`
- `src/main/xiaogui/coding-extensions/direct-coding-module.ts`
- `src/main/xiaogui/coding-extensions/direct-coding-worker-tool.ts`
- `src/main/xiaogui/coding-extensions/direct-permission-ui-adapter.ts`
- `src/main/xiaogui/task-hub/runtime-composition.ts`
- `src/main/xiaogui/worker-host-tool-router.ts`

Pi Worker 与 Renderer：

- `src/worker/worker-host-tool-channel.ts`
- `src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.ts`
- `src/renderer/src/features/extension-ui/coding-permission-dialog.tsx`
- `src/renderer/src/features/extension-ui/extension-ui-host.tsx`
- `src/renderer/src/lib/extension-ui-channel.ts`
- `src/renderer/src/lib/session-rewind.ts`
- `src/renderer/src/stores/extension-ui-store.ts`

聚焦测试：

- `src/main/__tests__/worker-execution-identity.test.ts`
- `src/main/__tests__/worker-manager-extension-ui.test.ts`
- `src/main/__tests__/worker-manager-pool.test.ts`
- `src/main/__tests__/worker-manager-session-isolation.test.ts`
- `src/main/xiaogui/scope-resolver.test.ts`
- `src/main/xiaogui/scope-store.test.ts`
- `src/main/xiaogui/coding-extensions/coding-authorization-module.test.ts`
- `src/main/xiaogui/coding-extensions/direct-coding-module.test.ts`
- `src/main/xiaogui/coding-extensions/direct-coding-worker-tool.test.ts`
- `src/main/xiaogui/coding-extensions/direct-permission-ui-adapter.test.ts`（新增）
- `src/main/xiaogui/worker-host-tool-router.test.ts`
- `src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.test.ts`
- `src/renderer/src/features/extension-ui/coding-permission-dialog.test.tsx`
- `src/renderer/src/lib/extension-ui-channel.test.ts`

阶段记录：

- `DEVELOPMENT_STATUS.md`
- `doc/README.md`
- `doc/README.zh-CN.md`
- `doc/architecture/xiaogui-oh-my-pi-acp-runtime.md`
- `doc/runtime-r4/OMP-ACP-P1-EXECUTION-GATES.md`

仓库外同步更新既有长期记录，不新建碎片笔记：

- `D:\Codex\longtime_memory\projects\小规Agent\施工总控.md`
- `D:\Codex\longtime_memory\projects\小规Agent\progress.md`
- `D:\Codex\longtime_memory\projects\小规Agent\research\2026-09-03-CODING研究-OMP-ACP-P1C验收与P1D装配规划.md`

### 已完成内容

1. 会话项目绑定改为不可变：恢复时优先使用会话原有可信项目，传入的当前项目只能与原绑定一致，不能覆盖；树导航必须同时提交并校验 `sessionFile + workspaceId`。
2. 新增 `ProjectRootIdentityV2`，以规范化 realpath、设备号、inode 和创建时间形成目录实体摘要，并写入既有 Scope 持久化；目录在同一路径被删除重建后返回 `PROJECT_IDENTITY_CHANGED`，不继续执行或恢复。
3. Worker 复用身份同时绑定项目目录实体与资源配置；项目缺失、替换或配置变化时旧 Worker 不再复用。AgentSession、SessionManager、ResourceLoader、Skill/规则和工具仍使用同一 cwd。
4. 路径安全门对齐 Pi 原生契约：允许普通相对路径、`./` 路径以及规范化后仍位于项目内的绝对路径；WSL 绝对路径先通过既有路径桥转换。项目外、`.git`、symlink、junction 和 hardlink 仍 fail-closed。
5. Bash 权限提示使用 V3 窄契约传递并展示完整命令，保留换行和制表符、不截断；UTF-8 超过 64 KiB 或含隐藏控制字符时在 Worker 侧直接拒绝。Main 数据库只保存命令摘要，不保存命令正文。
6. 权限提示加入安全项目名、对话名与来源摘要；Main 只向精确匹配 `Worker + session + cwd + runtime identity` 的当前前台窗口发送，缺失、后台或摘要回显不一致均拒绝，不再回退到任意聚焦窗口或第一个窗口。
7. READ 授权前 Main 只异步读取文件元数据，不读取文件正文；edit/write 只有授权通过后才异步捕获前镜像，固定 16 MiB 上限，捕获失败不允许无检查点写入。
8. 授权后、真实工具执行前再次核验目录实体、路径实体和前摘要；会话内写入/Bash 继续串行，重复请求或 `OUTCOME_UNKNOWN` 不会二次执行。
9. `DirectCodingFileCheckpointV2` 与 TaskHub Checkpoint V1 语义均未改动；本轮只把直接会话执行、权限提示和 preflight 升级为 V3，不保留并行生产协议。

### 未完成内容

- 尚未覆盖“自然语言 → 外部模型 → Electron 用户界面”的完整人工旅程；自动证据只证明真实 Pi 工具生命周期、真实文件写入及 Renderer 组件行为。
- 当前仍是独立 CODING 分支的阶段候选，未合入 WORK、阶段线或正式主线，未发布、未制作 Portable。
- 历史 OMP Adapter/装配源码仍只作研究证据保留；本阶段没有启动、复测或重新接入。

### 与规格文档存在的偏差

- 无产品语义偏差。R3.1 的直接写入、ASK/PLAN 只读、Bash 逐次确认、文件检查点与 TaskHub V1 分流均保持不变。
- 为满足 Pi 在 WSL 与 Windows 下的原生路径契约，项目内绝对路径先规范化再授权；这纠正了 R3.1 文档中“所有绝对路径均拒绝”的错误表述，但没有放宽项目边界。
- 按“非必要不做那么多测试”的要求，未运行 OMP、802 MB 装配、外部模型、Electron、Portable、构建或无关全量测试。

### 测试命令和测试结果

聚焦回归与“真实 Pi 工具生命周期与真实文件写入冒烟”：

~~~powershell
npx vitest run --reporter=dot src/main/xiaogui/scope-resolver.test.ts src/main/xiaogui/scope-store.test.ts src/main/__tests__/worker-execution-identity.test.ts src/main/__tests__/worker-manager-session-isolation.test.ts src/main/__tests__/worker-manager-extension-ui.test.ts src/main/__tests__/worker-manager-pool.test.ts src/main/xiaogui/coding-extensions/coding-authorization-module.test.ts src/main/xiaogui/coding-extensions/direct-permission-ui-adapter.test.ts src/main/xiaogui/coding-extensions/direct-coding-worker-tool.test.ts src/main/xiaogui/coding-extensions/direct-coding-module.test.ts src/main/xiaogui/worker-host-tool-router.test.ts src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.test.ts src/renderer/src/features/extension-ui/coding-permission-dialog.test.tsx src/renderer/src/lib/extension-ui-channel.test.ts src/main/xiaogui/coding-extensions/permission-module.test.ts src/main/xiaogui/coding-extensions/checkpoint-module.test.ts src/main/xiaogui/task-hub/attempt-workspace.test.ts src/main/xiaogui/task-hub/change-apply.test.ts
~~~

结果：`18` 个测试文件、`172` 项测试全部通过。覆盖六项人工阻断、64 KiB 命令门、真实 Pi write 工具写入、直接检查点，以及 TaskHub V1 权限/检查点/工作树/Apply 聚焦回归。

~~~powershell
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
$codingFiles = @(git diff --name-only --diff-filter=ACMR | Where-Object { $_ -match '\.(ts|tsx)$' })
npx eslint -- $codingFiles
git diff --check
~~~

结果：Node/Web TypeScript 与定向 ESLint 通过；差异检查通过。没有把本结果命名为外部模型或 Electron 完整旅程。

### 已知风险

1. Bash 仍不是 OS 沙箱；完整命令由用户逐次确认，但项目外文件、网络和子进程副作用不承诺回滚。
2. 16 MiB 以上文件允许 READ，但 edit/write 因无法建立受控前镜像而拒绝；后续如要提高上限，需另行评估主进程内存和私有存储占用。
3. 目录实体身份依赖操作系统提供的设备号、inode 和创建时间；不支持这些字段的特殊文件系统仍可能 fail-closed，需要在对应环境单独验收。
4. 真实多窗口 Electron 来源绑定和真实模型生成项目内绝对路径仍待人工旅程验证。

### 下一阶段计划

提交并推送当前隔离分支后立即停止，等待人工或审查 Agent 复验。通过也不自动授权合入 WORK、阶段线、正式主线、发布或 Portable。

## 2026-09-05｜CODING-P1D-B-R3.1 普通 CODING 直接写入闭环（人工验收未通过，已由上方 R3.2 返修）

### 本阶段目标

把普通 CODING 恢复为一条可用的 Pi 主链：Pi 会话、资源、Skill 和真实工具统一使用用户所选项目作为 cwd；ASK/PLAN 与研究/审阅角色保持只读；EXECUTE 中的普通会话经宿主权限门后直接修改项目。文件写入具有独立的 V2 文件检查点和冲突保护，Bash 保持逐次确认且不承诺回滚。TaskHub 原有 Attempt 工作树、V1 检查点、Delivery 和人工 Apply 语义不变。

本阶段不接入、启动、展示或复测 OMP，也不创建隐藏 Attempt、隐藏工作树或额外 Apply。

### 实际修改文件

共享契约：

- packages/shared/ipc-channels.ts
- packages/shared/ipc-contract.ts
- packages/shared/worker-host-tools.ts
- packages/shared/xiaogui-coding-extension-pack.ts
- packages/shared/xiaogui-coding-permission.ts
- packages/shared/xiaogui-direct-coding.ts

Main 与 TaskHub 接缝：

- src/main/config-store.ts
- src/main/ipc/schemas.ts
- src/main/worker-execution-identity.ts
- src/main/worker-manager-pool.ts
- src/main/worker-manager-types.ts
- src/main/worker-manager.ts
- src/main/xiaogui/index.ts
- src/main/xiaogui/task-hub/ipc.ts
- src/main/xiaogui/task-hub/runtime-composition.ts
- src/main/xiaogui/worker-host-tool-router.ts
- src/main/xiaogui/coding-extensions/coding-authorization-module.ts
- src/main/xiaogui/coding-extensions/direct-coding-checkpoint-ipc.ts
- src/main/xiaogui/coding-extensions/direct-coding-module.ts
- src/main/xiaogui/coding-extensions/direct-coding-production-composition.ts
- src/main/xiaogui/coding-extensions/direct-coding-worker-tool.ts
- src/main/xiaogui/coding-extensions/direct-permission-ui-adapter.ts

Pi Worker 与 Renderer：

- src/worker/worker-host-tool-channel.ts
- src/worker/worker-runtime.ts
- src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.ts
- src/worker/xiaogui-coding-extensions/extension-pack.ts
- src/worker/xiaogui-coding-extensions/role-guard-extension.ts
- src/worker/xiaogui-coding-extensions/transparent-harness-extension.ts（删除）
- src/renderer/src/features/composer/coding-permission-mode-picker.tsx
- src/renderer/src/features/extension-ui/coding-permission-dialog.tsx
- src/renderer/src/features/review/review-panel.tsx
- src/renderer/src/lib/extension-ui-channel.ts
- src/renderer/src/locales/en/composer.json
- src/renderer/src/locales/zh/composer.json
- src/renderer/src/stores/extension-ui-store.ts
- src/renderer/src/xiaogui/components/DirectCodingCheckpointCard.tsx
- src/renderer/src/xiaogui/lib/direct-coding-checkpoint-client.ts

聚焦测试：

- src/main/__tests__/worker-execution-identity.test.ts
- src/main/__tests__/worker-manager-coding-role.test.ts
- src/main/__tests__/worker-manager-extension-ui.test.ts
- src/main/__tests__/worker-manager-pool.test.ts
- src/main/__tests__/worker-manager-session-isolation.test.ts
- src/main/xiaogui/index.test.ts
- src/main/xiaogui/worker-host-tool-router.test.ts
- src/main/xiaogui/coding-extensions/coding-authorization-module.test.ts
- src/main/xiaogui/coding-extensions/direct-coding-checkpoint-ipc.test.ts
- src/main/xiaogui/coding-extensions/direct-coding-module.test.ts
- src/main/xiaogui/coding-extensions/direct-coding-worker-tool.test.ts
- src/renderer/src/features/composer/coding-permission-mode-picker.test.tsx
- src/renderer/src/features/extension-ui/coding-permission-dialog.test.tsx
- src/renderer/src/lib/extension-ui-channel.test.ts
- src/worker/handlers/worker-runtime-tool-registry.test.ts
- src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.test.ts
- src/worker/xiaogui-coding-extensions/role-guard-extension.test.ts

阶段记录：

- DEVELOPMENT_STATUS.md
- doc/README.md
- doc/README.zh-CN.md
- doc/architecture/xiaogui-oh-my-pi-acp-runtime.md
- doc/runtime-r4/OMP-ACP-P1-EXECUTION-GATES.md

仓库外同步更新既有长期记录，不新建碎片笔记：

- D:\Codex\longtime_memory\projects\小规Agent\施工总控.md
- D:\Codex\longtime_memory\projects\小规Agent\progress.md
- D:\Codex\longtime_memory\projects\小规Agent\research\2026-09-03-CODING研究-OMP-ACP-P1C验收与P1D装配规划.md

### 已完成内容

1. 新增 CodingAuthorizationModuleV2：一个深层授权 Module，通过 Direct Adapter 和 TaskHub Adapter 区分 DIRECT_SESSION 与 TASKHUB_ATTEMPT。直接会话只提供“允许一次/拒绝”；TaskHub V1 的 ALLOW_TASK_RULE 和 Attempt 语义不变。
2. 实现普通 CODING 权限矩阵。ASK 只读，PLAN 只读加计划；只有 EXECUTE 且非研究/审阅角色才能进入 bash/edit/write。Bash 和向当前模型提供方之外第三方的工具外传在所有档位均逐次确认。
3. 新增 DirectCodingModuleV2，持久化 PENDING → ALLOWED → EXECUTING → SETTLED/OUTCOME_UNKNOWN；以 toolCallId + requestDigest 幂等，未知结果不会自动重放。
4. edit/write 在权限通过后建立 DirectCodingFileCheckpointV2，私有保存前镜像；执行前再次核验项目根、路径、链接状态和前摘要。撤销只影响目标文件，不倒退 Pi 对话；文件后来变化时拒绝覆盖。
5. 写入路径拒绝绝对路径、路径穿越、.git、symlink、junction 和 hardlink 写穿；新建文件核验最近存在父目录。读操作可并行，edit/write/Bash 使用 Pi 顺序执行语义。
6. Bash 只记录安全预览摘要、执行状态、退出码和可观察结果，不创建文件检查点，并明确提示项目外路径、网络和子进程副作用不能自动撤销。
7. Worker 复用身份加入项目根、Runtime 和 Resource 配置摘要；项目或资源身份变化时销毁并重建 Worker。AgentSession、SessionManager、ResourceLoader、Skill/规则与工具继续共享同一个所选项目 cwd。
8. 未绑定 TaskHub 角色的普通 CODING 不再被角色 Extension 强制只读；研究/审阅角色仍保持只读硬上限。
9. 删除只追加提示词的透明能力 Extension 和重复六字符串清单。普通 CODING 的真实工具事实继续来自 xiaogui-prompt-matrix.ts 与 xiaogui-prompt-capabilities.ts。
10. Review 复用现有区域展示“文件修改检查点”；只列出已完成且可恢复的文件操作，OUTCOME_UNKNOWN 只提示审计与 Diff，不自动重放。

### Pi / Skill /插件复用调查

- 固定复用仓库现有 @earendil-works/pi-coding-agent@0.84.1：AgentSession、SessionManager、ResourceLoader、Extension 生命周期及 read/bash/edit/write 工具均未另建。
- 复用现有 Worker→Main 宿主工具窄通道、Extension UI 和 TaskHub 权限模块；没有建立第二条 IPC、第二套 Agent Loop 或第二套 TaskHub 工作树服务。
- 已安装 Skill、pi-package-manager 和历史 OMP 研究不能在 Main 边界提供直接会话的路径复验、幂等入账和私有前镜像，不能替代本次安全接缝。用户已明确批准 R3.1 的最小框架例外。
- TaskHub V1 检查点硬绑定 Attempt/工作树，不能伪装成普通会话；因此保留 V1，并新增主体为 DIRECT_SESSION 的窄 V2 文件检查点。

### 未完成内容

- 真实“自然语言 → 外部模型 → 用户界面”旅程和 Electron 窗口操作尚未覆盖，留给人工验收。
- 当前没有向第三方目的地主动发送数据的生产工具消费者；DATA_EGRESS 已有授权语义，但没有伪造调用证据。
- 当前仍是独立 CODING 分支的阶段候选，未合入 WORK、阶段线或正式主线，未发布、未制作 Portable。
- 历史 OMP Adapter/装配源码仍仅作研究证据保留，没有产品消费者；本阶段未删除、启动或复测。

### 与规格文档存在的偏差

- 无产品语义偏差。按用户批准的 R3.1，普通 CODING 直接修改所选项目，不创建 Attempt/隐藏工作树/额外 Apply；TaskHub 仍使用原工作树交付链。
- OMP 完全退出当前产品与验收范围；上一轮“透明集成 OMP 六项能力”的口径已被人工否决并由本记录取代。
- 按用户“非必要不做那么多测试”的要求，没有运行 OMP、802 MB 装配、外部模型、Electron、Portable、完整构建或无关全量测试。

### 测试命令和测试结果

真实 Pi 工具生命周期与真实文件写入冒烟：

~~~powershell
npx vitest run src/main/xiaogui/coding-extensions/direct-coding-checkpoint-ipc.test.ts src/main/xiaogui/coding-extensions/direct-coding-module.test.ts src/main/xiaogui/coding-extensions/direct-coding-worker-tool.test.ts src/worker/xiaogui-coding-extensions/direct-coding-tool-extension.test.ts
~~~

结果：4 个测试文件、20 项全部通过。覆盖真实临时目录中的写入、前后摘要、当前可信项目根绑定、撤销与冲突保护；不宣称外部模型或 Electron 完整旅程。

其余聚焦证据：

- Worker 项目/资源身份及复用：5 个文件、61 项通过。
- Direct/TaskHub 授权、TaskHub V1 检查点/Review/Runtime 接缝：5 个文件、33 项通过；TaskHub 仍走原 Attempt 工作树语义。
- Renderer 权限两按钮、档位文案和公开契约：3 个文件、11 项通过。
- 主入口生产装配：2 项通过。
- npx tsc -p tsconfig.node.json --noEmit：通过。
- npx tsc -p tsconfig.web.json --noEmit：通过。
- 定向 ESLint：通过。
- git diff --check：通过。
- 独立增量代码复审：APPROVE/CLEAR，HIGH 与 MEDIUM 阻断均为 0；审查证据保存在忽略的 .omo/evidence，不进入提交。

### 已知风险

1. Bash 不是 OS 沙箱，批准后可能触达项目外路径、网络或子进程；产品只承诺逐次确认和审计，不承诺回滚。
2. 文件授权后若有其他进程修改，执行前摘要或撤销时摘要会冲突并安全停止；用户需要人工处理最新内容。
3. 文件前镜像保存在主进程私有 SQLite；后续应在不改变恢复语义的前提下设计明确保留/清理周期并显示占用。
4. 历史 OMP 研究源码仍位于仓库，后续合并必须继续防止误注册为 Runtime 或恢复旧产品表面。

### 下一阶段计划

完成最终差异审查、提交并推送当前隔离分支后立即停止。下一门只有人工或审查 Agent 验收；通过也不自动授权合入 WORK、阶段线、正式主线、发布或 Portable。

## 2026-09-04｜CODING 透明能力正向链返修（人工验收未通过，已由 2026-09-05 R3.1 取代）

### 本阶段目标

关闭 `d8dfec1` 人工验收指出的正向链与双语文档缺口：保留已经完成的独立 OMP Runtime/UI/模型配置删减，明确当前实际复用的 OMP 行为，并证明这些能力在进入 CODING 时由现有 Pi Extension、Skill 与 TaskHub 接缝透明生效，而不是只比较 Extension 数量。

### 实际修改文件

- `src/worker/xiaogui-coding-extensions/transparent-harness-extension.ts`
- `src/worker/worker-runtime.ts`
- `src/worker/handlers/worker-runtime-tool-registry.test.ts`
- `doc/architecture/xiaogui-oh-my-pi-acp-runtime.md`
- `doc/runtime-r4/OMP-ACP-P1-EXECUTION-GATES.md`
- `doc/README.md`
- `doc/README.zh-CN.md`
- `DEVELOPMENT_STATUS.md`

仓库外继续更新既有长期记录，不新建零散规划：

- `D:\Codex\longtime_memory\projects\小规Agent\progress.md`
- `D:\Codex\longtime_memory\projects\小规Agent\施工总控.md`
- `D:\Codex\longtime_memory\projects\小规Agent\research\2026-09-03-CODING研究-OMP-ACP-P1C验收与P1D装配规划.md`

### 已完成内容

1. 新增隐藏的 `xiaogui-coding-transparent-harness-v1` Pi Extension，并且只在 `mode === 'CODING'` 的现有 Pi Worker 初始化链自动装入；没有 OMP 进程、Adapter、开关、模型目录或用户界面。
2. 单一版本化清单明确六项透明能力：项目规则与 Skill、受控上下文、角色工具边界、宿主权限、用户选择的计划、真实证据与检查点。
3. 能力提示明确普通编程请求直接处理；只有用户明确要求规划或会话已处于 PLAN 才使用计划流程，禁止把普通 CODING 请求硬切到 ASK/PLAN。
4. 写入、命令、外传、真实 Diff/验证和检查点恢复继续由既有角色保护与 TaskHub 权威模块硬性控制；Extension 只提供 Pi 侧装配和提示，不复制权限或状态机。
5. 初始化回归不再统计 Extension 数量，而是实际注册并触发工厂：验证透明提示存在、未绑定角色写入被拦截、相对文件上下文进入本轮模型且不出现绝对路径；同时证明 WORK 没有这些 CODING 行为钩子。
6. 架构文档新增六项能力逐项映射及行为证据；中英文 README 统一说明当前透明能力与旧 OMP Runtime 历史研究的边界，旧生产门不再被表述为当前施工队列。

### 未完成内容

- 当前仍是独立 CODING 分支候选，未合入 WORK、阶段线或正式主线，未发布或制作 Portable。
- 历史 OMP Adapter、装配与测试源码继续作为研究证据保留，但没有生产消费者；本阶段未删除或复测它们。
- 本阶段仍需人工验收；验收前不进入新的后续工作。

### 与规格文档存在的偏差

- 原 P1D-B“独立 OMP ACP Runtime 产品化”已被用户最新决定取代；当前复用的是已选定的成熟交互行为，由 Pi/TaskHub 现有接缝等价提供，不是运行 OMP 包。
- OMP 能力不产生任何用户可见名称、按钮、模式、状态、安装或第二模型配置。用户只知道自己进入 CODING。
- 计划能力保留，但不作为所有请求的前置硬门；这与用户明确取消“默认先 ASK/PLAN”的决定一致。

### 测试命令和测试结果

```powershell
$env:XIAOGUI_TEST_TEMP_ROOT='D:\CodexTemp'
npm exec vitest run -- src/worker/handlers/worker-runtime-tool-registry.test.ts src/worker/xiaogui-coding-extensions/context-extension.test.ts src/worker/xiaogui-coding-extensions/role-guard-extension.test.ts src/main/xiaogui/coding-extensions/permission-policy.test.ts src/worker/xiaogui-coding-plan-tool.test.ts src/main/xiaogui/coding-extensions/attempt-review-module.test.ts src/main/xiaogui/coding-extensions/checkpoint-module.test.ts --reporter=dot
```

结果：`7` 个测试文件、`29` 项测试全部通过，退出码 `0`。随后只补跑权限持久规则和 Attempt 计划两个直接权威模块：

```powershell
npm exec vitest run -- src/main/xiaogui/coding-extensions/permission-module.test.ts src/main/xiaogui/coding-extensions/attempt-plan-module.test.ts --reporter=dot
```

补充结果：`2` 个测试文件、`13` 项测试全部通过。合计 `9` 个相关文件、`42` 项通过；逐项覆盖 CODING 初始化、受控上下文、角色工具上限、权限 fail-closed、计划草稿/批准、真实审阅证据和检查点恢复，不是 OMP 本体复测。

```powershell
npm run typecheck
npm exec eslint -- src/worker/xiaogui-coding-extensions/transparent-harness-extension.ts src/worker/worker-runtime.ts src/worker/handlers/worker-runtime-tool-registry.test.ts
git diff --check
```

结果：Web/Node TypeScript、定向 ESLint 与 `git diff --check` 均通过，退出码 `0`。按用户要求不运行 OMP 本体、802 MB 装配、真实模型、Electron、全量测试或 Portable。

### 已知风险

1. 项目规则与 Skill 的发现继续依赖 Pi 原生 Resource Loader；透明 Extension 只规定如何使用，不能代替 Pi 的实际加载诊断。
2. 历史 OMP 研究源码仍在 `src/main`，但当前没有生产 import 或消费者；未来合并仍需防止误恢复旧 Runtime 选择。
3. 透明提示是单一版本化代码来源；后续若调整能力口径，应同步行为测试和架构映射，不能另加散落硬编码。

### 下一阶段计划

完成 TypeScript、定向 ESLint、差异检查和只读审查后，提交并推送当前隔离分支并停止，等待人工验收。通过也不代表合入 WORK/主线、切换 Runtime 或发布。

## 2026-09-04｜CODING Pi 主链与 OMP 产品路线纠偏返修（人工验收未通过，已进入上方正向链返修）

### 本阶段目标

关闭 `3731316` 人工验收提出的五项问题：不能只删除 OMP 界面，还必须从产品生产组合撤下独立 OMP Runtime/选择接缝，删除第二模型目录遗留接口，把正向主链固定为现有 Pi Coding Harness 自动装载小规 Coding Extension/Skill，并同步仓库权威文档和长期总控。

本阶段继续保留首轮已经正确完成的界面删减，不恢复废弃 P1D-B stash，不触碰 WORK、阶段线或正式主线。

### 实际修改文件

- `src/main/xiaogui/task-hub/runtime-composition.ts`
- `src/main/xiaogui/task-hub/runtime-composition.test.ts`
- `src/main/pi-models-json.ts`
- `src/worker/handlers/worker-runtime-tool-registry.test.ts`
- `doc/README.md`
- `doc/architecture/xiaogui-oh-my-pi-acp-runtime.md`
- `doc/runtime-r4/OMP-ACP-P1-EXECUTION-GATES.md`
- `DEVELOPMENT_STATUS.md`

仓库外同步更新现有长期记录（不新建碎片文档）：

- `D:\Codex\longtime_memory\projects\小规Agent\progress.md`
- `D:\Codex\longtime_memory\projects\小规Agent\施工总控.md`
- `D:\Codex\longtime_memory\projects\小规Agent\research\2026-09-03-CODING研究-OMP-ACP-P1C验收与P1D装配规划.md`

### 已完成内容

1. `createXiaoguiRuntimeCompositionV1` 删除 `ompProductionEnabled`、OMP 存储目录、Probe/Transport 参数、OMP Adapter 创建与注册、OMP Recovery Store、OMP 专用 CandidateAudit、首选 Adapter 和选择分支。默认产品组合已不存在 OMP 的启停或 Runtime 选择。
2. 通用 `additionalRuntimeAdapters` 接缝继续保留，供 TaskHub 已批准的外部执行器使用；它不是 OMP 专用入口，也不会自动注册历史 OMP Adapter。
3. 历史 OMP Adapter、受信装配和研究测试源码没有整体删除或二次开发，只作为隔离研究证据保留；产品组合没有消费者。
4. 删除 `readModelsConfigForAgentDir`、`writeModelsConfigForAgentDir` 及其只为第二 Agent 目录存在的路径校验代码。模型读写只剩小规现有统一配置入口。
5. 现有生产事实得到聚焦测试固定：WORK 仅加载公共 Prompt Extension；进入 CODING 后，同一个 Pi Resource Loader 自动增加角色保护与受控上下文两个隐藏 Coding Extension，同时使用 CODING 工具全集。该路径不启动或展示 OMP。
6. OMP 架构文档和施工门文档已显著标记为“历史研究、产品路线已取代”；`doc/README.md` 不再把它们描述为当前架构/施工队列。
7. Obsidian 的进展、施工总控和原 OMP 研究规划已同步：P1D-A 最终验收点 `59e23bf` 只作为研究证据，P1D-B 明确取消，旧的显式 OMP 单机试用指令不可继续。

### 未完成内容

- 未合入 WORK、阶段线或正式主线，未切换发布配置，未制作 Portable。
- 未删除 P0—P1D-A 的历史研究源码、文档证据或 D 盘资产；本阶段只保证产品组合不注册它们。
- 未新增或重做 OMP 功能。以后只有出现 Pi 原生/现有小规扩展无法满足的真实缺口，才可另行审批具体 Skill/Extension 复用。
- 本阶段候选仍需人工验收；验收前不得进入新的后续阶段。

### 与规格文档存在的偏差

- 2026-09-04 用户最新产品决定明确取代原 P1D-B：OMP 不再是独立 ACP Runtime 产品，不存在专用模型、设置页、启停、目录、状态、安装、清理或选择 UI。
- CODING 正向产品主链为现有 Pi Worker/Pi Coding Harness；上下文、权限、计划、Diff、检查点和角色仍按已验收的小规 Pi/TaskHub 接缝工作。没有为了改名而复制 OMP 或另建 Agent Loop。
- `runtime-composition.ts` 中既有 Kimi Adapter 属于 TaskHub 外部任务执行基础设施，不是 CODING 对话的模型配置或第二套 Harness；本次不借 OMP 纠偏扩大为多运行时重构。
- 未违反 WORK、Univer、Prompt 模式边界及现有降级路径；相关文件未修改。

### 测试命令和测试结果

```powershell
$env:XIAOGUI_TEST_TEMP_ROOT='D:\CodexTemp'
npm exec vitest run -- src/main/xiaogui/task-hub/runtime-composition.test.ts src/main/pi-models-json.test.ts src/worker/handlers/worker-runtime-tool-registry.test.ts --reporter=dot
```

结果：`3` 个测试文件、`20` 项测试全部通过，退出码 `0`。

```powershell
npm run typecheck
```

结果：Web 与 Node TypeScript 均通过，退出码 `0`。

```powershell
npm exec eslint -- src/main/pi-models-json.ts src/main/xiaogui/task-hub/runtime-composition.ts src/main/xiaogui/task-hub/runtime-composition.test.ts src/worker/handlers/worker-runtime-tool-registry.test.ts
git diff --check
```

结果：定向 ESLint 与 `git diff --check` 均通过。按用户要求未运行 OMP 本体、802 MB 装配、真实模型、Electron、全量测试或 Portable。

### 已知风险

1. 历史 OMP 研究文件仍在仓库中；权威文档已加取代标记，但未来合并时仍应确认产品组合没有重新导入这些模块。
2. TaskHub 仍保留通用外部 Runtime 注册能力。这是既有多 Agent 架构接缝，不会让 OMP 自动出现；任何新 Runtime 仍需单独审批。
3. D 盘历史 OMP 资产未清理，避免未经授权执行破坏性操作；其磁盘处置不属于本阶段。

### 下一阶段计划

完成最终差异检查、提交并推送当前隔离分支后停止，等待人工验收。通过也只表示本次产品路线纠偏候选可用，不代表合入 WORK、阶段线、正式主线或发布。

## 2026-09-04｜CODING 模型配置与 OMP 产品表面简化（首轮人工验收未通过，已进入上方返修）

### 本阶段目标

按用户最终确认收回过度设计：CODING 继续使用现有 Pi Coding Harness 和小规唯一一套模型配置；OMP 不作为用户可见的新模式、独立模型目标或设置项。

### 实际修改文件

- `packages/shared/ipc-channels.ts`
- `packages/shared/ipc-contract.ts`
- `src/main/ipc/handlers/pi-sdk.ts`
- `src/main/ipc/pi-models-handler.test.ts`
- `src/renderer/src/features/settings/models-settings-panel.tsx`
- `src/renderer/src/features/settings/models-settings-panel.test.tsx`
- `src/renderer/src/locales/en/settings.json`
- `src/renderer/src/locales/zh/settings.json`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 模型设置页恢复为唯一的“小规默认模型”配置，不再显示或切换到“Oh My Pi”独立页签。
2. 删除 Renderer 可调用的 OMP 专用模型读写通道及其主进程 Handler；用户不再维护第二份模型配置。
3. 保留 Pi 原有供应商、模型列表、默认模型和 Worker 重载流程，CODING 不新增模型选择体系。
4. 本轮曾产生但未提交的 P1D-B OMP 安装、存储、清理、状态 UI 和默认 Runtime 改动已整体撤下，并保存在可恢复 stash 中；未进入本候选。

### 未完成内容

- 不继续实现 OMP 独立启动、安装、存储、清理、模型同步或 Runtime 选择功能。
- 不把 P1D-A 的 OMP Runtime 研究成果合入主线；其仍只保留在独立研究分支。
- 本阶段没有修改 WORK、发布配置、Portable 或正式主线。

### 与规格文档存在的偏差

- 本阶段以用户 2026-09-04 的最新产品决定为准，终止此前“OMP 作为独立 ACP Runtime 产品化”的 P1D-B 方向。
- P1D-A/P1C 的历史证据继续保留，但不再构成当前产品施工指令。
- OMP 中未来确有必要复用的成熟能力，只允许按需作为 Pi Extension 或 Skill 接入；不得因此新增用户界面、模式或第二套模型配置。

### 测试命令和测试结果

```powershell
npm exec vitest run -- src/renderer/src/features/settings/models-settings-panel.test.tsx src/main/ipc/pi-models-handler.test.ts --reporter=dot
npm run typecheck
git diff --check
```

- 首次聚焦测试因测试初始化仍引用已删除的 OMP mock 而失败；删除该过期引用后复跑通过：`2` 个测试文件、`20` 项测试全部通过。
- Web 与 Node TypeScript 类型检查通过，退出码 `0`。
- `git diff --check` 通过，仅有 Windows LF/CRLF 提示。
- 按用户要求未运行 OMP 本体、802 MB 装配、真实模型、全量测试、Electron 或 Portable。

### 已知风险

1. P1D-A/P1C 仍存在于独立历史分支，后续不得误合入产品主线。
2. 本轮只移除用户可见的第二套模型配置，不重构或复测历史 OMP 研究代码。

### 下一阶段计划

提交并推送本独立分支后停止，等待人工验收。未经新授权不继续 OMP 产品化，也不合入 WORK 或正式主线。

## 2026-09-03｜RUNTIME-R4 P1D-A 复用调查文档门补录（待人工复验）

### 本阶段目标与状态

- 目标：关闭人工 Standards 复验指出的唯一强制文档门，把 P1D-A 对 Pi 原生、已装 Skill、pi.dev Extension/Package、OMP 本体和院内既有接缝的调查写成可复核账目。
- 状态：功能与 Spec 已人工通过；文档证据已补齐，正式验收仍暂缓，等待人工复验；不得进入 P1D-B。
- 代码基线：`f1034ac5ee944ded4f63518e536ee602a636d128`；首个文档补录提交 `1c63e996d573b7e9871200bb28d9e57f872c90fb` 中不充分的候选口径已在本轮纠正。
- 隔离边界：未修改源码、测试、依赖或构建配置；未触碰 WORK、主线、默认 Runtime、模型或 Portable。

### 实际修改文件

- `doc/runtime-r4/OMP-ACP-P1D-A-QA.md`
- `doc/runtime-r4/OMP-ACP-P1D-A-REVIEW.md`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 明确定义本次复用门真正要满足的契约：外部 OMP ACP 进程在 Windows native `require` 前完成回执绑定、父环境隔离和完整树复验，并在启动后证明实际模块来源。
2. 补齐 `@earendil-works/pi-coding-agent@0.84.1`、两个已装 Skills、`pi-package-manager@0.2.1`、`pi-sandbox@0.6.6`、固定 OMP 18.1.2 和小规既有 Transport/TaskHub 接缝的来源、版本或 commit、许可证、能力与缺口。
3. 完成当前 Pi 的 Skill 发现冒烟：两项 Skills 均被发现，诊断数 `0`。
4. 在 D 盘固定下载 `pi-package-manager@0.2.1`，核对实际源码并完成“只加载、不执行命令”的 Extension 冒烟：`1` 个 Extension、`2` 个命令、`0` 个错误。
5. 移除把 HTTP `200` 当成功能冒烟、把无关候选堆成清单和引用未批准新版本的错误口径；本阶段仍只固定 OMP `18.1.2`。
6. 登记人工复验的两项 LOW：bundle 模块职责集中、七项受控环境目录存在 Data Clumps；遵照审查建议不在 P1D-A 扩大重构。

### 未完成内容

- 人工尚未对补录后的文档差异正式放行；P1D-A 不能进入 P1D-B。
- P1D-B、主线合并、默认 Runtime、发布和 Portable 均未授权、未开始。

### 与规格文档存在的偏差

- 无产品或架构偏差。补录证明最终实现仍是复用 OMP、Pi、TaskHub 与现有 Process Transport，只扩展必须的受信启动接缝。
- `pi-package-manager` 的内部 loader 冒烟只用于判断候选能力，没有把非公开 loader 路径写入生产代码。
- `pi-sandbox` 的官方平台矩阵不含 Windows，因此按平台门拒绝，没有为了凑测试数量执行无意义安装。

### 测试命令和测试结果

- 本轮没有源码变化，按人工复验意见不重复运行 802 MB D 盘真实门、46 项聚焦回归、typecheck、模型或 Electron。
- 候选冒烟结果：当前 Pi Skill 发现 `2` 项、诊断 `0`；`pi-package-manager@0.2.1` 加载为 `1` 个 Extension、注册 `packages` 与 `packages-stop`、加载错误 `0`。
- 文档差异、SHA/分支/工作树已核对；`git diff --check` 退出码 `0`（仅 Windows LF/CRLF 提示）。文档专项复审结论为 `APPROVE`。

### 已知风险

1. `omp-runtime-bundle.ts` 的职责集中和受控环境目录字段聚集继续作为 LOW 维护风险保留；当前无证据支持为此拆模块。
2. 候选 Package 的版本与上游页面可能变化；本记录只对表中精确版本、commit 和 SRI 有效。
3. 正式验收仍以人工复验为准，不能把本次文档提交视为 P1D-A 已放行。

### 下一阶段计划

提交并推送这三份文档后停止，等待人工复验。没有 P1D-B 施工授权。

## 2026-09-03｜RUNTIME-R4 OMP ACP Runtime P1D-A 人工拒绝项复修候选

### 本阶段目标与状态

- 人工验收明确拒绝首次候选 `a9377a22e531cc55e06b40917e103217c6e71c93`，P1D-A 不得进入 P1D-B。
- 本轮目标只覆盖被拒绝项及复审直接发现的同一安全边界：隔离并验证实际 native 加载位置、敌意全局缓存回归、版本冲突保留旧目录、完整树启动前复验、所有目录写前拒绝 junction、并发装配互斥、失败资源归属清理，以及新的 D 盘实际加载/篡改拒绝证据。
- 状态：代码修复、红灯复现、最终聚焦回归、Node/Web 类型检查、最终 D 盘真实门、独立 Standards/Spec/代码质量复审及最终只读门禁均已完成；当前复修候选只允许提交并推送本独立分支，随后继续等待人工验收。
- 工作树：`D:\CodexWorktrees\xiaogui-omp-acp-p1d-a-v1`；分支：`agent/runtime-r4-omp-acp-p1d-a-v1`；复修基线：被拒绝候选 `a9377a22e531cc55e06b40917e103217c6e71c93`。
- 隔离边界：未触碰 WORK 工作树、集成线或正式主线；未进入 P1D-B，未切默认 Runtime，未运行模型、Electron、Portable 或无关全量测试。

### 实际修改文件

- `src/main/xiaogui/agent-runtime/acp/types.ts`
- `src/main/xiaogui/agent-runtime/acp/process-transport.ts`
- `src/main/xiaogui/agent-runtime/omp-acp-adapter.ts`
- `src/main/xiaogui/agent-runtime/omp-acp-production.ts`
- `src/main/xiaogui/agent-runtime/omp-acp-production.test.ts`
- `src/main/xiaogui/agent-runtime/omp-runtime-bundle.ts`
- `src/main/xiaogui/agent-runtime/omp-runtime-bundle.test.ts`
- `src/main/xiaogui/task-hub/runtime-composition.test.ts`
- `doc/architecture/xiaogui-oh-my-pi-acp-runtime.md`
- `doc/runtime-r4/OMP-ACP-P1-EXECUTION-GATES.md`
- `doc/runtime-r4/OMP-ACP-P1D-A-QA.md`
- `doc/runtime-r4/OMP-ACP-P1D-A-REVIEW.md`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 固定 manifest 增加 Windows x64 baseline native 文件名、相对来源、大小与固定 SHA-256；manifest digest 更新为 `sha256:d7240a13aa2ef236285d34112b253de19472591a888d78a8aa4cbca7c146c1f3`。
2. 激活事务在用户选择的同一存储根内创建 activation receipt 绑定的 native 缓存。源、缓存、完整活动树、活动 pointer/receipt 和全部受控进程目录在固定入口版本探测及正式 ACP spawn 前都会再次核对；任一漂移均 fail-closed。
3. OMP 生产子进程改用封闭 allowlist 环境，不再继承用户 `NODE_OPTIONS`、`NODE_PATH`、全局 OMP/Bun 缓存变量或其他父环境。固定 `XDG_DATA_HOME` 使上游 Windows loader 只使用回执绑定 native 缓存。
4. 真实 Windows ACP 进程的模块表已证明实际加载文件等于 D 盘回执绑定缓存，并明确不等于 `%USERPROFILE%\.omp\natives\18.1.2` 全局候选。
5. `activatedRoot` 只在本事务 rename 成功后取得清理所有权；`VERSION_CONFLICT` 不再删除既有活动版本。
6. 删除完整树成功缓存；每次 production inspect 和每次真实 spawn 前都重算全部 24,230 个文件，非关键可执行依赖漂移也会拒绝。
7. 存储根、`versions`、私有 state 和 native cache 改为逐级非递归安全创建：每层写入前后均核对实路径父子关系；junction/symlink 不再出现“写穿后才拒绝”。
8. 同一 storage root 使用一个 SQLite `BEGIN EXCLUSIVE` 排他锁；不同 profile/state 也不能并行装配，进程崩溃由 SQLite/OS 自动释放。缓存只在锁内发布，晚期失败只清理本事务新建的 candidate/native cache。
9. 重新完成 Pi 原生、Skill、插件/Package 候选实查并记录到 QA：复用既有 ACP Process Transport、`preSpawn`、TaskHub、Node SQLite 和 OMP package；Skill/Extension 无法在 native `require` 前提供进程环境和二进制回执门，因此只扩展既有最小接缝。
10. 为回应 Standards 的文档门，本轮补充了 QA 的具体候选对象、官方来源、可固定版本/元数据和只读冒烟结果；源码与测试闭环保持不变。

### 未完成内容

- 本轮复修尚待提交、推送与再次人工验收；当前不能进入 P1D-B。
- P1D-B Renderer、目录选择、进度、空间提示、失败恢复和清理 UI 均未开始。
- 自动下载、解包、升级、离线安装资源、Portable 和默认 Runtime 切换不在本轮。
- 旧受信版本与旧 native 缓存继续保留；没有自动清理。

### 与规格文档存在的偏差

- 没有改变冻结架构：继续复用 OMP/Pi ACP、现有 Process Transport、TaskHub Attempt/权限/工作树/结果对账/恢复；没有新增 Agent Loop、权限系统或安装状态机。
- 为修复实际 native 加载逃逸，新增约 175.6 MB 的回执绑定缓存。这是上游 Windows loader 固定行为要求的显式存储成本，已纳入空间预检和 D 盘总账。
- 仍保留 P1B/P1C 的 `omp-trusted-installation` 兼容证据；本轮不为消除 LOW 级重复而扩大重构范围。
- 真实门仅做 ACP initialize、模块路径和篡改拒绝，不发送模型 Prompt；P1C 已验收模型改文件旅程，本轮没有重复。
- 本轮仅做文档证据补齐，没有新增源码变更，也没有重新运行 802 MB 真实门或仓库全量测试。

### 测试命令和测试结果

拒绝项 TDD 红灯：bundle 新增回归首次为 `3 failed / 3 passed / 1 skipped`；生产 Adapter native 环境用例首次返回 FAILED，分别实证旧版本误删、非关键漂移漏检、junction 绕过和仅传状态目录的问题。

```powershell
npm run test:unit -- src/main/xiaogui/agent-runtime/omp-runtime-bundle.test.ts src/main/xiaogui/agent-runtime/omp-acp-production.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts
```

最终结果：`5 test files passed`，`46 tests passed`，`3 tests skipped`。覆盖目录写前门、不同 state 的并发互斥、SQLite 锁释放、晚期失败资源清理、启动前完整树/受控目录复验、封闭父环境、Adapter 兼容及生产 composition。

```powershell
npm run typecheck
git diff --check
```

结果：Web/Node 类型检查退出码 `0`；差异检查退出码 `0`，仅 Windows LF/CRLF 提示。

最终 D 盘真实门使用 `D:\CodexCache\xiaogui-omp-p1d-a-resubmit` 与独立 state，结果 `1 test file passed / 15 tests passed`，退出码 `0`，耗时 `64.67s`。本轮在已激活真实闭包上重新执行最终代码的全树/受控目录门、ACP initialize、Windows 模块路径核对、排除用户全局缓存、缓存单字节篡改拒绝和恢复；活动 bundle 为 802,082,147 文件字节（含回执），native 缓存为 175,602,176 字节。没有模型调用。

详细命令、摘要和能力复用调查见 `doc/runtime-r4/OMP-ACP-P1D-A-QA.md`。

### 审查结果

- 人工 Spec 复验：`APPROVE`，当前功能阻断数 `0`。
- 人工 Standards 复验：`REQUEST_CHANGES`；唯一强制项是复用调查记录不够具体，现已补录并等待再次复验。
- 独立代码质量复审：`CLEAR / APPROVE`，无 CRITICAL、HIGH 或 MEDIUM 项。
- 人工复验的两项 LOW 已记录：bundle 模块职责集中；七项受控环境目录存在 Data Clumps。本轮不为其扩大重构。
- 先前内部最终阶段门禁的 `APPROVE` 只证明代码候选可提交，不能替代后续人工正式验收。

### 已知风险

1. 为消除完整树缓存绕过，每次生产启动都会完整重验约 802 MB/2.4 万文件；后续性能优化必须先给出等价不可变性证据，不能恢复只验少数 critical 文件。
2. 源闭包、活动 bundle 与 native 缓存合计约 1.78 GB 文件字节；旧版本继续增加占用，P1D-B 必须展示空间影响并让用户确认清理。
3. storage-root SQLite 锁是小体积私有元数据；它解决跨进程互斥与崩溃释放，但不宣称修复底层文件系统损坏。
4. 原子 rename 和 pointer 回读恢复不宣称覆盖断电或底层文件系统损坏的全部情况。
5. OMP 升级必须重新固定 loader 行为、native 路径/摘要、完整树与 approval envelope。

### 下一阶段计划

提交并推送当前独立分支后停止施工，等待人工复验 P1D-A。没有 P1D-B、合并、默认 Runtime 切换或发布授权。

## 2026-09-03｜RUNTIME-R4 OMP ACP Runtime P1D-A 首次候选（已被人工拒绝，保留历史证据）

### 本阶段目标与状态

- P1C 人工验收：用户已于 2026-09-03 明确放行 `agent/runtime-r4-omp-acp-p1-v1@9728eafdb67d0aea8a2f9e52fd6f315f4e4e7692`。
- P1D-A 目标：把约 802 MB、2.4 万文件的 OMP 完整依赖闭包纳入版本化受信清单；在用户选择的大体积目录中完成空间预检、双重完整性校验和原子激活；让已结算或结果未知的持久请求在安装暂时不可用时仍能安全回放且不重复派发。
- 状态：实现、真实 D 盘完整装配与 ACP 初始化、聚焦测试、Node/Web 类型检查、双轴只读审查和最终阶段门禁已完成；功能提交 `c24504f11c7ca2d4dd80b79e0705c86af437dd12` 已推送当前独立分支，现等待人工验收。
- 工作树：`D:\CodexWorktrees\xiaogui-omp-acp-p1d-a-v1`；分支：`agent/runtime-r4-omp-acp-p1d-a-v1`；基线：已验收 P1C `9728eafdb67d0aea8a2f9e52fd6f315f4e4e7692`。
- 隔离边界：未触碰 WORK 工作树或产品主线；未切换默认 Runtime，未合并、发布或制作 Portable；未修改 `package.json`、README、Renderer 或既有 Kimi 默认生产路径。

### 实际修改文件

- `src/main/xiaogui/agent-runtime/omp-runtime-bundle.ts`
- `src/main/xiaogui/agent-runtime/omp-runtime-bundle.test.ts`
- `src/main/xiaogui/agent-runtime/omp-runtime-storage-config.ts`
- `src/main/xiaogui/agent-runtime/omp-runtime-storage-config.test.ts`
- `src/main/xiaogui/agent-runtime/omp-acp-adapter.ts`
- `src/main/xiaogui/agent-runtime/omp-acp-production.ts`
- `src/main/xiaogui/agent-runtime/omp-acp-production.test.ts`
- `src/main/xiaogui/task-hub/runtime-composition.ts`
- `src/main/xiaogui/task-hub/runtime-composition.test.ts`
- `doc/runtime-r4/OMP-ACP-P1D-A-QA.md`
- `doc/runtime-r4/OMP-ACP-P1D-A-REVIEW.md`
- `doc/runtime-r4/OMP-ACP-P1-EXECUTION-GATES.md`
- `doc/architecture/xiaogui-oh-my-pi-acp-runtime.md`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 新增版本化 `OmpRuntimeBundleManifestV1`，同时固定 OMP 版本、上游 revision、npm archive SRI、入口、安全参数、根 package、依赖锁、完整树、文件/目录/字节总账，以及关键 `pi-natives` 文件摘要；清单不含本机路径。
2. 新增完整树验证器。仅版本相同不再足够；缺依赖、关键 native 缺失、任意内容漂移、符号链接、异常文件类型、超限或目录重定向均 fail-closed。
3. 新增 D 盘友好的受信装配事务：先验源、按实际总账和目标文件系统块大小检查空间、复制到同盘暂存、再验暂存、改名为不可变版本目录，最后原子替换活动指针。失败时旧活动指针和旧版本保持可用，不留下 `.staging-*`。
4. 活动指针、回执和 Runtime 公开结果只含安全相对目录名与摘要，不含选择目录、私有状态目录或入口绝对路径。Runtime 只从当前活动回执解析 OMP；不从 PATH 寻找 OMP。完整树成功结果可在单进程缓存，但每次启动仍重读活动指针/回执并重算所有关键文件摘要，关键 native 被外部篡改会立即 fail-closed。
5. 新增独立的主进程私有存储配置服务，严格保存用户选择的绝对资产目录并以摘要封口；没有复用 Renderer 可读的通用设置存储。
6. 生产 composition 增加显式私有存储目录接缝。未提供目录时返回 `OMP_RUNTIME_STORAGE_DIR_REQUIRED`，不会回退到旧包目录、PATH 或网络下载；桌面当前调用方没有开启它。
7. SQLite 恢复表幂等增加唯一 `request_id` 并真实迁移、回填 P1C 旧行。`createOrResume` 先查持久请求：已结算结果直接返回原终态并复核成功摘要，未结算结果返回但不缓存 UNKNOWN；两者都不检查临时不可用的安装、不启动进程、不重新读取 Prompt，也不重复派发。持久库后来结算后，下次相同请求可读到新终态。
8. D 盘真实完整闭包通过源/暂存/激活三段核对并完成 ACP initialize：24,230 文件、2,144 目录、802,081,247 字节，tree digest 为 `sha256:b1e7aacadfc4791ab7cd092e17b96bfb15781f7b220bfc7eabb7a6d430f98591`，残留暂存目录为 0。

### 未完成内容

- P1D-A 尚待人工验收；没有进入集成线、WORK 主线或正式主线，也没有成为默认 Runtime。
- P1D-B 的文件夹选择、安装进度、空间提示、错误恢复和单机试用 UI 尚未开始；当前只提供主进程私有配置和装配接缝。
- 当前装配输入是已准备好的固定完整闭包目录；自动下载、解包、更新、离线资源和 Portable 不在本阶段。
- 旧活动版本会保留以便恢复，尚未实现经用户确认的磁盘清理策略。
- 没有新增命令/外传白名单，没有扩大三档权限边界，也没有重复真实模型或 Electron 窗口旅程。

### 与规格和冻结决策的偏差

- 无架构偏差：继续复用 OMP/Pi ACP、P1C Adapter、TaskHub Attempt/权限/工作树/结果对账和恢复库；没有第二套 Agent Loop、下载器、权限系统或任务状态机。
- 有意按阶段缩减：P1D-A 只完成主进程装配与恢复接缝，不提前开发 P1D-B Renderer；也不把 802 MB 二进制提交 Git 或塞入发布包。
- 真实门只执行 ACP initialize，不发送模型 Prompt。P1C 已验收真实模型旅程，本阶段没有 Runtime 行为变化需要重复花费模型与窗口测试。

### 测试命令和测试结果

最终聚焦测试：

```powershell
npm run test:unit -- src/main/xiaogui/agent-runtime/omp-runtime-bundle.test.ts src/main/xiaogui/agent-runtime/omp-runtime-storage-config.test.ts src/main/xiaogui/agent-runtime/omp-acp-production.test.ts src/main/xiaogui/agent-runtime/omp-acp-adapter.test.ts src/main/xiaogui/agent-runtime/omp-trusted-installation.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts
```

结果：`6 test files passed`，`27 tests passed`，`4 tests skipped`。跳过项均需显式外部真实环境；P1D-A 的真实完整装配另行执行并通过。

真实 D 盘门：

```powershell
$env:XIAOGUI_OMP_P1D_REAL_BUNDLE='1'
$env:XIAOGUI_OMP_P1D_REAL_BUNDLE_ROOT='D:\CodexCache\xiaogui-omp-runtime-18.1.2-spike'
$env:XIAOGUI_OMP_P1D_STORAGE_DIRECTORY='D:\CodexCache\xiaogui-omp-p1d-a-activated'
$env:XIAOGUI_OMP_P1D_STATE_DIRECTORY='D:\CodexCache\xiaogui-omp-p1d-a-state'
npm run test:unit -- src/main/xiaogui/agent-runtime/omp-runtime-bundle.test.ts
```

结果：`1 test file passed`，`4 tests passed`，退出码 `0`，耗时 `179.96s`；完成完整复制、全树复验、活动回执检查、固定入口版本探测和 ACP initialize，没有调用模型。

类型与差异检查：

```powershell
npm run typecheck
git diff --check
```

结果：Web/Node 类型检查退出码 `0`；差异检查退出码 `0`，只有 Windows LF/CRLF 提示。未运行仓库全量、OMP 上游、WORK/Office 或 Portable 测试。

规格审查修复后的最小追加回归：

```powershell
npm run test:unit -- src/main/xiaogui/agent-runtime/omp-runtime-bundle.test.ts src/main/xiaogui/agent-runtime/omp-acp-production.test.ts src/main/xiaogui/agent-runtime/omp-acp-adapter.test.ts
node node_modules\typescript\bin\tsc -p tsconfig.node.json --noEmit
```

结果：`3 test files passed`，`14 tests passed`，`3 tests skipped`；Node TypeScript 退出码 `0`。该轮验证缓存后的关键 native 篡改仍立即拒绝，以及 UNKNOWN 后来结算时同请求能直接回放终态。

详细数据、边界与风险见 `doc/runtime-r4/OMP-ACP-P1D-A-QA.md`；双轴只读审查及修复闭环见 `doc/runtime-r4/OMP-ACP-P1D-A-REVIEW.md`。

### 审查结果

- Standards 轴：无阻断、无新增工程 smell。
- Spec 轴：首轮发现“缓存后关键 native 篡改可能漏检”和“UNKNOWN 被永久缓存”两个阻断；均已修复并由最小追加回归覆盖，复审阻断数为 `0`。
- 独立代码质量复审：`CLEAR` / `APPROVE`，无阻断项。跨进程安装锁、损坏安装的用户可见修复入口和断电级持久性只作为后续 LOW 风险记录，不在 P1D-A 扩围。
- 最终阶段门禁：`APPROVE`，无真实阻断；只授权提交并推送当前独立分支，随后停止并等待人工验收。

### 已知风险

1. 完整树校验实测约数分钟。生产 inspector 在单进程内缓存一次完整树成功结果，同时每次启动重验活动指针、回执和所有关键文件；非关键依赖在缓存期内发生的外部篡改需通过活动版本切换、显式 fresh 或进程重启发现。
2. 固定闭包源与活动副本合计约 1.60 GB 文件字节；旧版本又会继续占用空间。P1D-B 必须展示动态空间需求，并将清理做成单独人工确认动作。
3. 原子指针使用同文件系统临时文件加 rename，并在回读失败时恢复旧指针；未宣称可覆盖断电和底层文件系统损坏的所有情形。
4. OMP 版本、lock、完整树或 approval envelope 任一升级仍必须重新 Spike 并生成新 manifest，不能沿用 18.1.2 回执。
5. 当前产品入口未读取私有存储配置或显示安装状态；这是 P1D-B 边界，不得把当前候选误称为用户可见成品。

### 下一阶段计划

当前 P1D-A 分支已提交并推送，功能提交的本地与远端 SHA 已复核一致。现在停止施工并等待人工验收；只有用户明确放行后才规划 P1D-B 的目录选择、装配进度和单机试用入口，不自动合并、不切默认 Runtime、不发布。

## 2026-09-03｜RUNTIME-R4 OMP ACP Runtime P1C 真实 Coding、结果对账与恢复

### 本阶段目标与状态

- P1B 人工验收：用户已于 2026-09-03 明确放行 `agent/runtime-r4-omp-acp-p1-v1@a9ee7bc4b18ce8ded6f5fc7fd00d393374cd9589`。
- P1C 目标：让固定 OMP 运行时通过 TaskHub 权限门修改独立 Attempt 工作树；用真实工作树摘要完成 RuntimeOutcomeMonitor、ChangeSet、Delivery 对账；持久化并恢复同一 Attempt、Runtime、vendor session 和工作树；生产启动必须先消费受信安装回执。
- 状态：实现、聚焦测试、真实 OMP 18.1.2 模型旅程、Node/Web 类型检查与双重只读审查已完成；当前为 P1C 阶段候选，等待人工验收。
- 工作树：`D:\CodexWorktrees\xiaogui-omp-acp-p1-v1`；分支：`agent/runtime-r4-omp-acp-p1-v1`；基线：已验收 P1B `a9ee7bc4b18ce8ded6f5fc7fd00d393374cd9589`。
- 隔离边界：未触碰 WORK 工作树或产品主线；未切换默认 Runtime，未合并、发布或制作 Portable；未修改 `package.json`、README 或现有 Kimi 默认生产路径。

### 实际修改文件

- `packages/shared/xiaogui-agent-runtime.ts`
- `src/main/xiaogui/coding-extensions/role-profile-module.ts`
- `src/main/xiaogui/agent-runtime/acp/types.ts`
- `src/main/xiaogui/agent-runtime/acp/process-transport.ts`
- `src/main/xiaogui/agent-runtime/omp-private-layout.ts`
- `src/main/xiaogui/agent-runtime/omp-private-layout.test.ts`
- `src/main/xiaogui/agent-runtime/omp-acp-adapter.ts`
- `src/main/xiaogui/agent-runtime/omp-acp-adapter.test.ts`
- `src/main/xiaogui/agent-runtime/omp-acp-production.ts`
- `src/main/xiaogui/agent-runtime/omp-acp-production.test.ts`
- `src/main/xiaogui/agent-runtime/omp-acp-taskhub-integration.test.ts`
- `src/main/xiaogui/task-hub/runtime-composition.ts`
- `src/main/xiaogui/task-hub/runtime-composition.test.ts`
- `src/main/xiaogui/task-hub/task-candidate-audit.ts`
- `src/main/xiaogui/task-hub/task-candidate-audit.test.ts`
- `doc/runtime-r4/OMP-ACP-P1-EXECUTION-GATES.md`
- `doc/runtime-r4/OMP-ACP-P1C-QA.md`
- `doc/runtime-r4/OMP-ACP-P1C-REAL-SMOKE.md`
- `doc/runtime-r4/OMP-ACP-P1C-REVIEW.md`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 新增显式 `ompProductionEnabled` 生产候选接缝。省略该选项时 OMP 仍保持原测试能力和 `OMP_PRODUCTION_DISABLED`；桌面现有调用方没有开启它，默认 Runtime 与 Kimi 路由不变。
2. 生产启动只接受 `OmpTrustedInstallationModuleV1` 回执派生的固定入口，并固定 `always-ask`、禁用扩展、Skills 和 Rules。生产路径不调用 OMP PATH 探针；固定包或回执缺失、漂移及入口版本不符均停止。
3. OMP 18.1.2 对普通 `edit/write` 的实际 ACP 顺序是先发 `elicitation/create`，批准后才发结构化 `tool_call`。适配层优先保留 ACP 原生结构化权限请求；对该上游缺口只接受一个版本化、精确、单目标的 18.1.2 approval envelope。歧义、多行路径、多目标、截断、错误 schema、错误会话或未知工具全部取消，不做自然语言猜测。
4. 所有允许决定仍由 TaskHub 产生。适配层只把受控的相对目标送入既有权限事件；绝对路径不进入公开事件。命令和数据外传没有权威白名单，继续保持未核验/拒绝。
5. Attempt 启动时把角色模型快照转换为安全 `provider/model` selector，并通过 ACP `session/set_config_option` 固定到 OMP 会话；恢复继续使用持久化请求中的同一 selector，不读取新的全局偏好。
6. 新增 SQLite OMP 恢复存储：绑定公共 Runtime session、私有 vendor session、Attempt、Runtime selection、工作树绑定与安装回执摘要；Outcome 在对外发布成功事件前先持久化。未结算恢复返回 `OUTCOME_UNKNOWN`，不会重复 prompt 或重新派发。
7. `candidateDigest` 改为 TaskHub 捕获的真实 Attempt 结果树摘要。RuntimeOutcomeMonitor、恢复记录、TaskCandidateAudit、TaskChangeSet 和 Delivery 使用同一摘要；Runtime 自报与主机结果不一致时拒绝形成候选。
8. 真实模型旅程已在完整固定 OMP 18.1.2 私有依赖图上通过：只批准 `src/feature.ts`，独立工作树由 `value = 1` 改为 `value = 2`，源项目不变，`git diff --check` 为空，最终 result tree 与 Runtime candidateDigest 一致。
9. 生产装配测试证明：显式开启候选接缝时先消费 trusted-installation inspection、建立持久恢复库且不调用 OMP PATH probe；既有默认装配仍不启用该路径。

### 未完成内容

- P1C 只是独立分支上的生产候选，仍需人工验收；没有进入 WORK 主线、阶段线或正式主线，也没有成为默认 Runtime。
- 完整 OMP 依赖图目前只存在于 D 盘测试缓存。正式安装/升级装配、发布包资源和离线包不在本阶段；仅有主包子树但缺少 `pi_natives` 等依赖时会安全启动失败，不算有效安装。
- TaskHub 尚无命令与数据外传的权威预批准规则，因此三档中相关操作仍不会自动放行。
- 未增加 Renderer UI，也未重复跑 Electron 窗口旅程；本阶段用真实 OMP ACP 子进程加真实 Git/SQLite/TaskHub/Delivery 旅程验证运行时接缝。
- 未运行 OMP 上游全量测试、仓库无关全量测试、WORK/Office 测试或构建 Portable。

### 与规格和冻结决策的偏差

- 无架构偏差：继续复用 OMP/Pi ACP、TaskHub Attempt/权限/工作树/验证/交付和既有 Extension UI；未新增 Agent Loop、权限数据库、模型注册表或任务状态机。
- 上游协议存在已记录的兼容差距：OMP 18.1.2 普通文件工具的结构化 `tool_call` 晚于审批。不能按 toolCallId 先绑定，因此使用与固定版本、固定源码 revision 和 capability digest 绑定的窄解析器；升级 OMP 前必须重新 Spike，不匹配即 fail-closed。
- P1C 的旅程证据有意拆成两段：真实 OMP 子进程证明权限、实际工作树修改、Diff、主机结果摘要和恢复绑定；同一生产接缝的确定性集成测试再证明该摘要进入 CandidateAudit、ChangeSet 与 Delivery。没有把后一段伪称为同一个真实模型进程持续运行到 Delivery。
- 最小验证与原施工卡中的“Electron 可见旅程”有一处有意缩减：P1C 没有 UI 修改，按用户“非必要不要做那么多测试”的要求，以真实 ACP 进程旅程代替重复窗口测试；未把该项伪装为已执行。

### 测试命令和测试结果

聚焦 P1C 回归：

```powershell
npm run test:unit -- packages/shared/xiaogui-agent-runtime.test.ts src/main/xiaogui/coding-extensions/role-profile-module.test.ts src/main/xiaogui/agent-runtime/omp-acp-adapter.test.ts src/main/xiaogui/agent-runtime/omp-acp-production.test.ts src/main/xiaogui/agent-runtime/omp-acp-taskhub-integration.test.ts src/main/xiaogui/agent-runtime/omp-private-layout.test.ts src/main/xiaogui/agent-runtime/omp-trusted-installation.test.ts src/main/xiaogui/task-hub/task-candidate-audit.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts
```

结果：`9 test files passed`，`50 tests passed`，`3 tests skipped`。跳过项均是必须显式提供 D 盘完整安装图或其它外部真实条件的门控用例；没有静默跳过本节所述真实旅程。

真实 OMP 18.1.2 旅程（私有模型配置路径不写入仓库）：

```powershell
$env:XIAOGUI_OMP_P1C_REAL_SMOKE='1'
$env:XIAOGUI_OMP_P1C_REAL_PACKAGE_ROOT='<D盘固定18.1.2完整依赖图中的主包目录>'
$env:XIAOGUI_OMP_P1C_MODELS_JSON='<本机私有模型配置>'
npm run test:unit -- src/main/xiaogui/agent-runtime/omp-acp-production.test.ts
```

结果：`1 test file passed`，`4 tests passed`，退出码 `0`，耗时约 38 秒。相同命令在最终收紧 approval envelope 后复跑通过。

类型和差异检查：

```powershell
npm run typecheck
git diff --check
```

结果：Node/Web 类型检查退出码均为 `0`；差异检查退出码 `0`，只有 Windows LF/CRLF 提示。

详细旅程、原始真实输出、审查结论及环境差异见 `doc/runtime-r4/OMP-ACP-P1C-QA.md`、`doc/runtime-r4/OMP-ACP-P1C-REAL-SMOKE.md` 与 `doc/runtime-r4/OMP-ACP-P1C-REVIEW.md`。

### 已知风险

1. OMP 18.1.2 的普通文件审批不是结构化 toolCall-first 协议。当前窄适配器能 fail-closed，但上游任何消息形状变化都会拒绝写入；升级版本必须重新核对固定源码和真实旅程。
2. 受信回执核验主包固定树；运行还需要同一私有安装根下的完整依赖闭包。缺依赖会在初始化阶段失败，正式装配需要固定并验证完整依赖图，不能把散落的单独 package 目录当安装成果。
3. D 盘完整测试图约 802 MB、约 2.4 万文件，为复验暂时保留；人工验收前不清理。发布装配时应继续放 D 盘缓存并单独记录体积。
4. `supportsResultReconcile: true` 只存在于显式生产候选 selection；尚无产品入口开启该选项，人工验收前不得切为默认。
5. `createOrResume` 当前先确认受信启动可用性，再读取进程内幂等缓存；正常重启由持久恢复库接管。广泛生产启用前仍应复核瞬时安装不可用时的同请求回放语义。
6. 固定 OMP `write` 审批在公开权限事件中按写入型 `edit` 展示；安全策略一致，但未来若 UI 需要区分“创建”和“编辑”，应通过安全枚举扩展，不能暴露原始审批文字。

### 下一阶段计划

等待人工验收 P1C。通过后再单独决定：把完整依赖闭包纳入受信安装/升级装配，并在一个受控集成分支启用 OMP 候选供单机试用。未经新的明确批准，不合并主线、不切默认 Runtime、不制作发布包。

## 2026-09-02｜RUNTIME-R4 OMP ACP Runtime P1B 受信清单、私有模型与三档权限 UI

### 本阶段目标与状态

- P1A 人工验收：用户已于 2026-09-02 明确放行 `agent/runtime-r4-omp-acp-p1-v1@b4f93e561d02673a62bbf7b0d7797bbe41b9d498`。
- P1B 目标：建立固定 OMP 包的完整性回执；复用现有模型配置表单管理 OMP 私有 `models.json`；在 CODING Composer 提供三档权限选择；由 TaskHub 在 Attempt 创建时冻结档位，并在恢复时校验同一绑定。
- 状态：实现、聚焦测试、真实 D 盘固定包清单、Node/Web 类型检查、Electron 构建和真实窗口检查均已完成；当前为 P1B 阶段候选，提交并推送后等待人工验收。
- 工作树：`D:\CodexWorktrees\xiaogui-omp-acp-p1-v1`；分支：`agent/runtime-r4-omp-acp-p1-v1`；基线：已验收 P1A `b4f93e561d02673a62bbf7b0d7797bbe41b9d498`。
- 隔离边界：未触碰 WORK 工作树或产品主线；未改变默认 Runtime、`APPROVED_FOR_TEST`、`OMP_PRODUCTION_DISABLED`、`--approval-mode always-ask`、`package.json` 或发布包。

### 实际修改文件

- `packages/shared/ipc-channels.ts`
- `packages/shared/ipc-contract.ts`
- `packages/shared/xiaogui-coding-extension-pack.ts`
- `src/main/config-store.ts`
- `src/main/ipc/handlers/pi-sdk.ts`
- `src/main/ipc/pi-models-handler.test.ts`
- `src/main/ipc/schemas.ts`
- `src/main/ipc/schemas.xiaogui-runtime.test.ts`
- `src/main/pi-models-json.ts`
- `src/main/xiaogui/agent-runtime/omp-private-layout.ts`
- `src/main/xiaogui/agent-runtime/omp-trusted-installation.ts`
- `src/main/xiaogui/agent-runtime/omp-trusted-installation.test.ts`
- `src/main/xiaogui/coding-extensions/permission-mode-module.ts`
- `src/main/xiaogui/coding-extensions/permission-mode-module.test.ts`
- `src/main/xiaogui/task-hub/execution-orchestrator.ts`
- `src/main/xiaogui/task-hub/execution-orchestrator.test.ts`
- `src/main/xiaogui/task-hub/ipc.test.ts`
- `src/main/xiaogui/task-hub/ipc.ts`
- `src/main/xiaogui/task-hub/runtime-composition.ts`
- `src/renderer/src/features/composer/composer.tsx`
- `src/renderer/src/features/composer/coding-permission-mode-picker.tsx`
- `src/renderer/src/features/composer/coding-permission-mode-picker.test.tsx`
- `src/renderer/src/features/settings/models-settings-panel.tsx`
- `src/renderer/src/features/settings/models-settings-panel.test.tsx`
- `src/renderer/src/locales/en/composer.json`
- `src/renderer/src/locales/en/settings.json`
- `src/renderer/src/locales/zh/composer.json`
- `src/renderer/src/locales/zh/settings.json`
- `doc/architecture/xiaogui-oh-my-pi-acp-runtime.md`
- `doc/runtime-r4/OMP-ACP-P1-EXECUTION-GATES.md`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 以一个共享版本化来源提供三档名称、说明、设置键和策略效果；Composer 只在 CODING 模式显示“逐条确认 / 自动通过 / 完全自主”，活动任务期间不可切换。
2. 全局选择仅在新任务开始时取样。TaskHub 将档位和策略摘要写入执行 Saga，并把 `CodingPermissionModeBindingV1` 不可变绑定到真实 Attempt；重复绑定冲突、缺失绑定或摘要漂移均停止恢复，不会读取后来更改的全局偏好。
3. 文件边界只接受当前 Attempt 清单中的安全相对路径；绝对路径、`.git`、越界或不在清单的文件均拒绝。由于本阶段没有权威命令/外传白名单，命令和外传明确返回 `UNVERIFIED`，即使选择“完全自主”也拒绝，Renderer 无权伪造核验结果。
4. OMP 私有安装、状态和回执路径由 `omp-private-layout.ts` 单一计算。信任根固定为官方 npm archive URL、SHA-512 SRI 及该已验证 archive 的完整解包树摘要；回执固定包名、版本、上游 revision、入口、文件数、体积及私有状态目录摘要。调用方不再能用“版本相同”或自行传入 integrity 常量签收任意目录。
5. 已从 npm 官方 registry 获取 `18.1.2` 固定 archive 到 D 盘，实际 SHA-512 与固定 SRI 相同；官方 archive 解包树与 D 盘 Bun 固定缓存均为 3,136 个文件、48,326,575 字节，且 package、入口和完整树摘要逐项一致。符号链接、异常项、超限、私有状态目录丢失/重定向、回执覆盖和任意内容漂移均拒绝；回执不保存安装绝对路径。
6. 设置页复用既有 Pi SDK `models.json` 校验器和供应商编辑表单，增加“小规默认模型 / Oh My Pi（测试）”目标。OMP 配置写入其私有 `PI_CODING_AGENT_DIR`；界面只显示“小规私有目录”标签，不把绝对路径、配置或凭据放入 TaskHub DTO，也不会重启当前 Pi Worker。
7. 生产装配通过显式偏好读取接缝接入权限模块；未装配该接缝时安全回落“逐条确认”，避免 TaskHub 单测或其他装配隐式初始化桌面全局设置。

### 未完成内容

- 本阶段没有启用 OMP 生产路由。受信回执验证器已经具备，但禁用中的 OMP Adapter 尚未以该回执作为真实启动来源；P1C 在提出生产批准前必须接通并复验，PATH 上只有同版本号的程序仍不能通过生产门。
- TaskHub 还没有可把命令或数据外传认定为 `VERIFIED` 的权威白名单，因此两类操作当前在三档下都保持拒绝；不以关键词或模型自报补齐。
- 尚未完成真实模型“权限申请 → 修改独立工作树 → 验证 → Diff → Delivery”、`candidateDigest` 对账和断线后的同 Attempt/Runtime/vendor session/worktree 旅程；这些属于 P1C。
- 未修改 OMP ACP 会话中的 `model` / `thinking` 动态选择；本阶段只完成其私有模型供应商配置入口。
- 未合并阶段线、未发布、未制作 Portable，也未运行无关 WORK、Office 或 OMP 上游全量测试。

### 与规格和冻结决策的偏差

- 无架构偏差：继续复用 OMP ACP、现有 Renderer 设置/Composer、TaskHub Attempt/权限/Saga 和现有模型校验器；没有第二套 Agent Loop、权限数据库、任务状态机或模型注册表。
- 有意保留的阶段边界：P1B 只生成并验证受信清单，不在生产仍禁用时提前更换 Adapter 启动源；该消费门与真实结果对账一起留给 P1C。
- 有意收紧：P1A 表格描述的是“已核验命令/外传”的最终语义；P1B 因缺少权威白名单把两类状态固定为 `UNVERIFIED` 并拒绝，没有把“完全自主”误实现成无边界放行。

### 测试命令和测试结果

聚焦回归：

```powershell
node node_modules\vitest\vitest.mjs run src/main/xiaogui/coding-extensions/permission-mode-module.test.ts src/main/xiaogui/agent-runtime/omp-trusted-installation.test.ts src/main/xiaogui/task-hub/execution-orchestrator.test.ts src/main/ipc/pi-models-handler.test.ts src/main/ipc/schemas.xiaogui-runtime.test.ts src/renderer/src/features/composer/coding-permission-mode-picker.test.tsx src/renderer/src/features/settings/models-settings-panel.test.tsx packages/shared/xiaogui-coding-extension-pack.test.ts src/main/xiaogui/coding-extensions/permission-policy.test.ts src/main/xiaogui/coding-extensions/permission-module.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts src/main/xiaogui/task-hub/ipc.test.ts --reporter=dot --pool=threads
```

结果：`12 test files passed`，`96 tests passed`，`1 test skipped`。跳过项仅为需要显式提供固定缓存路径的真实包门。

真实 D 盘固定包完整性检查：

```powershell
$env:TEMP='D:\CodexTemp'
$env:TMP='D:\CodexTemp'
$env:XIAOGUI_OMP_TRUSTED_PACKAGE_ROOT='D:\CodexCache\bun-omp-v18.1.2\@oh-my-pi\pi-coding-agent@18.1.2@@@1'
node node_modules\vitest\vitest.mjs run src/main/xiaogui/agent-runtime/omp-trusted-installation.test.ts src/main/xiaogui/coding-extensions/permission-mode-module.test.ts --reporter=verbose --pool=threads
```

结果：`2 test files passed`，`9 tests passed`，真实包完整树生成回执并再次检查成功；测试临时目录位于 D 盘。

信任根来源复核：

```powershell
npm view '@oh-my-pi/pi-coding-agent@18.1.2' dist.tarball dist.integrity --json
npm pack '@oh-my-pi/pi-coding-agent@18.1.2' --pack-destination D:\CodexTemp\omp-trust-root --silent
Get-FileHash D:\CodexTemp\omp-trust-root\oh-my-pi-pi-coding-agent-18.1.2.tgz -Algorithm SHA512
```

结果：registry 返回的 SRI 与代码固定值相同，下载 archive 的 SHA-512 为 `6b3b147ada235324f67be0b20cfba7d8b805ac2b6cf05b67bc195b3ebcd88fa63b51b44891d79baa135956132b3abb9e36746c2deb6a72b63c10fa26c5396f0a`；该 archive 解包后和 D 盘 Bun 缓存分别通过同一完整树门，均为 3,136 文件、48,326,575 字节及同一 `treeDigest`。

类型与构建：

```powershell
node node_modules\typescript\bin\tsc -p tsconfig.node.json --noEmit
node node_modules\typescript\bin\tsc -p tsconfig.web.json --noEmit
node node_modules\electron-vite\bin\electron-vite.js build
```

结果：Node/Web 类型检查退出码均为 `0`；Electron Main、Preload、Renderer 构建成功。构建只出现仓库既有的动态导入和体积提示，没有新增错误。

真实窗口检查：

- 当前独立分支以 CDP `9341` 启动；CODING Composer 能显示并展开三档菜单，实际切换到“自动通过”后可读回设置值，再恢复为“逐条确认”。
- 模型设置页能切换到“Oh My Pi（测试）”，显示私有目录说明且不显示绝对路径；该私有目标为空时不会读取或展示当前 Pi SDK 模型目录。
- 测试结束后已恢复 `currentProject = null`、`xiaoguiCodingPermissionMode = CONFIRM_EACH` 并关闭本分支 Electron 进程。
- 可见证据（不提交仓库）：`D:\CodexTemp\xiaogui-omp-p1b-permission-menu.png`、`D:\CodexTemp\xiaogui-omp-p1b-private-model-settings.png`。

差异检查：`git diff --check` 退出码 `0`；仅有 Windows LF/CRLF 提示。

### 已知风险

1. 受信模块不在运行时联网下载；它以已验证官方 archive 派生的固定完整树作为独立信任根。P1C/发布装配仍必须从固定 archive 复现私有安装，并让 Adapter 在启动前消费回执，不能回退到 PATH 或任意同版本目录。
2. OMP 模型表单沿用现有受信 Renderer 编辑流程；敏感配置落盘只在主进程私有目录，但用户主动编辑时会在设置页内存中短暂存在，不进入对话或 TaskHub。
3. 真实模型、命令核验、外传核验、结果对账和恢复仍未验收，因此 OMP 继续测试专用，不能作为默认或生产 Runtime。

### 下一阶段计划

等待人工或审查 Agent 验收 P1B。通过后进入 P1C：接通受信回执启动源，执行一条真实 OMP Coding 工作树旅程，核对 `candidateDigest`、Diff/Delivery 与同 Attempt/Runtime/session/worktree 恢复；不扩大到 WORK 或发布。

## 2026-09-02｜RUNTIME-R4 OMP ACP Runtime P1A 权限契约与接缝 Spike

### 本阶段目标与状态

- P0 人工验收：用户已于 2026-09-02 明确放行 `agent/runtime-r4-omp-acp-adapter-v1@607618f952b102b889bc12f5ab101f802ab6b401`。
- P1A 目标：把三档权限定义为 TaskHub 拥有的确定性策略，冻结六项生产门的施工与验收映射，并确认 OMP 固定版本的 ACP 模型配置接缝；不提前开放生产 Runtime 或设置 UI。
- 状态：契约、策略接缝、聚焦测试、Node/Web 类型检查和差异检查完成；当前为 P1A 阶段候选，提交并推送后等待人工验收。
- 工作树：`D:\CodexWorktrees\xiaogui-omp-acp-p1-v1`；分支：`agent/runtime-r4-omp-acp-p1-v1`；基线：已验收 P0 `607618f952b102b889bc12f5ab101f802ab6b401`。
- 隔离边界：未触碰 WORK 工作树、产品主线、默认 Runtime、安装包、`package.json` 或 OMP D 盘缓存。

### 实际修改文件

- `packages/shared/xiaogui-coding-extension-pack.ts`
- `src/main/xiaogui/coding-extensions/permission-policy.ts`
- `src/main/xiaogui/coding-extensions/permission-policy.test.ts`
- `src/main/xiaogui/coding-extensions/permission-module.ts`
- `src/main/xiaogui/coding-extensions/permission-module.test.ts`
- `doc/architecture/xiaogui-oh-my-pi-acp-runtime.md`
- `doc/runtime-r4/OMP-ACP-P1-EXECUTION-GATES.md`
- `doc/README.md`
- `doc/README.zh-CN.md`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 新增版本化的 `CodingPermissionModeV1`、`CodingPermissionModeBindingV1` 和 `CodingPermissionPolicyEvaluationV1`，三档中文名称、说明与操作效果由一个共享常量提供，避免 Main 与 Renderer 重复硬编码。
2. 三档语义固定为：逐条确认；已核验读写自动通过而命令/外传询问；所有已核验操作完全自主。任何 `UNVERIFIED` 或 `DENIED` TaskHub 硬边界在三档下都返回拒绝。
3. 现有 `CodingPermissionModuleV1` 增加可选的 TaskHub 策略端口。策略可以自动一次性允许、继续使用原权限对话框或拒绝；策略缺失时完全保留旧行为。
4. 策略结果必须匹配原请求摘要、版本、档位、效果和原因组合；异常、过期或自相矛盾的结果默认拒绝。自动许可仍写入现有权限审计表，没有新增第二套权限数据库。
5. 固定 OMP 继续用 `--approval-mode always-ask`。三档控制位于 TaskHub，不能通过 OMP 的 `write`/`yolo` 绕开 Attempt 工作树、文件清单、命令与外传边界。
6. 实查固定上游 `oh-my-pi@86bf72f`：ACP `session/new/load/resume` 提供 `configOptions`，稳定编号为 `mode`、`model`、`thinking`，并支持 `session/set_config_option`。P1B 将复用此接缝与小规现有模型设置，不另造模型注册表。
7. 把 P0 留下的六项生产门映射为 P1A/P1B/P1C 三批，明确每批验收证据并压缩测试范围。

### 未完成内容

- 本阶段没有实现三档选择 UI，也没有把用户选择冻结到真实 Attempt；这是 P1B 范围。
- OMP 私有 `models.json`、凭据配置、ACP 模型切换、受信安装 receipt 和完整性校验尚未实现；这是 P1B 范围。
- TaskHub 当前尚不能把 OMP 命令和外传认定为已通过完整硬边界；在该接缝完成前，“完全自主”不得自动放行这些操作。
- 真实模型修改、验证、`candidateDigest`、Diff/Delivery 对账和断线恢复仍未完成；这是 P1C 范围。
- OMP 仍为 `APPROVED_FOR_TEST`，生产创建继续返回 `OMP_PRODUCTION_DISABLED`，未改变默认运行时，未制作 Portable。

### 与规格和冻结决策的偏差

- 无架构偏差：继续复用 Pi/OMP ACP、Renderer Extension UI 和 TaskHub；没有第二套 Agent Loop、权限系统、模型注册表或任务状态机。
- 有意保留的阶段差距：P1A 只冻结契约与接缝，不展示尚不能工作的三档 UI；P1B/P1C 未通过前不宣称生产可用。
- 与 OMP 原生三档的差异是安全边界所需：小规不会把 OMP 直接启动为 `write` 或 `yolo`，而是在 OMP `always-ask` 之上由 TaskHub 决定是否自动批准。

### 测试命令和结果

聚焦测试：

```powershell
node node_modules\vitest\vitest.mjs run packages/shared/xiaogui-coding-extension-pack.test.ts src/main/xiaogui/coding-extensions/permission-policy.test.ts src/main/xiaogui/coding-extensions/permission-module.test.ts --reporter=verbose --pool=threads
```

结果：`3 test files passed`，`12 tests passed`。覆盖三档共享来源、12 种已核验策略组合、三档对未核验/拒绝边界的统一拒绝、现有权限交互与规则恢复，以及策略异常 fail-closed。

类型检查：

```powershell
node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit
node_modules\.bin\tsc.cmd -p tsconfig.web.json --noEmit
```

结果：两项退出码均为 `0`。

差异检查：`git diff --check` 退出码 `0`，只有 Windows LF/CRLF 提示。P1A 没有产品 UI 或打包变更，因此按最小测试原则未运行构建、Electron、OMP 上游测试或 P0 真实 ACP smoke。

### 已知风险

1. `CodingPermissionModeBindingV1` 当前只有契约，尚未持久绑定 Attempt；P1B 必须以摘要冲突拒绝和重启恢复证明不可静默切换。
2. “完全自主”能否自动放行命令与外传取决于 TaskHub 是否给出可信 `VERIFIED`；不能用模型分类或 Renderer 状态替代。
3. OMP ACP 模型列表来自其私有运行时状态；P1B 必须复用现有模型配置校验并防止凭据、绝对路径或 vendor session 进入公开 DTO。

### 下一阶段计划

等待人工验收 P1A。通过后进入 P1B：受信安装清单、OMP 私有模型设置、三档 UI、Attempt 冻结绑定和对应重启恢复；只做相关聚焦测试与一次设置页可见冒烟。

## 2026-09-02｜RUNTIME-R4 Oh My Pi ACP Runtime P0 阶段候选

### 本阶段目标与状态

- 目标：把 Oh My Pi 作为独立 ACP Coding Runtime 接到现有 `AgentRuntimeRegistryV1`，证明 Windows 固定版本发现、ACP 握手、新建会话、事件和一次性权限往返；不替换 Pi Worker 或 TaskHub。
- 状态：实现、真实 Windows Spike、聚焦测试、Node/Web 类型检查和双轴审查均已通过；仍为 `APPROVED_FOR_TEST` 阶段候选，等待人工验收。
- 独立工作树：`D:\CodexWorktrees\xiaogui-omp-acp-adapter-v1`。
- 分支：`agent/runtime-r4-omp-acp-adapter-v1`；基线：`xiaogui/feat/xiaogui-integration@f9f333beb0d29d195ca3f63a30ec1ad887e332a5`。
- 隔离边界：没有修改 WORK 活动工作树，没有合并正式产品线，没有改变默认生产 Runtime。

### 实际修改文件

- `src/main/xiaogui/agent-runtime/omp-acp-adapter.ts`
- `src/main/xiaogui/agent-runtime/omp-acp-adapter.test.ts`
- `src/main/xiaogui/agent-runtime/omp-acp-taskhub-integration.test.ts`
- `src/main/xiaogui/agent-runtime/acp/process-transport.ts`
- `src/main/xiaogui/task-hub/runtime-composition.ts`
- `src/main/xiaogui/task-hub/runtime-composition.test.ts`
- `doc/architecture/xiaogui-oh-my-pi-acp-runtime.md`
- `doc/runtime-r4/OMP-ACP-P0-QA.md`
- `doc/runtime-r4/OMP-ACP-P0-REVIEW.md`
- `doc/runtime-r4/evidence/omp-acp-windows-smoke-20260902.txt`
- `doc/README.md`
- `doc/README.zh-CN.md`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 新增 `oh-my-pi-acp` Adapter，复用现有 JSON-RPC/stdio ACP Transport、Runtime Registry、Attempt 工作树、Runtime 事件和 TaskHub 权限契约；没有引入第二套 Agent Loop、权限库或任务状态机。
2. 固定测试来源为 `@oh-my-pi/pi-coding-agent@18.1.2`、tag `v18.1.2@86bf72f52947f62ecaf9bd28e35572812e725a92`，记录 npm SHA-512 integrity 与 MIT 许可证；不修改 `package.json`，不把 OMP 包或缓存装进小规。
3. 默认产品装配会注册 OMP Adapter，但能力只有 `APPROVED_FOR_TEST`；生产创建明确返回 `OMP_PRODUCTION_DISABLED`，生产路由不会选择它，Kimi 默认选择保持不变。
4. 固定 `always-ask`，关闭 OMP Skill/Rules 自动发现；OMP 私有状态目录与用户全局 OMP 目录隔离。小规不提供 ACP Client 终端/写文件能力，写入、命令和外传只生成 TaskHub 一次性权限事件。
5. 权限和事件均绑定当前 vendor session；越出 Attempt 工作树的目标、跨会话请求、`allow_always` 和重复权限证明不会被放行。公开事件只含相对路径和摘要，不含可执行路径、工作树绝对路径、原始命令或 vendor session 编号。
6. 通用 ACP Process Transport Factory 从 Kimi 专名中提取，同时保留兼容别名；既有 Kimi 行为未改变。
7. 修正复审发现的权限形状问题：文件写入事件不再携带 TaskHub 禁止的 `actionDigest`；新增真实 OMP Adapter → Runtime Host → Runtime Monitor → TaskHub Attempt 清单 → `allow_once` 集成回归。
8. 新增显式固定包测试发现：只有设置 `XIAOGUI_OMP_ACP_BUNX_TEST_ENABLED=1` 才调用固定的 bunx 包；普通注册表发现不会隐式下载。Windows 进程树释放会等待 `taskkill`、目标 child `close` 与 stdio 关闭；测试清理只对系统短暂延迟释放的 SQLite/WAL 句柄做有界重试。
9. 权限用途不再依赖标题关键词猜测，只读取 ACP 标准 `kind` 和位置字段；因此本地搜索不会被误判为数据外传，命令、外传和文件写入保持确定性映射。

### 真实测试证据

- Windows x64、Bun `1.3.14`：`bunx --bun @oh-my-pi/pi-coding-agent@18.1.2 --version` 返回 `omp/18.1.2`。
- 真实 stdio ACP `initialize` 成功：协议版本 1、Agent `oh-my-pi/18.1.2`、`loadSession=true`；真实 `session/new` 成功。原始私有 session 编号未写入仓库。
- 可复跑命令与脱敏 stdout：`doc/runtime-r4/evidence/omp-acp-windows-smoke-20260902.txt`；该测试直接经过产品探针的固定 bunx 包分支。审查复跑曾稳定捕获 Windows 句柄释放竞态；修正后完全相同的真实生命周期门连续 3 次通过，总退出码为 0。
- 首次固定包缓存显式落到 `D:\CodexCache\bun-omp-v18.1.2`，实测约 `771.1 MiB`；Git 和小规安装包均不包含该缓存。
- 聚焦回归：`vitest` 运行 OMP Adapter、OMP/TaskHub 权限集成、Runtime Composition、Runtime Registry 和 Kimi Adapter，共 5 个文件、53 项通过；另有 1 项显式真实 OMP 测试在普通回归中按设计跳过，并已用固定环境单独执行通过。
- 共享 ACP Process Transport 的既有聚焦回归：1 个文件、10 项通过；未扩展到 OMP 自身模型、工具或插件测试。
- `node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit`：通过。
- `node_modules\.bin\tsc.cmd -p tsconfig.web.json --noEmit`：通过。
- 审查发现的跨 session 绑定、镜像启动参数、写权限事件形状、真实证据、产品探针发现和 Windows 退出竞态均已修正；最终代码复审为 `WATCH / APPROVE`，规格门为 `PASS / APPROVE`，结论见 `doc/runtime-r4/OMP-ACP-P0-REVIEW.md`。

### 未完成内容、规格偏差与已知风险

- 未完成真实模型的“申请权限 → 修改独立工作树 → 验证 → Diff → 交付”旅程；本阶段只证明 ACP 接缝，不宣称 OMP 可承担生产代码任务。
- OMP 修改结果尚未从真实工作树生成可重启对账的 `candidateDigest`；当前测试证据摘要不得当作正式 ChangeSet。
- 默认探针可核对 `omp/18.1.2`，但不能单凭版本输出证明 PATH 可执行物就是已登记 npm integrity 对应构建；生产装配需要受信安装清单和完整性校验。
- 真实重启恢复、模型凭据/模型选择设置、外传策略实测、设置页、安装包与离线装配均未完成。
- 与“直接接入”的唯一有意偏差是：本批按阶段门只给测试批准，不把 OMP 设为默认或生产批准；这是为保留 TaskHub 结果对账和人工验收边界。
- OMP 与 Kimi 当前仍各自维护部分 ACP 生命周期逻辑；若 OMP 通过生产门，再抽取中性共享 ACP Core，P0 不做高风险重构。

### 下一阶段计划

- 人工验收本 P0 后，单独启动 P1：受信 OMP 安装/完整性清单、私有模型配置、真实模型权限旅程、工作树 ChangeSet 对账和断线恢复。
- P1 通过前不启用生产路由、不新增默认 UI、不制作 Portable、不合入正式产品线。
- 本阶段提交并推送当前独立分支后停止，等待人工或审查 Agent 验收。

## 2026-09-02｜首批 Pi 原生 Skill 安装包装配候选

### 当前状态

- 状态：首批资源、Pi 原生加载接缝、供应链登记、聚焦自动测试、类型检查、生产构建和真实窗口 Skill Catalog 复验已完成；仍为阶段候选，等待正式目录包/安装包与真实模型任务验收及人工批准。
- 正式产品线工作树：`D:\PI\pi-app`，分支 `feat/xiaogui-integration`。
- 实现边界：没有新增 Skill 注册表、中央 PDF/DOC/DOCX 路由、公开 IPC、Agent 可见 Tool 或自定义重试状态机；只把安装包目录传给 Pi 0.84.1 的 `additionalSkillPaths`。

### 首批内容与选型

1. 小规自编 `xiaogui-work-documents`：按读取、归纳、模板整理报告和正式模板等任务意图指导模型选择既有 WORK 工具；工具继续验证真实格式。PDF 仅支持读取、分析和只读模板整理报告，不支持直接生成可编辑正式 Word 模板。
2. 第三方 `internal-comms`：固定 `anthropics/skills@53048666b05b4799081517d00e09e0a2dd688678`，Apache-2.0，携带许可证和示例，仅清理一处行尾空格，用于内部状态汇报、项目更新、FAQ、简报和事件说明。
3. `can1357/oh-my-pi@18781d829586fff77af98b222728b5b29bcaba41` 未采用：其三项 Skill 是开发者 Prompt 元能力，没有文档工作 Skill；PDF 能力属于其重写运行时工具而非 Skill，引入会越过本阶段最小边界。
4. `anthropics/skills` 的 PDF/DOCX Skill 未采用：对应 source-available 条款不允许按小规安装包方式复制、修改和再分发。

### 自动验证与真实窗口证据

- TDD 红灯由缺失的打包路径模块与 Worker 原生接缝触发；最小实现后，路径、Electron Builder 资源映射、Pi 真实 Skill 发现、文档边界和 Worker 传参共 3 个文件、6 项测试通过。
- Pi 真实 `loadSkills` 对两项 Skill 均无诊断；Skill 名称为 `internal-comms` 与 `xiaogui-work-documents`。
- 相关 Skill Catalog、override、IPC 与 WorkerManager 聚焦回归合计 8 个文件、52 项测试通过；`npm run typecheck` 与完整 `npm run build` 通过，构建只有既有动态导入与大 chunk 提示；`git diff --check` 通过。
- 真实开发窗口在 Windows 原生 Worker 初始化后，`ipc:skills.list` 返回 `complete: true`；两项内置 Skill 均为 `enabled: true`、`effective: true`、`diagnostics: []`，设置页搜索显示“`xiaogui-work-documents` 生效”。截图保存在本机审计区 `D:\CodexTemp\xiaogui-bundled-skill-window-20260902.png`。
- 权威设计与候选审查见 `doc/architecture/xiaogui-bundled-pi-skills.md`，第三方来源见 `THIRD_PARTY_NOTICES.md`。

### 未完成门

- `electron-builder --dir` 在当前工作树的临时 junction 修复版 `node_modules` 中停在既有依赖遍历，未进入 Skill 资源复制阶段，已停止；源码路径与 `extraResources` 映射已有自动测试，但正式目录包/安装包仍须在完整干净依赖和既定 LibreOffice 私有运行时装配环境复验。
- 尚未用真实模型执行“按意图选择并读取 Skill、再调用受控文档工具”的完整任务；本条不宣称模型任务或发布包已经验收。
- 本条仍是阶段候选；自动测试与开发窗口 Catalog 不能替代最终人工批准。

## 2026-09-02｜Pi 原生、Skill 与插件优先规则确立

### 当前权威结论

- 状态：用户已批准，作为所有后续功能开发的仓库级强制前提。
- 每开发一个功能前，必须先实查 Pi 原生能力、可用 Pi Skill 和 Pi 插件/Extension/Package，并对最接近候选执行真实任务冒烟。
- Pi 原生、Skill 或插件能够完成任务时，只做选型、必要适配、固定版本、安装包装配和验收；框架层不重复开发。
- 只有留下可复核的产品、安全、合规、离线、进程隔离或确定性专业计算缺口，并证明 Skill 编排、插件配置及声明式 Adapter 仍不足后，才可提出最小框架修改并等待批准。
- 根 `AGENTS.md` 是每个 Agent 的强制入口；完整决策见 `doc/adr/ADR-PI-NATIVE-SKILL-PLUGIN-FIRST.md`。

### 对旧 WORK P1 的覆盖

- 2026-08-31 登记的中央 PDF/DOC/DOCX 自动路由、`WORK-P1-DOCUMENT-TYPE-ROUTING-01` 和统一附件令牌化方案已被本决策取代，不再作为待施工框架功能。
- 文档任务改为复用 Pi 原生 Skill/插件发现与 Agent Loop：模型根据用户意图和清晰说明选择能力，各工具自行校验真实文件格式并返回明确错误。
- 后续若通过 Skill/插件补充普通文档整理，PDF 的范围仅限只读模板整理报告；PDF 直接生成可编辑正式 Word 模板不在当前范围。本条不宣称该 PDF 报告链路已经实现。
- 历史阶段条目保留当时事实与证据；凡与本节冲突的“下一阶段计划”均视为历史方案，不得据此启动框架施工。

### 本次文档改动边界

- 新增并纳入版本控制的根 `AGENTS.md`。
- 新增正式 ADR，并接入 `doc/README.md` 与 `doc/README.zh-CN.md`。
- 不修改产品代码、Agent 可见工具、Capability、Prompt、IPC、模板状态机、Office/Univer 或 TaskHub。

## 2026-09-02｜WORK/CODING 集成与 Prompt A1—B5 人工验收通过并进入正式主线

### 入线状态

- 人工验收：2026-09-02 用户明确确认通过，并授权进入主线。
- 正式产品线：`feat/xiaogui-integration`。
- 已验收来源：`codex/coding-work-integration-v1@52432efc1b9b11b1df313e22f69571193f28a929`。
- 普通合并提交：`9d516c23b937517baca980ab1685c5ee2f4ce020`；两个父提交分别为原正式主线 `0820b64297ddb38fae41c3241cf37f5b36abf306` 与已验收来源 `52432efc1b9b11b1df313e22f69571193f28a929`。
- 合并方式：在隔离晋级工作树执行 `--no-ff` 普通合并；无冲突，合并树与已验收来源树完全一致。
- 合并后验证：Prompt、intake、长文件名入口与 CODING 角色链路共 14 个文件、134 项测试通过；`npm run typecheck` 与 `npx electron-vite build` 通过，构建仅有既有动态导入提示；`git diff --check` 通过。
- 发布边界：本次只表示源码进入正式产品线；未制作新的 Portable、安装包或正式发布版本。

### 验收范围

1. WORK 与完整 CODING Extension Pack 集成，以及新会话默认受控 `EXECUTE`。
2. A1：模板整理子模型 `riskFlags` 八值契约与一次 repair。
3. A2：长中文 `.doc` 快捷入口与能力选择解耦。
4. A3：封闭式 sticky 确认语法及真实成功结果续接门。
5. B1/B2/B3/B5：共享路径规则、文档术语、工具 guideline 结构化、Runtime Facts 去噪与旧版 DOC 转换错误码拆分。
6. B4：CODING 三角色五段式 Prompt、旧默认 digest 精确迁移、用户修改保留、迁移幂等及新旧 Attempt 快照隔离。

### 保持不变

- Prompt 六层组装顺序、模板领域状态机、Office/Univer、DOCX 降级路径、TaskHub、安全门、数据库表结构和 Agent 可见 Tool 集合均未因最终入线追加修改。
- 既有阶段条目保留其当时的“候选/未验收”历史描述；本条是覆盖这些历史状态的最新结论。

## 2026-09-02｜Prompt 分层优化 B4：CODING 默认角色 Prompt 与兼容迁移

### 阶段状态

- 状态：实现、TDD、角色链路聚焦回归、全套件复验、typecheck、生产构建和差异检查均已完成；本分支为阶段候选。
- 当前分支：`codex/coding-work-integration-v1`。
- 起点：`1e9f7ab`（B1/B2/B3/B5 与 DOC 错误码拆分候选）。
- 本地工作树：`D:\CodexWorktrees\xiaogui-coding-work-integration-v1`。
- 验收边界：B4 使用独立提交；B1—B5 全包完成后仍停在人工验收门，未进入主线或正式发布。

### 已完成内容

1. 研究、实现、审阅三个内置默认角色均改为五个固定段落：目标、允许、禁止、输出契约、验证与批准；既有 `profileId`、用户可见名称/摘要和工具白名单不变。
2. 研究角色只读定位实现、来源与证据，明确区分事实、推断和未知，不修改也不宣称验收；实现角色只在批准任务、文件范围和独立工作树内修改，禁止扩范围、绕门和提交敏感文件，并报告修改、验证与残余风险；审阅角色只读审查真实 diff 与验证证据，按严重度给出文件位置、影响和复现，无发现时仍报告未覆盖风险，不修改或替代人工批准。
3. 上一版三个默认草稿作为私有迁移源保留，并建立按 `profileId` 的显式旧默认 → 新默认映射。初始化在 `begin immediate` 事务内处理：缺失行插入新默认；仅当存量 `profile_digest` 精确等于旧默认 digest 时更新；其他行保持不变。
4. 迁移幂等，第二次启动不重复更新时间；用户修改过的默认角色和自定义角色保留，既有 Attempt 冻结快照不变，新 Attempt 使用新 digest。
5. `resetDefault` 恢复新的五段默认 Prompt；列表摘要和普通 IPC 响应继续不含 Prompt 正文，只有既有显式编辑和私有 Attempt 快照接缝可读取正文。
6. 未增加数据库列，未改变 Renderer 可见摘要、Prompt 正文隐私边界、Attempt 快照结构或 Runtime 工具权限。

### 红绿证据与自动验证

- 默认角色五段结构测试先稳定失败，因为旧默认没有任何段落标题；最小替换默认正文后转绿。
- 精确旧 digest 迁移测试先稳定失败，因为原初始化只执行 `insert or ignore`；加入事务迁移后转绿。
- 角色聚焦回归：9 个文件、42 项测试全部通过，覆盖全新数据库、三个旧默认迁移、用户修改保留、自定义角色保留、迁移幂等、`resetDefault`、新旧 Attempt 快照隔离、生产装配、Worker 角色绑定与 IPC 隐私边界。
- 默认并发全套件：401 个文件通过、2 个跳过；4 个既有 TaskHub Git/SQLite 文件中的 8 项测试因 5 秒超时并伴随 Windows `EBUSY` 失败。相关 4 文件单 worker 隔离复跑 `40/40` 通过，未修改 TaskHub。
- `npm run typecheck`：通过。
- `npx electron-vite build`：通过；只有既有动态导入提示，无构建错误。
- `git diff --check`：通过；仅有 Windows LF → CRLF 提示，无空白错误。
- 随全套件执行的 Builder 回归继续保证产品 Prompt 不超过 7000 字、Runtime Facts 不超过 600 字、Manifest SHA 与真实正文一致。

### 未完成与人工验收门

- B1—B5 均为分支阶段候选，尚未进入主线或正式发布；代码与自动验证不能替代审阅及人工批准。
- 未修改 Prompt 六层组装顺序、模板领域状态机、Office/Univer、DOCX 降级、TaskHub、安全门、数据库表结构、主线分支或 Agent 可见 Tool 集合。

## 2026-09-02｜Prompt 分层优化 B1/B2/B3/B5：规则归组、术语、Builder 去噪与 DOC 错误拆分

### 阶段状态

- 状态：实现、TDD、聚焦回归、全套件复验、typecheck、生产构建、Prompt 预算/SHA 与文档同步均已完成；本分支为阶段候选。
- 当前分支：`codex/coding-work-integration-v1`。
- 起点：`d02f62ffc9e6d6eb206ae0a2e09590dcdc4663b1`（A3 已推送候选）。
- 本地工作树：`D:\CodexWorktrees\xiaogui-coding-work-integration-v1`。
- 验收边界：本条提交完成 B1/B2/B3/B5 及追加的 DOC 错误码拆分；B4 默认角色 Prompt 与兼容迁移使用下一条独立提交。全部仍未进入主线或正式发布。

### 已完成内容

1. Capability Registry 升至 `1.1.0`；受影响的四个 WORK Capability 与 Prompt Layer 升至 `1.1.0`，Runtime Tool 兼容层升至 `0.84.1-compat.2`，Runtime Facts 升至 `1.1.0`。
2. Tool Prompt 定义新增共享规则引用、`usage.when/whenNot` 与 `protocol.sequence/output`；Pi 继续消费同源派生的扁平 `promptGuidelines`，没有改变工具注册接口。
3. “系统选择器代替索要路径”“不泄漏内部运行细节”“成果另存且不覆盖来源”按稳定 ID 登记；Runtime 与 Prompt Catalog 各只渲染一次共享正文，并按工具名输出“何时调用/不调用”和“调用协议”。
4. 标准报告工具加入 schema 合法的最小 PREPARE 示例；模板 Word 工具只示范先 `SELECT_TEMPLATE`，再原样使用返回的真实 `fieldId`，不提供伪字段编号。
5. WORK 文档术语收敛为“普通成品文档、模板整理、模板整理报告、候选内容、正式模板、成品文档”；“只读/已确认”只表示报告状态。首页入口标题“整理普通文档”和选择器既有同义词保持不变。
6. Runtime Facts 删除实际 Tool 数量，不改为工具名列表；Manifest 继续保存真实 `toolNames`，完整 Prompt 字符数和 SHA-256 仍从真实正文生成。
7. intake 新增 `TEMPLATE_INTAKE_CONVERSION_UNAVAILABLE`：Renderer 的 `LEGACY_DOC_CONVERSION_UNAVAILABLE` 映射到“运行时未安装或未装配”，`LEGACY_DOC_CONVERSION_FAILED` 保持映射为“组件已可用但本次转换失败”。转换器、模板状态机和 DOCX 降级路径未改。
8. `doc/architecture/xiaogui-prompt-inventory.md` 与 `xiaogui-prompt-phase-gates.md` 已同步版本、术语、规则归组、Runtime Facts 和 DOC 错误边界。

### 红绿证据与自动验证

- 公开契约、Builder、Session Extension、Prompt Catalog、工具输出、intake Service 与 Host adapter 均先建立稳定红灯，再做最小实现；最终聚焦回归 9 个文件、97 项测试全部通过。
- 默认并发全套件：400 个文件通过、2 个跳过；5 个既有 WorkerManager/TaskHub Git-SQLite 文件中的 7 项测试因 5 秒超时并伴随 Windows `EBUSY` 失败。相关 5 文件单 worker 隔离复跑 `71/71` 通过，未修改 TaskHub。
- `npm run typecheck`：通过。
- `npx electron-vite build`：通过；只有既有动态导入提示，无构建错误。
- `git diff --check`：通过；仅有 Windows LF → CRLF 提示，无空白错误。
- Builder 回归继续保证产品 Prompt 不超过 7000 字、Runtime Facts 不超过 600 字、Manifest 保留真实工具名且 SHA 与完整正文一致。

### 未完成与人工验收门

- 本阶段候选等待与 B4 一起完成人工验收；尚未进入主线或正式发布。
- 本条提交不含 B4 默认角色 Prompt 与兼容迁移；后者必须验证全新数据库、精确旧 digest 迁移、用户修改保留、幂等、resetDefault 与新旧 Attempt 快照隔离。
- 未修改 Prompt 六层组装顺序、Base Layer 原文、模板领域状态机、Office/Univer、TaskHub、IPC 安全门、数据库表结构、主线分支或 Agent 可见 Tool 集合。

## 2026-09-02｜Prompt 分层优化 A3：封闭式 sticky 确认语法

### 阶段状态

- 状态：实现、TDD、全套件复验、typecheck、生产构建、Prompt 预算/SHA 回归均已完成；本分支为阶段候选，随本阶段提交推送后停在人工验收门。
- 当前分支：`codex/coding-work-integration-v1`。
- 起点：`bbe09bbdda3d2e9797b1e8c1e7ec7ff296f90a8b`（A2 已推送候选及旧版 DOC 转换运行时诊断起点）。
- 本地工作树：`D:\CodexWorktrees\xiaogui-coding-work-integration-v1`。
- 验收边界：仅完成 A3；B1/B2/B3/B5、B4 均未开始。本阶段未进入主线，也未取得正式发布验收。

### 已完成内容

1. sticky 短确认统一执行 `NFKC → 去首尾空白 → 合并空格 → 去末尾句号/问号/感叹号`；规范化后按 Unicode 字符计数不超过 24 字，并使用完整字符串匹配。
2. 核心短语固定为：`看起来可以`、`可以`、`可以生成`、`可以生成了`、`确认`、`确认生成`、`生成吧`、`继续`、`没问题`、`就这样`、`保存`、`开始复核`、`复核`、`打开复核卡`。
3. `好`、`好的` 仅允许作为礼貌前缀，且必须以逗号或空格与核心短语分隔；否定、暂缓、附加修改意图及 `取消`、`打开文件`、`修改后再生成` 等新意图不会命中。
4. PREPARE 类工具的公开引导统一为“如确认继续，请单独回复‘确认’。”；intake START 成功生成报告后的引导统一为单独回复“复核”或“打开复核卡”。
5. materialize 继续以预览确认按钮和私有确认令牌为主，聊天确认只保留既有后备路径；没有改模板状态机或 Host 的跨 Run/Session 安全门。
6. sticky 生命周期保持不变：仅真实成功结果建立、只消费下一轮一次，失败或取消不建立；Worker 真实 turn 生命周期回归改用新增礼貌短语验证该约束。
7. 权威 Prompt 文档已同步确认语法、工具引导和边界；B 类工作包新增强制项：把旧版 DOC 转换“LibreOffice 未安装/未装配”与“组件已存在但转换失败”拆成不同的 intake 公开错误码和准确文案，不在 A3 顺手改转换链路。

### 红绿证据与自动验证

- 按 TDD 在公开能力选择器和公开工具输出接缝逐项制造稳定红灯：`可以生成`、`可以生成了`、`好的，可以生成了`、全角句号归一化，以及 report/template-data/advanced/intake/materialize/兼容 DOCX 的确认引导均先失败后以最小实现转绿。
- 允许短语全矩阵、礼貌前缀矩阵和负例矩阵均已覆盖；负例包含 `不要确认`、`暂时不可以生成`、`可以先别生成`、`继续解释，不要保存`、`好的，可以生成了，但先改标题` 等。
- A3 最终聚焦回归：10 个测试文件、105 项测试全部通过；Builder 预算/SHA 专项 2 个文件、9 项测试通过。
- 默认并发全套件：400 个文件通过、2 个跳过；4 个 TaskHub Git/SQLite 文件中的 6 项测试因 5 秒超时并伴随 Windows `EBUSY` 失败。相关 4 文件单 worker 隔离复跑 `40/40` 通过，未修改 TaskHub。
- 完整单 worker 复验：404 个测试文件通过、2 个跳过；2342 项测试通过、2 项跳过。
- `npm run typecheck`：通过。
- `npx electron-vite build`：通过；只有既有动态导入提示，无构建错误。
- `git diff --check`：通过；仅有 Windows LF → CRLF 提示，无空白错误。
- Prompt 预算/SHA 回归继续保证产品 Prompt 不超过 7000 字、Runtime Facts 不超过 600 字、Manifest SHA 与真实正文一致。

### 未完成与人工验收门

- A3 候选等待人工验收；尚未进入主线或正式发布。
- B 类工作包尚未开始；必须连同 Prompt 一致性与 Builder 去噪实施上述旧版 DOC 转换错误码拆分项。
- A3 是确定性的选择器、工具契约和 Worker turn 生命周期变更，本阶段未新增真实 Electron 长旅程；真实窗口中的 materialize 主路径仍以既有预览按钮和私有令牌为准。
- 未修改 Prompt 六层组装顺序、模板领域状态机、Office/Univer、DOCX 降级、TaskHub、IPC 安全门、数据库结构、主线分支或 Agent 可见 Tool 集合。

## 2026-09-01｜Prompt 分层优化 A2：快捷入口与能力选择解耦

### 阶段状态

- 状态：实现、TDD、全套件复验、typecheck、生产构建、Prompt 预算/SHA 回归和真实 Electron 窗口验证均已完成；本分支阶段候选，随本阶段提交推送后停在人工验收门。
- 当前分支：`codex/coding-work-integration-v1`。
- 起点：`c36ec0a2a0cbdf54678dea85d0dacf1f31a5019a`（A1 已推送候选）。
- 本地工作树：`D:\CodexWorktrees\xiaogui-coding-work-integration-v1`。
- 验收边界：仅完成 A2；A3、B1/B2/B3/B5、B4 均未开始。本阶段未进入主线，也未取得正式发布验收。

### 已完成内容

1. WORK 首页“整理普通文档”快捷消息固定为：`请使用普通文档模板整理能力，把普通成品文档整理成可复用模板。我刚选择的文件是“${fileDisplayName}”。请立即开始只读分析并生成模板整理报告，不要再次让我选择文件；原文档不得修改。`
2. 完整能力触发句现在位于显示文件名之前，长文件名不再占用本地选择器的触发跨度；公开消息只含显示名，不含绝对路径。
3. `xiaogui.turn-capability-selector.v1` 升级至 `1.1.0`。既有最多 24 字正则跨度和用户同义词保持不变，没有通过扩大到 64 字换取命中。
4. Renderer 回归使用超过 22 个中文字符的 `.doc` 显示名，捕获真实快捷消息后直接送入公开 `selectXiaoguiTurnCapabilitiesV1`，断言选择 `work.file-organize` 与 `work.template-intake`。
5. 长 `.docx` 只作为扩展名命中路径的非回归用例；Worker 首轮回归确认 Manifest 同时包含 `work.template-intake` 和模板 intake Tool。
6. `doc/architecture/xiaogui-prompt-inventory.md` 已同步选择器版本、固定快捷消息、24 字跨度边界和 Main 私有路径约束。

### 红绿证据与自动验证

- 红灯一：长中文 `.doc` Renderer 用例先得到 `1 failed / 10 passed`；旧消息经公开选择器返回 `DEFAULT_ONLY`，只保留 `work.file-organize`。仅调整消息顺序后 `11/11` 转绿。
- 红灯二：先要求选择器发布 `1.1.0`，聚焦测试得到 `1 failed / 18 passed`（实际仍为 `1.0.0`）；只更新版本常量后 `19/19` 转绿。
- 最终聚焦回归：5 个测试文件、61 项测试全部通过，覆盖 Renderer 长 `.doc`、公开选择器、长 `.docx` 非回归、Worker Manifest、行为夹具和 Builder。
- 默认并发全套件：399 个文件通过，4 个文件中的 5 项 TaskHub Git/SQLite 集成测试因 5 秒超时并伴随 Windows `EBUSY` 失败；相关 4 文件单 worker 隔离复跑 `40/40` 通过。
- 完整单 worker 复验：403 个测试文件、2308 项测试全部通过；2 个真实环境 smoke 按设计跳过。
- `npm run typecheck`：通过。
- `npx electron-vite build`：通过；只有既有动态导入提示，无构建错误。
- Builder 预算/SHA 专项：2 个文件、13 项测试通过，继续保证产品 Prompt 不超过 7000 字、Runtime Facts 不超过 600 字、Manifest SHA 与真实正文一致。

### 真实 Electron 窗口证据

1. 使用无敏感内容的公开政策类旧版 DOC，并在外部审计目录复制为超过 22 个中文字符的 `.doc` 显示名；证据文件和截图未进入 Git。
2. 经 Windows 原生文件选择器选中后，真实页面自动发送固定快捷消息；页面与会话用户消息均只出现显示文件名，没有绝对路径。
3. `ipc:runtime.getState` 的真实 Effective Prompt Manifest 中，`capabilityIds` 包含 `work.template-intake`，`toolNames` 包含 `xiaogui_work_docx_template_intake`。
4. 真实会话 JSONL 记录模型调用 `xiaogui_work_docx_template_intake {"action":"START"}`，证明长 `.doc` 从 Renderer 入口到公开选择器、Manifest 和首个 Tool 调用的链路成立。
5. 本机缺少可用的旧版 DOC 转换组件，Host 随后返回 `TEMPLATE_INTAKE_CONVERSION_FAILED`；界面明确报告未生成整理报告、原文档未修改。该安全失败不冒充模板分析成功，也不影响 A2 的选能与 START 验证结论。

### 未完成与人工验收门

- A2 候选等待人工验收；尚未进入主线或正式发布。
- 旧版 DOC 成功转换、报告内容质量和复核卡旅程不在 A2 的接口修复范围内，本轮没有伪造成功证据。
- A3 sticky 确认语法、B 包 Prompt 一致性/Builder 去噪及 B4 默认角色迁移必须另阶段启动。
- 未修改 Prompt 六层组装顺序、模板领域状态机、Office/Univer、DOCX 降级、TaskHub、IPC 安全门、数据库结构、主线分支或 Agent 可见 Tool 集合。

## 2026-09-01｜Prompt 分层优化 A1：intake `riskFlags` 契约

### 阶段状态

- 状态：实现、TDD、全套件、typecheck、生产构建和 Prompt 预算/SHA 回归均已完成；本分支阶段候选，提交并推送后停在人工验收门。
- 当前分支：`codex/coding-work-integration-v1`。
- 起点：`671290c784cf8192211e76e1a7d5a73433f844ed`。
- 本地工作树：`D:\CodexWorktrees\xiaogui-coding-work-integration-v1`。
- 验收边界：仅完成 A1；A2、A3、B1/B2/B3/B5、B4 均未开始。本阶段未进入主线，也未取得正式发布验收。

### 已完成内容

1. 新增运行时唯一事实源 `TEMPLATE_INTAKE_RISK_FLAGS_V1`，固定八个合法值，并增加同源中文标签映射；`TemplateIntakeRiskFlagV1` 由常量派生。
2. Worker Tool 的 TypeBox、模型输出 Zod 与 Main host-tool Zod 全部由共享常量派生，不再维护三份枚举副本。
3. `template-intake-analysis` 升级至 `1.2.0`：系统 Prompt 明列中英文合法值和“无风险时为空数组”，严格 JSON 示例只使用合法值。
4. 一次性 repair 明确把非法 `riskFlags` 视为结构错误，并复用与系统 Prompt 完全相同的枚举说明；第二次仍非法时继续走既有安全降级。
5. Prompt Catalog 展示 `template-intake-analysis@1.2.0`；Builder 回归确认该临时子模型 Prompt 不进入产品 System Prompt，因此未改主 Builder 固定哈希。
6. `doc/architecture/xiaogui-prompt-inventory.md` 已同步独立子模型边界、版本和单一事实源要求。

### 红绿证据与验证结果

- 红灯一：先把版本/枚举说明契约改为 `1.2.0`，聚焦测试稳定得到 `1 failed / 7 passed`（实际仍为 `1.1.0`）。最小实现后 `8/8` 转绿。
- 红灯二：先要求 repair 复用同一枚举说明，聚焦测试稳定得到 `1 failed / 7 passed`。补齐 repair 后 `8/8` 转绿。
- 最终聚焦回归：4 个测试文件、36 项测试全部通过，覆盖八值/中文映射、TypeBox 描述派生、合法与非法值、一次 repair、安全降级、Catalog 版本和产品 Prompt 隔离。
- 默认并发全套件首次运行：399 个文件通过，4 个文件中的 5 项 Git/SQLite 集成测试因 5 秒超时并伴随 Windows `EBUSY` 失败；相关 4 文件单 worker 隔离复跑 `40/40` 通过。
- 完整单 worker 复验：403 个测试文件、2307 项测试全部通过；2 个真实环境 smoke 按设计跳过。该结果排除了默认并发临时资源争用。
- `npm run typecheck`：通过。
- `npx electron-vite build`：通过；只有既有动态导入提示，无构建错误。
- Builder 预算/隐私测试：产品 Prompt 不超过 7000 字、Runtime Facts 不超过 600 字，Manifest SHA 由真实正文生成且子模型 Prompt 不混入产品层。
- `git diff --check`：提交前执行；仅允许 Windows LF → CRLF 提示，不允许空白错误。

### 未完成与人工验收门

- A1 不改变 Renderer、真实窗口交互或 Tool 调用时序，因此本阶段没有新增真实窗口旅程；人工验收重点为 Prompt Catalog 文案、模型合法 `riskFlags` 输出及非法输出降级行为。
- A2 长 `.doc` 快捷入口、A3 sticky 确认语法、B 包 Prompt 归组/去噪以及 B4 默认角色迁移必须在本阶段提交、推送、远端 SHA 和干净工作树确认后另阶段启动。
- 未修改 Prompt 六层组装顺序、Office/模板状态机、Univer、DOCX 降级、TaskHub、IPC 安全门、数据库表结构或主线分支。

## 2026-09-01｜WORK研究 P0 续：普通文档能力未加载双根因修复

### 阶段状态

- 状态：实现、回归、typecheck、全套件和真实窗口终验全部完成；提交并推送后等待人工验收。
- 当前分支：`codex/coding-work-integration-v1`。
- 起点：`1034d40f10ca5825e06c7c8d9f516427e7852808`（与上一阶段相同；上一阶段修改未提交，本轮一并提交）。
- 本地工作树：`D:\CodexWorktrees\xiaogui-coding-work-integration-v1`。
- 边界：只修复工具加载链路的两个断点；未修改模板状态机、Univer、DOCX 降级路径、CODING TaskHub、IPC 安全门；未做意图识别/模式推荐/自动切换。

### 本阶段目标

修复“WORK 普通文档模板整理能力未被模型加载”：上一轮真实窗口表现为模型全程不调 `xiaogui_work_docx_template_intake`。本轮定位出两个叠加根因并分别最小修复，最终在真实 Electron 窗口里完成真实 DOCX 的 intake 调用闭环。

### 根因与修复

1. 根因一（`role-runtime-binding.ts`）：`06c410b` 引入的 `CodingRoleRuntimeBindingV1.activeToolNames` 在无角色绑定时把工具集坍缩为 `['read']`。角色绑定只可能存在于 CODING 角色 Attempt 期间，WORK/DESIGN 会话永远走无绑定分支，导致每轮激活工具被清空。修复：无绑定时透传，安全仍由工具/权限/worktree/交付门强制。
2. 根因二（`worker-runtime.ts`）：Pi SDK 的 `createAgentSessionFromServices({ tools })` 选项同时是注册表白名单（`allowedToolNames = options.tools ?? ...`）与初始激活集。原代码按空输入上下文算出首轮默认集（WORK 下仅 `read`、`xiaogui_read_pdf`、`xiaogui_work_read_materials` 3 个）传入 `tools`，把 intake/materialize 等能力工具永久踢出注册表；per-turn `setActiveToolsByName` 对未注册名静默忽略。修复：`tools` 传本模式候选全集保住注册表，会话创建后再按首轮策略收窄初始激活集（两处均有中文注释说明 SDK 语义）。

### 实际修改文件

- `src/worker/worker-runtime.ts`（根因二）
- `src/worker/xiaogui-coding-extensions/role-runtime-binding.ts`（根因一）
- `src/worker/handlers/worker-runtime-tool-registry.test.ts`（新增回归：钉住 tools=模式全集 + 创建后收窄到首轮默认集 + override 链注册含 intake/materialize）
- `src/worker/xiaogui-coding-extensions/role-runtime-binding.test.ts`、`src/worker/handlers/worker-handlers-turn.test.ts`、`src/worker/xiaogui-prompt/behavior-fixtures.test.ts`、`src/worker/xiaogui-prompt/session-extension.test.ts`（同步断言）
- 上一阶段未提交的 9 个文件（WORK 入口模式绑定、停用模式推荐、prompt 清单）随本轮一并提交

### 证据链

1. 真实会话 JSONL 复盘：上一阶段真实窗口的 Effective Prompt Manifest mode layer 已是 WORK，但注册表仅 3 个默认工具。
2. headless 复现（`PI_WORKER_STDIO=1 node out/main/worker.mjs`，stdin JSONL init+prompt）：修复前 registered 仅 3 工具；修复后 registered 9 工具、active/actual 5 工具（含 intake/materialize）。修复后最终 headless 运行中模型直接调用 intake。
3. 全套件 2307 passed / 0 failed；`npm run typecheck` 通过；`npx electron-vite build` 通过。
4. 真实 Electron 终验（dev + CDP 9333，工作区 `3817f40b`）：
   - 点击“整理普通文档”→ 原生选择器选真实 `personal-summary.docx` → 暂存并自动提交快捷文本；
   - `ipc:runtime.getState` 的 `promptDiagnostics.manifest`：`capabilityIds` 含 `work.template-intake`，`toolNames` 为 5 工具（`read`、`xiaogui_read_pdf`、`xiaogui_work_docx_template_intake`、`xiaogui_work_docx_template_materialize`、`xiaogui_work_read_materials`）；
   - 会话 JSONL 记录模型真实调用 `xiaogui_work_docx_template_intake {"action":"START"}`，host 返回真实解析结果（4 项候选：可变字段 3、固定内容 1；2 条警告），模型输出只读报告摘要；
   - 全程无 `XIAOGUI_MODE_WORKER_REBUILD_FAILED: Worker not started`。

### 未完成内容与剩余风险

- 模板复核卡交互（打开/逐项确认/批量调整）未在本轮走完，留作人工单机试用验收。
- 候选内容质量、警告措辞等业务正确性由人工验收判断；本轮只验证能力加载与调用链路。
- 原生文件对话框的自动化驱动（Win32 `WM_SETTEXT` + `BM_CLICK`）只是本轮验证手段，不是产品代码。

### 测试命令和测试结果

```powershell
npm run typecheck                      # 通过
npx vitest run                         # 2307 passed / 0 failed（一次 flake 复跑不复现）
npx electron-vite build                # 通过
npm run dev -- --remoteDebuggingPort 9333   # 真实窗口终验：intake 真实调用闭环
```

## 2026-09-01｜WORK研究 P0：普通文档入口模式绑定修复

### 阶段状态

- 状态：实现、聚焦验证、构建和真实窗口冒烟完成；提交并推送后等待人工验收。
- 当前分支：`codex/coding-work-integration-v1`。
- 起点：`1034d40f10ca5825e06c7c8d9f516427e7852808`。
- 本地工作树：`D:\CodexWorktrees\xiaogui-coding-work-integration-v1`。
- 边界：只修复 WORK 快捷入口的权威模式绑定并停用模式推荐；未修改模板整理领域状态机、Univer、DOCX HTML/PDF 降级路径、CODING TaskHub、IPC 安全门或发布配置。

### 本阶段目标

修复“界面显示 WORK，但主进程仍保留 CODING，点击整理普通文档后新工作区/会话继承 CODING”的状态分裂；确保 WORK 三个快捷入口在执行前显式绑定 WORK。按 2026-09-01 人工产品决定，当前版本不再做意图识别或模式推荐。

### 实际修改文件

- `src/renderer/src/xiaogui/components/WorkHomeView.tsx`
- `src/renderer/src/xiaogui/components/WorkHomeView.test.tsx`
- `src/renderer/src/xiaogui/lib/mode-recommendation-feature.ts`
- `electron.vite.config.ts`
- `src/renderer/src/vite-env.d.ts`
- `doc/architecture/xiaogui-prompt-inventory.md`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. WORK 首页任一快捷入口执行前都通过既有 `xiaogui.mode.switch` 权威通道显式绑定 `WORK`，不再只相信 Renderer 的乐观状态。
2. 模式绑定失败时立即停止，不打开文件选择器、不创建可能带 CODING 标签的 sandbox，也不发送提示词；界面保留可重试错误提示。
3. “整理普通文档”仍使用主进程私有 DOC/DOCX 交接，公开提示词只包含显示名；没有改变模板整理业务契约。
4. 模式推荐生产开关固定为关闭，删除 Vite 环境变量注入和全局声明；现有推荐算法仅作为历史研究代码保留，界面不评估、不显示、不自动切换。
5. 复用上一阶段已落地的 `EXECUTE` 新会话默认值，使明确的 WORK 结构化入口可获得其受控模板工具；本阶段没有再次修改 Phase 或能力门。

### 未完成内容

- 未用用户的真实 DOC/DOCX 完成模型分析与模板复核长旅程；本轮真实窗口只验证到原生选择器打开并取消，后续内容质量由人工单机试用验收。
- 未删除模式推荐算法、Banner 和历史测试文件，以保留研究证据并避免扩大重构范围；运行入口已不可配置且固定关闭。
- 未迁移或重写既有历史会话标签；修复作用于当前显式模式选择及之后的新快捷入口流程。
- 未制作 Portable、安装包或合并正式主线。

### 与规格文档存在的偏差

- 《Prompt 架构、模式边界与轻量智能推荐规格》原本允许“仅提示、需用户点击”的轻量推荐；根据 2026-09-01 最新人工决定，当前产品停用整项模式意图识别与推荐。这是明确的产品决策覆盖，已同步到架构清单。
- 没有引入 AUTO，也没有隐式切换：WORK 快捷入口的 `switchMode('WORK')` 是入口契约的显式自校准，用于消除 Main/Renderer 状态分裂。
- 《模板资产化产品改造规格》和《Univer Office Surface 开发实施规格》的模板状态机、展示内核及降级路径均未改动。

### 测试命令和测试结果

```powershell
node_modules\.bin\vitest.cmd run src/renderer/src/xiaogui/components/WorkHomeView.test.tsx --reporter=default
node_modules\.bin\vitest.cmd run src/renderer/src/xiaogui/components/WorkHomeView.test.tsx src/renderer/src/xiaogui/stores/xiaogui-store.test.ts src/renderer/src/xiaogui/lib/mode-recommendation.test.ts src/renderer/src/xiaogui/lib/mode-recommendation-display.test.ts src/renderer/src/features/composer/mode-recommendation-draft.test.ts src/main/xiaogui/sidecar-bridge.test.ts packages/shared/xiaogui-prompt-contract.test.ts src/main/xiaogui/worker-env.test.ts --reporter=default
npm run typecheck
npm run build
npm run dev -- --remoteDebuggingPort 9333
agent-browser --session xiaogui-work-smoke --cdp 9333 snapshot -i
git diff --check
```

- TDD 红灯：新增回归先稳定复现 `switchMode('WORK')` 未调用及绑定失败后仍打开选择器，`2 failed / 8 passed`。
- 修复后聚焦回归：`8 test files passed`，`69 tests passed`。
- 类型检查：Web 与 Node 两段均通过，退出码 `0`。
- 构建：Main、Preload、Renderer、Office Viewer、Office Gateway 全部通过；仅有既有动态导入和大 chunk 提示。
- 真实 Electron：确认运行进程 `app-path` 为本工作树；从 CODING 切到 WORK 后三张卡片可见；点击“整理普通文档”打开标题为“选择要整理的普通成品 Word”的原生选择器；取消后仍为 WORK、按钮恢复可用，浏览器控制台无错误。
- 差异检查：通过；仅有 Windows LF → CRLF 提示，无空白错误。

### 已知风险

1. 真实文件被选中后的模型输出质量、长文档耗时和复核体验不属于本次模式绑定证明，仍需用户单机样本验收。
2. 当前显式绑定复用既有模式切换动作，会同步刷新当前工作区会话列表；回归已覆盖成功、失败与调用顺序，但未进行高频连续点击压力测试。
3. 历史 CODING 会话不会被自动改写为 WORK；用户应从 WORK 首页重新进入目标流程。

### 下一阶段计划

提交并推送当前分支后停止扩大实现，等待用户用真实 DOC/DOCX 验收“第二个按钮 → 选择文件 → 保持 WORK → 开始只读分析”。验收发现新问题时另立下一独立阶段。

## 2026-09-01｜CODING 单机试用修复：取消强制 ASK 起步

### 阶段状态

- 状态：实现与聚焦验证完成，提交并推送后等待人工验收。
- 当前分支：`codex/coding-work-integration-v1`。
- 起点：`41f48e8343cd5b7869a1dc838faaa5e96bcf5c8c`。
- 边界：只调整新会话的默认执行阶段；未修改 WORK、TaskHub 状态机、权限规则、工作树、验证或交付审批。

### 本阶段目标

取消“所有编程请求必须先处于 ASK，再由用户手工切换 EXECUTE”的硬性流程。新会话默认具备受控执行能力；用户明确要求问答或计划时仍可使用 ASK / PLAN，既有安全门保持不变。

### 实际修改文件

- `packages/shared/xiaogui-prompt-contract.ts`
- `src/main/xiaogui/config.ts`
- `src/main/xiaogui/sidecar-bridge.ts`
- `src/main/xiaogui/sidecar-bridge.test.ts`
- `src/renderer/src/xiaogui/stores/xiaogui-store.ts`
- `doc/architecture/xiaogui-prompt-inventory.md`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 新增共享默认阶段常量 `XIAOGUI_DEFAULT_EXECUTION_PHASE_V1=EXECUTE`，Main 与 Renderer 使用同一事实源。
2. 新会话及新 Worker 默认获得 EXECUTE Prompt 与对应受控工具集合，不再先收到“建议切换到 EXECUTE”的 ASK 回复。
3. ASK 与 PLAN 的只读 Tool Schema、Prompt 语义和显式切换接口全部保留。
4. TaskHub 权限、独立工作树、真实验证、Diff 审阅和人工交付门未放宽；默认 EXECUTE 只表示可以申请并执行受控操作。

### 未完成内容

- 未增加基于自然语言猜测 ASK / PLAN / EXECUTE 的自动分类器；用户说“先规划”时由模型按用户要求先规划，不新增隐式模式跳转。
- 未修改当前隐藏的执行阶段切换控件，也未制作 Portable；均不属于本次缺陷修复。
- 已经运行中的旧 Worker 仍保留其启动时冻结的阶段，需重启小规或重建 Worker 后观察新默认值。

### 与规格文档存在的偏差

- 无 Phase 语义偏差：ASK 仍只读、PLAN 仍只规划、EXECUTE 仍受权限和交付门约束。
- 本次只取消强制 ASK 起步。它没有改变《Prompt 架构、模式边界与轻量智能推荐规格》中的 Mode / Phase / Capability / Tool 分层，也没有引入完整 AUTO 模式。
- Claude Code 交互仅作为“明确执行请求不被强制反问”的行为参照；未复制源码、品牌或插件。

### 测试命令和测试结果

```powershell
node_modules\.bin\vitest.cmd run src/main/xiaogui/sidecar-bridge.test.ts --reporter=default
node_modules\.bin\vitest.cmd run src/main/xiaogui/sidecar-bridge.test.ts packages/shared/xiaogui-prompt-contract.test.ts src/main/xiaogui/worker-env.test.ts --reporter=default
npm run typecheck
git diff --check
```

- TDD 红灯：新增回归先稳定复现 `expected 'ASK' to be 'EXECUTE'`，`1 failed / 24 passed`。
- 修复后聚焦回归：`3 test files passed`，`32 tests passed`。
- 类型检查：Web 与 Node 两段均通过，退出码 `0`。
- 差异检查：通过；仅有仓库既有的 Windows LF → CRLF 提示，无空白错误。

### 已知风险

1. EXECUTE 会向模型提供当前模式允许且本轮被选择的工具，但写入、命令、越界路径和外传仍必须经过既有硬门；若后续有人绕过这些门，默认 EXECUTE 会放大该独立缺陷的影响。
2. 当前阶段值是进程内状态；用户显式切换后仅对重建的 Worker 生效，现有实现仍会为切换重启空闲 Worker。
3. 本次未运行真实模型长旅程；聚焦测试证明默认阶段和 Worker 装配输入，生成质量仍由单机人工试用验收。

### 下一阶段计划

提交并推送当前独立集成分支，重启小规后由用户用“直接创建一个文件”的真实请求验收。验收前不继续扩大 CODING 或 WORK 范围。

## 2026-09-01｜CODING-P1 P3 三角色生产接缝最终候选

### 阶段状态

- 状态：P3 规格闭环已完成；聚焦测试、类型检查、构建、差异检查和真实 Electron 三角色旅程通过，等待审查 Agent 与人工验收。
- 当前起点：`06c410bf462562da7859116f787c2749c5bfd5e6`。
- 独立工作树：`D:\CodexWorktrees\xiaogui-coding-extension-pack-v1`。
- 独立分支：`agent/coding-p1-pi-extension-pack-v1`。
- 隔离边界：未触碰 WORK 工作树，未合并阶段线、未发布、未制作 Portable；保护暂存 `wip-p3-before-p2-gate-fix-20260831` 保留，`.omo/` 不纳入提交。

### 本阶段目标

1. 让研究、实现、审阅不只停留在角色配置，而是通过同一 Pi Extension → TaskHub → Runtime 生产接缝执行。
2. 保持研究/审阅硬只读，并让无文件修改的只读成果进入真实验证、依赖和统一交付总账。
3. 完成“研究 → 计划 → 实现 → 审阅 → 检查点预览/恢复 → 交付”的一条真实 Electron 旅程。

### 实际修改文件

- Runtime 契约与 Adapter：`packages/shared/xiaogui-agent-runtime.ts`、`src/main/xiaogui/agent-runtime/acp/types.ts`、`src/main/xiaogui/agent-runtime/kimi-adapter.ts`、`kimi-adapter.test.ts`。
- 角色批准与 TaskHub 生产装配：`src/main/xiaogui/coding-extensions/attempt-ipc.ts`、`attempt-ipc.test.ts`、`src/main/xiaogui/task-hub/application.ts`、`runtime-composition.ts`、`pi-e2e-scripted-runtime.ts`。
- 只读候选与验证：`src/main/xiaogui/task-hub/attempt-workspace.ts`、`attempt-workspace.test.ts`、`task-candidate-audit.ts`、`task-verification-coordinator.ts`、`task-verification-coordinator.test.ts`。
- Renderer：`src/renderer/src/xiaogui/components/CodingAttemptPlanCard.tsx`、`CodingAttemptPlanCard.test.tsx`。
- 联合验收和记录：`e2e/xiaogui-real-three-task-journey.spec.ts`、`doc/coding-p1/CODING-P1-P3-QA.md`、`doc/coding-p1/CODING-P1-P3-REVIEW.md`、`DEVELOPMENT_STATUS.md`。

### 已完成内容

1. Runtime 请求携带不可变 `codingRole` 投影；profile、角色、模型、Runtime 策略、有效工具白名单和摘要均绑定当前 Attempt。
2. TaskHub 允许已绑定的研究、实现、审阅角色进入各自执行回合，不再错误地把“只有实现角色能执行”当成角色硬限制。
3. 研究和审阅的有效工具严格固定为 `read`。Kimi ACP 对其关闭写能力、拒绝写权限与写调用；若工作树出现任何变化，权威验证失败关闭。
4. 只读 Agent 从模型文本事件形成候选证据；没有可验证文本时明确失败，不把“无输出”伪装成成功。
5. 只读 Attempt 可以显式捕获无变更补丁并经过真实 QA，形成不含文件变化的 Task ChangeSet，供后继依赖和统一交付使用。
6. 修复多个只读 Attempt 的空补丁编号冲突：内容摘要保持相同，制品编号绑定 Attempt；普通非空补丁生成规则不变。
7. Renderer 的角色提示改为“请先绑定执行角色”，与研究/实现/审阅三种合法执行角色一致。
8. Electron 旅程实际执行 A=研究、B=实现、C=审阅；B 读取 A 的已验证基线，C 读取 B 的已验证基线。
9. 实现任务完成检查点创建、影响预览、人工确认恢复，再继续修改和验证；最终三个 ChangeSet 按依赖顺序形成统一交付。
10. 人工批准交付前用户项目保持不变；批准后只写入 B 的真实文件变更，研究/审阅不伪造 Diff，重复批准保持幂等。

### 未完成内容

- 未用真实 Kimi/Codex 登录会话重复整条桌面旅程；Scripted Runtime 证明的是接缝、角色权限和状态流，不是模型生成质量。
- 未运行全量测试、制作 Portable、合并阶段线或发布；均不属于本 P3 门禁。

### 与规格文档存在的偏差

- 无产品或架构偏差。TaskHub 仍是 Attempt、工作树、验证、恢复和交付的唯一权威；没有引入第二套 Agent Loop、权限系统或状态机。
- 为表达只读成果，研究/审阅任务使用“空文件变更 + 可验证文本证据”的 Task ChangeSet；最终交付只物化实际文件变化。
- Claude Code 仅作为交互语义参照；没有复制源码、品牌或不稳定 insiders 依赖。
- WORK、DESIGN、Univer Office Surface、DOCX HTML 和 PDF 降级路径未修改。

### 测试命令和测试结果

```powershell
node_modules\.bin\vitest.cmd run packages/shared/xiaogui-agent-runtime.test.ts src/main/xiaogui/agent-runtime/kimi-adapter.test.ts src/main/xiaogui/coding-extensions/attempt-ipc.test.ts src/main/xiaogui/task-hub/attempt-workspace.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts src/main/xiaogui/task-hub/task-verification-coordinator.test.ts src/renderer/src/xiaogui/components/CodingAttemptPlanCard.test.tsx --reporter=default
npm run typecheck
npm run build
node_modules\.bin\playwright.cmd test e2e/xiaogui-real-three-task-journey.spec.ts --workers=1
git diff --check
```

- 聚焦回归：`7 test files passed`，`74 tests passed`。
- 类型检查、构建和差异检查：全部通过；构建仅有既有动态导入和 chunk 提示。
- Electron：`1 passed`，约 `1.0m`。证据目录：`D:\CodexTemp\xiaogui-hub-m4g-real-journey-v1\evidence\run-1788237824316`。
- TDD 证据：空补丁编号测试先稳定复现相同编号失败，修复后单测和整条 Electron 旅程均通过。

### 已知风险

1. 生产模型可能返回空文本或不符合角色目标；系统会明确失败，不会把它记作已验证成果。
2. 每个 Attempt 的角色和 Runtime 在执行开始后固定；不同角色并发仍需要独立 Worker 会话，不能在同一执行尝试中静默切换。
3. 检查点恢复跨 Pi 会话、TaskHub 和 Git 工作树；无法证明的中断仍保守进入 `OUTCOME_UNKNOWN` 并要求人工对账。
4. Scripted Runtime 不是生产模型质量证据；上线前仍应单列真实 Runtime 冒烟，而不重复本阶段全部测试。

### 下一阶段计划

完成固定差异代码审查和规格门审查；无阻断项后提交并推送当前独立 CODING 分支，等待人工验收。未经确认不合入 WORK 主线、阶段线或发布。

## 2026-09-01｜CODING-P1 P3 检查点、角色与联合旅程候选（历史记录，已由上节取代）

### 阶段状态

- 状态：P3 首轮阻断项已完成最小修复；聚焦回归、类型检查、构建和真实 Electron 联合旅程通过；固定差异代码审查 `PASS`、规格审查 `APPROVE`，本提交推送后等待人工验收
- 固定起点：`85142791d70f2486241bd644baa7cae58dc88208`
- 独立工作树：`D:\CodexWorktrees\xiaogui-coding-extension-pack-v1`
- 独立分支：`agent/coding-p1-pi-extension-pack-v1`
- 隔离边界：未触碰 WORK 工作树，未合并阶段线、未发布、未制作 Portable；保护暂存 `wip-p3-before-p2-gate-fix-20260831` 保留

### 本阶段目标

1. 将 Pi 会话检查点和 Attempt 独立工作树快照组成一次可预览、需人工确认、失败关闭的联合恢复。
2. 建立研究、实现、审阅三类本机角色配置，并把不可变角色快照绑定到权威 Attempt。
3. 保证研究和审阅角色的只读上限不能通过用户编辑解除，角色提示正文只走 Main-to-Worker 私有通道。
4. 完成“角色绑定 → 检查点创建 → 影响预览 → 人工确认恢复 → 多任务真实 Diff/验证 → 统一交付”的 Electron 联合旅程。

### 实际修改文件

- 共享契约：`packages/shared/ipc-channels.ts`、`packages/shared/ipc-contract.ts`、`packages/shared/xiaogui-coding-checkpoint-control.ts`、`packages/shared/xiaogui-coding-role-control.ts`
- Main / Worker 路由：`src/main/worker-manager.ts`、`src/main/__tests__/worker-manager-session-isolation.test.ts`、`src/main/__tests__/worker-manager-coding-role.test.ts`、`src/worker/worker-port-handlers.ts`、`src/worker/worker-port-types.ts`、`src/worker/worker-runtime.ts`
- 检查点生产模块：`src/main/xiaogui/coding-extensions/attempt-checkpointability-port.ts`、`attempt-checkpoint-workspace-authority.ts`、`attempt-checkpoint-workspace-port.ts`、`checkpoint-default-composition.ts`、`checkpoint-ipc.ts`、`checkpoint-module.ts`、`checkpoint-production-composition.ts`、`checkpoint-session-binding-registry.ts`、`checkpoint-state-store.ts`、`pi-session-checkpoint-port.ts` 及其同名聚焦测试
- 角色生产模块：`src/main/xiaogui/coding-extensions/role-ipc.ts`、`role-production-composition.ts`、`role-production-ports.ts`、`role-profile-module.ts` 及其同名聚焦测试；`src/worker/handlers/worker-handlers-coding-role.ts`、`src/worker/xiaogui-coding-extensions/role-guard-extension.ts`、`role-runtime-binding.ts` 及其测试
- TaskHub / 装配：`src/main/xiaogui/task-hub/application.ts`、`sqlite-store.ts`、`execution-orchestrator.ts`、`runtime-composition.ts`、`ipc.ts` 及其测试；`src/main/xiaogui/coding-extensions/plan-worker-tool.ts`、`attempt-ipc.ts` 及其测试；`src/main/xiaogui/index.ts`、`index.test.ts`
- 可信 session 生产接缝：`src/main/ipc/handlers/session.ts`
- Renderer：`src/renderer/src/xiaogui/lib/coding-checkpoint-client.ts`、`coding-role-client.ts`、`coding-attempt-client.ts` 及其测试；`components/CodingCheckpointCard.tsx`、`CodingRoleCard.tsx`、`CodingAttemptPlanCard.tsx`、`CollaborationHubPanel.tsx` 及其测试
- 联合旅程与记录：`e2e/xiaogui-real-three-task-journey.spec.ts`、`doc/coding-p1/CODING-P1-P3-REVIEW.md`、`doc/coding-p1/CODING-P1-P3-QA.md`、`DEVELOPMENT_STATUS.md`

### 已完成内容

1. 检查点同时捕获 Pi 会话快照与 Attempt 工作树状态；工作树快照覆盖已跟踪、暂存、未跟踪、二进制、删除和 Git mode，硬链接越界内容失败关闭。
2. 恢复前生成一次性预览令牌，只公开相对路径、影响数量和“对话将回到此检查点”；Renderer 必须显示影响并由用户勾选后确认。
3. 恢复使用持久化 Saga。进程中断后先对账再续接；预览过期、摘要漂移、工作树忙碌或权威绑定不一致均拒绝恢复，不猜测成功。
4. 恢复导致既有验证成果失效或恢复结果无法确认时，TaskHub 以原子状态转换进入 `OUTCOME_UNKNOWN`，不会重复派发、静默换 Agent 或继续形成交付。
5. 会话绝对路径和快照引用只保存在主进程私有 SQLite；公开 IPC、Renderer 投影、会话和事件只使用不透明地址、相对路径与固定错误码。
6. 研究、实现、审阅默认角色可编辑、复制和重置；Attempt 绑定后保存不可变快照、配置摘要、模型选择、运行时策略和有效工具白名单，不能静默换角色。
7. 研究和审阅角色始终应用硬只读上限；未知工具、写入工具和越界工具不会因用户编辑白名单而放行。模型或运行时不可用时显示明确中文状态。
8. 角色预检现在可通过主进程私有会话登记恢复正确的 CODING Worker，再按匿名会话地址绑定；私有会话路径不返回 Renderer。
9. 协作面板在每个 READY Attempt 内显示角色卡和检查点卡；真实窗口已完成角色绑定、检查点预览/恢复，并继续 A/B 并行、C 依赖 A、真实 Diff/验证、统一交付和幂等应用。
10. 角色要求已进入 TaskHub 权威派发门：只有冻结为 `IMPLEMENT` 的 Attempt 角色快照可以从 `WORKSPACE_READY` 进入 Runtime dispatch；缺失、读取失败或研究/审阅角色均保持 `READY`。
11. 计划批准和继续执行 IPC 在修改计划或调用 Runtime 前执行同一角色校验；Renderer 明确提示“请先绑定实现角色”，不能只靠界面顺序保证安全。
12. Pi Worker 未绑定角色时只公开 `read`；命令、写入和其他工具统一失败关闭。Worker 已绑定后只接受同一 Attempt+摘要；用户显式为另一 Attempt 绑定角色时，Main 必须先用原 Attempt 编号完成 `release`，再预检和绑定新快照。
13. Renderer 手工计划和 TaskHub 兜底计划使用的可信 CODING session 现在由 Main 的真实 session 打开/列举路径登记；联合旅程已删除私有注册表手工 seed，并为 A/B/C 三个 Attempt 分别固定实现角色。

### 未完成内容

- 角色与检查点联合旅程使用受控 Scripted Runtime，证明 TaskHub、Pi Worker、工作树、Renderer 和恢复接缝，不代表 Kimi、Codex 或其他生产模型的生成质量。
- 本阶段没有证明同一 Pi 会话同时激活两个不同 Attempt 的角色；当前实现对同一活跃 Worker 的冲突角色失败关闭，真实并发需要由独立 Worker 会话承载。
- Electron 联合旅程实际绑定并展示“实现”角色；研究/审阅的硬只读上限、模型门和工具过滤由聚焦 Worker 测试证明，未额外重复一条长桌面旅程。
- 未运行全量测试，未制作安装包或 Portable；这些不属于本阶段门禁。

### 与规格文档存在的偏差

- 没有引入第二套 Agent Loop、权限系统或恢复状态机；TaskHub 仍是 Attempt、工作树、验证、交付和结果未知状态的唯一权威。
- Claude Code 仅作为交互语义参照；实现使用 Pi Extension、现有 Renderer 和 TaskHub 窄接缝，没有复制其源码、品牌或不稳定 insiders 依赖。
- 联合旅程没有为了展示而连续切换研究/实现/审阅三个角色；角色在 Attempt 启动后固定，执行中禁止静默更换。三个角色的编辑与安全上限分别由聚焦测试覆盖。
- WORK、DESIGN、Univer Office Surface、DOCX HTML 和 PDF 降级路径未修改。

### 测试命令和测试结果

```powershell
$focusedTests = @(
  (rg --files src packages | rg '(checkpoint|coding-role|role-|CodingRole|CodingCheckpoint|plan-worker-tool|worker-manager-session-isolation|CollaborationHubPanel).*\.test\.(ts|tsx)$'),
  'src/main/xiaogui/index.test.ts',
  'src/main/xiaogui/task-hub/application.test.ts',
  'src/main/xiaogui/task-hub/application-derived-baseline-concurrency.test.ts',
  'src/main/xiaogui/task-hub/sqlite-store.test.ts'
) | Sort-Object -Unique
node_modules\.bin\vitest.cmd run $focusedTests --reporter=default
```

结果：`28 test files passed`，`220 tests passed`，退出码 `0`。覆盖检查点恢复 Saga、私有会话登记、角色配置/只读上限、Worker 会话隔离、TaskHub 状态转换、Renderer 卡片和真实工作树恢复。

首轮审查阻断修复只补跑直接相关组：

```powershell
node_modules\.bin\vitest.cmd run src/main/xiaogui/coding-extensions/attempt-ipc.test.ts src/main/xiaogui/task-hub/execution-orchestrator.test.ts src/worker/xiaogui-coding-extensions/role-runtime-binding.test.ts src/worker/xiaogui-coding-extensions/role-guard-extension.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts src/renderer/src/xiaogui/components/CodingAttemptPlanCard.test.tsx src/renderer/src/xiaogui/lib/coding-attempt-client.test.ts src/main/ipc/handlers/session-preview-authorization.test.ts src/main/ipc/handlers/session-preview-invalidation.test.ts
```

结果：`9 test files passed`，`80 tests passed`，退出码 `0`。覆盖 TaskHub 角色派发门、批准/续接角色门、Worker 未绑定只读、显式 Attempt 切换和安全错误展示。

角色槽复审阻断修复后补跑最小角色组：`4 test files passed`、`13 tests passed`，退出码 `0`。覆盖“不释放不能覆盖”、带旧 Attempt 编号释放、Main release-before-inspect 顺序和 Worker RPC。

```powershell
npm run typecheck
npm run build
git diff --check
```

结果：三项均通过；类型检查和构建退出码 `0`，`git diff --check` 无错误。构建只出现既有动态导入、大 chunk 和 Office Viewer 插件耗时提示。

```powershell
node_modules\.bin\playwright.cmd test e2e/xiaogui-real-three-task-journey.spec.ts --workers=1
```

结果：角色槽严格释放修复后 `1 passed`，耗时 `56.0s`。证据目录：`D:\CodexTemp\xiaogui-hub-m4g-real-journey-v1\evidence\run-1788233094138`。关键证据：`02a-role-required.png`、`02a-role-bound.png`、`02b-checkpoint-restore-preview.png`、`02c-checkpoint-restored.png`、`04-real-diff-and-verification.png`、`06-apply-succeeded.png`、`journey-events.jsonl`、`journey-rows.json`。旅程已删除私有 session seed；结构化总账含 A/B/C 三条默认实现角色的绑定时间和 `sha256:` 摘要。

### 已知风险

1. 检查点恢复跨 Pi 会话、TaskHub 和 Git 工作树三个持久化边界；任何不能证明的中断都会进入 `OUTCOME_UNKNOWN`，需要人工对账而不会自动重跑。当前实现会保守停用该检查点 runtime，后续可研究按 Attempt 隔离恢复。
2. 每个 Pi Worker 同一时刻只接受一个 Attempt 角色快照；不同 Attempt 的并行角色需要不同 Worker 会话，当前阶段未做生产多会话模型冒烟。
3. 角色模型选择只验证当前 Pi Worker 已加载且批准的模型；这不是对生产 Runtime 登录、额度或生成质量的证明。
4. 真实旅程使用一次性 Git 项目和 Scripted Runtime；正式用户项目仍必须经过现有交付审阅和人工应用门。
5. 检查点工作树目前不额外验证符号链接 target 是否仍位于工作树内；代码审查将其登记为后续安全债，本阶段未扩大修改范围。

### 下一阶段计划

当前固定差异已通过代码标准与规格双复审。提交并推送当前独立 CODING 分支后等待人工验收；未经确认不合入阶段线、不发布，也不进入下一工作包。

## 2026-08-31｜CODING-P1 P2 审查修复候选

### 阶段状态

- 状态：针对 P2 首轮审查的 dispatch 恢复、批准幂等、安全错误和真实 Diff 证据完成修复；聚焦回归、类型检查、构建和 Electron 旅程均通过，等待清洁工作树复核
- 固定起点：`e992483975ade4bd10aaf1c6fc399a63f42caf93`
- 独立分支：`agent/coding-p1-pi-extension-pack-v1`
- 隔离边界：P3 在接线前以独立可恢复暂存保存；未修改 WORK 工作树，未合并阶段线、未发布、未制作 Portable

### 本阶段目标

1. 修复 Runtime dispatch 失败后计划停在 `EXECUTING`、界面无法“继续执行”的恢复缺陷。
2. 让已落库的同一批准请求在响应丢失后可以安全重放，不产生虚假的正文版本冲突。
3. 确保 TaskHub/Runtime 抛错只经版本化安全错误返回 Renderer，不把绝对路径或内部状态交给公共 IPC 日志。
4. 让真实 Electron 旅程展开并断言工作树 Diff 内容，而不是只看“通过”标签。

### 实际修改文件

- `src/main/xiaogui/coding-extensions/attempt-plan-module.ts`
- `src/main/xiaogui/coding-extensions/attempt-plan-module.test.ts`
- `src/main/xiaogui/coding-extensions/attempt-ipc.ts`
- `src/main/xiaogui/coding-extensions/attempt-ipc.test.ts`
- `src/main/xiaogui/task-hub/execution-orchestrator.ts`
- `src/main/xiaogui/task-hub/execution-orchestrator.test.ts`
- `e2e/xiaogui-real-three-task-journey.spec.ts`
- `doc/coding-p1/CODING-P1-P2-REVIEW.md`
- `doc/coding-p1/CODING-P1-P2-QA.md`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 计划 revision 与 digest 现在只标识用户审阅的计划正文；`AWAITING_APPROVAL → APPROVED → EXECUTING` 生命周期变化不再伪造正文新版本。
2. 同一 `APPROVE` 请求可以在响应丢失后重放并返回同一权威投影；修改正文或 Todo 仍会生成新 revision/digest。
3. Runtime 在真正进入 `STARTING/RUNNING` 前 dispatch 失败时，TaskHub 将计划从 `EXECUTING` 原子退回原来的 `APPROVED`，Saga 回到 `WORKSPACE_READY`，重启后仍由用户“继续执行”。
4. 若 Agent 已进入 `STARTING/RUNNING`，继续保持 `OUTCOME_UNKNOWN` 且不重复派发；若计划回滚本身失败，也进入 `OUTCOME_UNKNOWN` 并失败关闭。
5. `resumeAttempt` 返回失败或抛错时，IPC 返回最新权威计划投影和固定安全错误，不返回异常正文。
6. 新增真实 `CodingAttemptPlanModuleV1 + Orchestrator + fail-once dispatch` 回归：首次失败后计划为 `APPROVED`，关闭重启后仍保持，第二次人工续接只成功 dispatch 一次并进入 `EXECUTING`。
7. Electron 旅程会真正展开 Diff，并断言工作树中的 `A-verified`/`B-verified` 变更文本可见。
8. dispatch 失败后只有权威 Attempt 明确为 `READY` 才允许回滚并重试；authority 不可读、状态非 `READY` 或计划回滚失败均进入 `OUTCOME_UNKNOWN`，防止重复运行。
9. 已对生产差异和测试逐项完成过拟合、恒真断言、实现镜像、无效测试、不必要抽象、维护负担、虚假信心与范围漂移复核，记录见 `doc/coding-p1/CODING-P1-P2-REVIEW.md`。

### 未完成内容

- P3 检查点、Pi 会话恢复、角色配置及联合旅程尚未接入生产装配，不计入本阶段完成。
- P2 仍使用 Scripted Runtime 验证 TaskHub、工作树和界面接缝；这不是生产模型生成质量证据。
- 未运行全量测试；按用户要求只运行直接相关回归、一次类型检查、一次构建和一条 Electron 旅程。

### 与规格文档存在的偏差

- 无新增产品或架构偏差。TaskHub 仍是 Attempt、计划、权限、工作树、验证和恢复的唯一权威；Pi 与 Renderer 只通过窄契约提交草稿和人工决定。
- 未复制 Claude Code 源码、品牌或第二套状态机；只保持其“计划先审、批准后执行、失败可继续、查看真实 Diff”的交互语义。
- WORK、DESIGN、Univer Office Surface 以及 DOCX/PDF 降级路径未修改。

### 测试命令和测试结果

```powershell
node_modules\.bin\vitest.cmd run src/main/xiaogui/coding-extensions/attempt-plan-module.test.ts src/main/xiaogui/coding-extensions/attempt-ipc.test.ts src/main/xiaogui/task-hub/execution-orchestrator.test.ts
```

结果：`3 test files passed`，`38 tests passed`，退出码 `0`。新增覆盖批准重放、dispatch 失败回滚、SQLite 重启续接、authority 不可读、rollback 失败和异常脱敏。

```powershell
npm run typecheck
npm run build
```

结果：两项退出码均为 `0`。构建只有既有动态导入和大 chunk 提示。

```powershell
node_modules\.bin\playwright.cmd test e2e/xiaogui-real-three-task-journey.spec.ts --workers=1
```

结果：`1 passed`，耗时约 1.5 分钟。最新证据目录：`D:\CodexTemp\xiaogui-hub-m4g-real-journey-v1\evidence\run-1788181671956`；`04-real-diff-and-verification.png` 显示已展开的真实统一 Diff 和两条退出码 `0`。

### 已知风险

1. 计划回滚与 Runtime 权威状态之间采用先查询再回滚；若该窗口内状态无法确认，系统选择 `OUTCOME_UNKNOWN`，需要人工对账而不是自动重试。
2. P2 尚未证明生产 Kimi/Codex 的代码质量，只证明更换 Runtime 时保持相同的 TaskHub 计划与审阅契约。
3. P3 当前仍是未接线模块，必须在 P2 清洁复核通过后再进入生产装配。

### 下一阶段计划

在固定提交上建立清洁工作树重跑同一最小门禁并完成审查；通过后恢复 P3 工作，接通检查点预览/确认、Pi Session 与工作树联合恢复、三类角色配置与硬权限上限，最后完成真实 Electron 联合旅程。

## 2026-08-31｜CODING-P1 P2 计划、Todo 与真实 Diff 审阅候选

### 阶段状态

- 状态：P2 实现、聚焦测试、类型检查、完整构建和一条真实 Electron 旅程均已通过；本节随独立 P2 提交推送，等待人工/审查 Agent 验收
- 独立工作树：`D:\CodexWorktrees\xiaogui-coding-extension-pack-v1`
- 当前分支：`agent/coding-p1-pi-extension-pack-v1`
- P1 固定起点：`c2c779d9b6943c8b21db27c40170163998615297`
- 隔离边界：未修改或合并正在施工的 WORK 分支；未合并阶段线、未发布、未制作 Portable

### 本阶段目标

1. 在每个 TaskHub Attempt 真正执行前建立只读计划门，计划未经人工批准时不得调用 Agent Runtime。
2. 让 Pi 在 `CODING + PLAN` 中通过隐藏工具提交结构化计划草稿；ASK、EXECUTE、WORK 不开放该工具。
3. 在现有协作面板显示可修改的计划卡、Attempt 内 Todo 和“批准并开始执行/继续执行”。
4. 只从真实 Attempt 工作树和真实验证制品生成 Diff、相对路径、退出码和未解决问题，不采信模型自述。

### 实际修改文件

- 共享契约与能力矩阵：`packages/shared/ipc-channels.ts`、`ipc-contract.ts`、`worker-host-tools.ts`、`xiaogui-coding-extension-control.ts`、`xiaogui-coding-extension-pack.ts`、`xiaogui-coding-extension-pack.test.ts`、`xiaogui-coding-plan-prompt.test.ts`、`xiaogui-prompt-capabilities.ts`、`xiaogui-prompt-matrix.ts`、`xiaogui-prompt-matrix.test.ts`
- Pi / Worker：`src/worker/xiaogui-coding-plan-tool.ts`、`xiaogui-coding-plan-tool.test.ts`、`xiaogui-worker-tools.ts`、`xiaogui-tool-guidelines-baseline.test.ts`
- Main / TaskHub：`src/main/xiaogui/coding-extensions/attempt-plan-module.ts`、`attempt-plan-module.test.ts`、`attempt-review-module.ts`、`attempt-review-module.test.ts`、`attempt-ipc.ts`、`attempt-ipc.test.ts`、`plan-worker-tool.ts`、`plan-worker-tool.test.ts`、`src/main/xiaogui/task-hub/execution-orchestrator.ts`、`execution-orchestrator.test.ts`、`runtime-composition.ts`、`ipc.ts`、`src/main/xiaogui/worker-host-tool-router.ts`、`worker-host-tool-router.test.ts`、`src/main/xiaogui/index.ts`、`index.test.ts`
- Renderer：`src/renderer/src/xiaogui/lib/coding-attempt-client.ts`、`coding-attempt-client.test.ts`、`stores/coding-attempt-store.ts`、`coding-attempt-store.test.ts`、`components/CodingAttemptPlanCard.tsx`、`CodingAttemptPlanCard.test.tsx`、`CodingAttemptReviewCard.tsx`、`CodingAttemptReviewCard.test.tsx`、`CollaborationHubPanel.tsx`、`CollaborationHubPanel.test.tsx`
- 真实旅程：`e2e/xiaogui-real-three-task-journey.spec.ts`
- 阶段记录：`DEVELOPMENT_STATUS.md`

### 已完成内容

1. TaskHub 为每个 Attempt 创建并持久化独立计划；有 Pi 草稿时使用草稿，否则根据已批准任务目标生成明确标识的保守计划。计划 revision、digest、批准状态和 Todo 状态在 SQLite 重启后可恢复。
2. `WORKSPACE_READY` 状态现在必须先通过计划门。未批准时保持 `READY` 且运行时 dispatch 次数为零；批准精确 revision/digest 后才把状态切为执行中并且只 dispatch 一次。
3. Pi 新增隐藏工具 `xiaogui_publish_coding_plan`，只在 `CODING + PLAN` 可见。模型只能提交目标、步骤、验证方法和约束，不能提交路径、SessionAddress、Attempt ID 或内部摘要；Main 从可信会话解析地址。
4. 现有协作面板新增“等待批准计划”分组和计划卡；用户可改目标、步骤标题和验证方法，任何修改都会产生新 revision 并撤销旧版本的批准资格。
5. “批准并开始执行”同时完成 TaskHub 批准和同一 Attempt 续接；若批准已落库但启动失败，界面保留“继续执行”，不会要求重新批准或静默换 Agent。
6. Todo 只属于当前 Attempt 的执行步骤，不创建、不重排 TaskHub DAG；执行开始后只允许合法的状态迁移。
7. 审阅模块从真实 Attempt 工作树生成统一 Diff，并校验 TaskChangeSet、补丁制品和验证制品的绑定。失败、未知或缺少退出状态会明确进入未解决问题，不能形成伪通过。
8. Renderer 只展示相对路径、验证标签、状态、退出码、未解决问题和 Diff；不展示 Attempt ID、绝对路径、私有会话编号或底层命令。既有验证摘要卡继续展示公开证据/变更集编号及截断 digest，不能据此访问私有工作树或会话。

### 未完成内容

- P3 的 Git/会话联合检查点、恢复预览、角色配置和角色硬权限上限尚未计入本阶段完成范围。
- 当前生产 TaskHub 默认外部 Runtime 不会自动产出 Pi 计划草稿；没有草稿时使用 TaskHub 任务目标兜底。嵌入式 Pi 的 `CODING + PLAN` 草稿工具链已接通。
- 尚未提供计划步骤的新增、删除或拖拽重排；P2 只支持冻结规格要求的目标、步骤标题和验证方法修改。
- 未运行全量测试，未发布，未制作 Portable。

### 与规格文档存在的偏差

- 无架构偏差：计划、批准、Todo、真实工作树和验证继续由 TaskHub 作为唯一权威；Pi 只提交草稿，Renderer 只提交版本化意图。
- Claude Code 仅作为交互行为基准；界面使用中文和小规品牌，没有复制其源码、像素样式、Agent Loop、权限系统或状态机。
- P2 真实旅程使用受控 Scripted Runtime，证明计划门、独立工作树、真实 Diff 和验证退出码；不把 Scripted Runtime 宣称为生产模型质量证据。
- WORK、DESIGN、Univer Office Surface、DOCX HTML 和 PDF 降级路径未修改。

### 测试命令和测试结果

#### 聚焦测试

```powershell
node_modules\.bin\vitest.cmd run packages/shared/xiaogui-coding-extension-pack.test.ts packages/shared/xiaogui-coding-plan-prompt.test.ts packages/shared/xiaogui-prompt-matrix.test.ts src/worker/xiaogui-coding-plan-tool.test.ts src/worker/xiaogui-tool-guidelines-baseline.test.ts src/main/xiaogui/coding-extensions/attempt-plan-module.test.ts src/main/xiaogui/coding-extensions/attempt-review-module.test.ts src/main/xiaogui/coding-extensions/plan-worker-tool.test.ts src/main/xiaogui/coding-extensions/attempt-ipc.test.ts src/main/xiaogui/task-hub/execution-orchestrator.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts src/main/xiaogui/task-hub/ipc.test.ts src/main/xiaogui/worker-host-tool-router.test.ts src/main/xiaogui/index.test.ts src/renderer/src/xiaogui/lib/coding-attempt-client.test.ts src/renderer/src/xiaogui/stores/coding-attempt-store.test.ts src/renderer/src/xiaogui/components/CodingAttemptPlanCard.test.tsx src/renderer/src/xiaogui/components/CodingAttemptReviewCard.test.tsx src/renderer/src/xiaogui/components/CollaborationHubPanel.test.tsx
```

结果：首次联合运行 `127/128` 通过，唯一失败是入口装配测试未模拟新增 IPC 注册；补齐测试替身后相关入口组 `3/3` 通过。所有业务模块和 Renderer 用例均通过，没有修改生产逻辑来迎合失败断言。

#### 类型检查与构建

```powershell
npm run typecheck
npm run build
```

结果：两项退出码均为 `0`。Main、Preload、Renderer、Office Viewer 和 Office Gateway 构建成功；只保留既有动态导入和大 chunk 提示。

#### 真实 Electron 旅程

```powershell
node_modules\.bin\playwright.cmd test e2e/xiaogui-real-three-task-journey.spec.ts --workers=1
```

结果：`1 passed`，耗时约 50 秒。真实窗口证实：A/B 的 Attempt 计划出现前 Runtime 启动事件为零；分别人工批准后 A/B 并行，C 等待 A；A/B 验证通过后可读取真实工作树 Diff、相对路径和两条退出码 `0` 的验证记录；C 再经计划批准后完成统一交付，未经最终人工批准前用户项目保持不变。

证据目录：`D:\CodexTemp\xiaogui-hub-m4g-real-journey-v1\evidence\run-1788176415769`。关键截图为 `02-attempt-plans-awaiting-approval.png` 和 `04-real-diff-and-verification.png`；结构化证据为 `journey-events.jsonl`、`journey-rows.json`。

### 已知风险

1. 计划内容由当前模型或任务目标生成，计划门保证人工批准和执行顺序，不保证模型计划本身正确。
2. 批准成功但进程在 Runtime dispatch 前中断时，计划保持 `APPROVED` 并由“继续执行”恢复；不会自动换 Runtime，也不会重复派发。
3. 真实 Diff 依赖 Attempt 工作树和持久化 ChangeSet/验证制品一致；任何摘要漂移都会失败关闭并显示未解决问题。
4. P3 角色与联合检查点仍在独立施工，不能从本阶段推断它们已可用。

### 下一阶段计划

P2 提交推送后等待人工或审查 Agent 验收。通过后进入 P3：接通 Pi 会话与 Attempt 工作树的联合检查点、恢复预览和人工确认；接入研究/实现/审阅角色配置及不可解除的只读上限；完成一条“研究 → 计划 → 实现 → 审阅 → 恢复 → 交付”真实 Electron 旅程。

## 2026-08-31｜CODING-P1 P1 代码上下文与权限候选

### 阶段状态

- 状态：P1 实现、必要边界复核、聚焦测试、类型检查、完整构建、唯一一条真实 Electron 冒烟和最终双轴审查均已完成；本阶段提交推送后停止并等待人工验收
- 独立工作树：`D:\CodexWorktrees\xiaogui-coding-extension-pack-v1`
- 当前分支：`agent/coding-p1-pi-extension-pack-v1`
- P0 固定起点：`ad7564c9d53d48479bf1a384c276290285080fa2`
- 隔离边界：未修改或合并正在施工 WORK 的工作树/分支；未合并阶段线、未发布、未制作 Portable

### 本阶段目标

1. 让 CODING 模式的 `@` 文件上下文从项目内相对路径形成受控快照，并由 Pi Extension 真正加入当前 Agent turn。
2. Main 依据当前 canonical session scope 解析权威项目根，不信任 Renderer 提供的绝对根目录。
3. 把文件写入、命令和数据外传请求转换为 TaskHub 权威的精确权限意图，提供“允许一次 / 允许本次任务中的相同规则 / 拒绝”。
4. 验证越界、缺少精确目标、UI 超时、拒绝和重启规则恢复均 fail-closed。

### 实际修改文件

- 共享契约：`packages/shared/ipc-channels.ts`、`packages/shared/ipc-contract.ts`、`packages/shared/xiaogui-agent-runtime.ts`、`packages/shared/xiaogui-coding-extension-pack.ts`
- Main 上下文链：`src/main/xiaogui/coding-extensions/context-composition.ts`、`context-ipc.ts`、`context-module.ts`、`context-module.test.ts`、`src/main/ipc/handlers/prompt.ts`、`src/main/ipc/schemas.ts`、`src/main/worker-manager.ts`、`src/main/xiaogui/index.ts`
- Worker / Pi Extension：`src/worker/xiaogui-coding-extensions/context-extension.ts`、`context-extension.test.ts`、`src/worker/handlers/worker-handlers-turn.ts`、`src/worker/worker-port-types.ts`、`src/worker/worker-runtime.ts`
- TaskHub 权限链：`src/main/xiaogui/coding-extensions/permission-module.ts`、`permission-module.test.ts`、`permission-ui-adapter.ts`、`safe-display-metadata.ts`、`safe-display-metadata.test.ts`、`src/main/xiaogui/task-hub/execution-orchestrator.ts`、`execution-orchestrator.test.ts`、`runtime-composition.ts`
- Kimi ACP 精确目标：`src/main/xiaogui/agent-runtime/acp/workspace-policy.ts`、`src/main/xiaogui/agent-runtime/kimi-adapter.ts`、`kimi-adapter.test.ts`
- Renderer 上下文：`src/renderer/src/features/composer/attachments.tsx`、`coding-context-status.ts`、`coding-context-status.test.ts`、`composer.tsx`、`use-composer-file-search.ts`、`use-composer-file-search.test.tsx`、`use-composer-send.ts`、`use-composer-send.test.tsx`
- Renderer 权限：`src/renderer/src/features/extension-ui/coding-permission-dialog.tsx`、`coding-permission-dialog.test.tsx`、`extension-ui-host.tsx`、`src/renderer/src/lib/extension-ui-channel.ts`、`extension-ui-channel.test.ts`、`src/renderer/src/stores/extension-ui-store.ts`、`src/renderer/src/stores/__tests__/extension-ui-store.test.ts`
- Direct Extension UI 与来源封套：`src/main/direct-extension-ui.ts`、`src/main/direct-extension-ui.test.ts`、`src/main/worker-manager-pool.ts`、`src/main/__tests__/worker-manager-extension-ui.test.ts`
- 阶段记录：`DEVELOPMENT_STATUS.md`

### 已完成内容

1. `@` 文件搜索仍只产生项目内相对路径；Renderer 只持有 canonical session address、公开摘要和一次性 `xgctx_*` 令牌，不持有 Main 的项目根或源文件全文。
2. Main 通过 session scope 与 project resolver 解析权威根，拒绝伪造会话、绝对路径、越界路径、目录、二进制和超限内容；公开快照只有相对路径、SHA-256、字节/行数和截断摘要。
3. Renderer 选择 `@` 文件时只记录相对来源；正式发送前才读取最新正文并生成快照。Main 对快照设置 10 分钟主动到期、最多 64 条和总计 8 MiB 的硬上限，绑定同一 canonical CODING 会话并在发送时一次性消费。
4. Worker 的隐藏 Pi Extension 使用稳定 `context` hook，把受控 JSON 作为当前模型调用的临时 custom/user context 返回；不修改 `systemPrompt`，也不把正文追加到 Pi 会话历史。文件内容明确标记为不可信用户资料；符号服务不可用时明确使用受控文本降级，不伪装 LSP 结果。
5. TaskHub 权限意图使用 Runtime 事件中的精确相对路径；所有操作均须至少绑定一个 Attempt manifest 已批准的路径。`COMMAND` 和 `DATA_EGRESS` 还必须携带只在 Main/TaskHub 内部流转的 `sha256:` 动作摘要，展示摘要不能替代权威动作身份。
6. Kimi ACP 的厂商 edit 权限和主机写入权限均携带精确相对目标；工作区策略继续在实际读写时独立校验文件身份、摘要和 Attempt 工作树边界。
7. Main 统一的展示元数据边界会在原始值归一化前拒绝控制字符，并拒绝字符串任意位置的 Windows/UNC/POSIX 绝对路径、`file:` URL、Authorization/Bearer/token 等凭据形态及 URL userinfo；原始命令、凭据、绝对路径和动作摘要均不进入 Renderer 公开契约。
8. Task 级规则按 Attempt + 操作 + 精确路径 + 私有动作摘要持久化；重启后只复用完全相同的规则。UI 不可用或 55/60 秒超时均自动拒绝并清理悬挂对话框。
9. Renderer 权限请求改为 FIFO 队列，并发 Attempt 不再互相覆盖；Direct Extension UI 在超时或窗口发送异常时先清理 pending/listener，再安全失败。
10. Main 给 Worker 转发请求强制覆盖为 `origin: worker`；Renderer 只接受 Main 直发、编号格式与完整 Prompt 契约均通过校验的 `xiaogui-direct` Coding 权限弹窗，Worker 无法冒充权威权限界面。

### 未完成内容

- 尚未接入真实 LSP 服务；当前按冻结规格明确降级为受控文本搜索/上下文，界面显示“符号服务不可用”，不会伪装符号级结果。
- 当前生产 Kimi Adapter 继续禁用终端，因此 `COMMAND` 由版本化契约、TaskHub 和 Scripted 事件测试证明，尚无生产 Kimi 命令执行入口；本阶段没有为验收而放宽终端白名单。
- 当前 Kimi 本机运行时不会主动发起 `DATA_EGRESS` 工具事件；外传目标链已在 TaskHub/Renderer 聚焦测试中验证，但真实云端 Adapter 仍须在后续运行时工作包中接入。
- P2 计划卡、Todo、真实 Diff/验证审阅和 P3 检查点/角色配置未施工。
- 未运行全量测试、未合并、未发布、未制作 Portable。

### 与规格文档存在的偏差

- 没有产品或架构偏差：继续复用 Pi Extension、Renderer Extension UI、TaskHub 和既有 Agent Runtime；未复制 Claude Code 源码，未引入第二套 Agent Loop、权限系统或状态机。
- 规格允许 LSP 不可用时明确降级；本阶段选择 `CONTROLLED_TEXT_FALLBACK`，而不是引入新的 LSP 依赖或伪造符号结果。
- 命令与外传的生产 Adapter 触发尚未开放，这是既有 Kimi 终端禁用和云端运行时未接入的真实边界，已明确记录而非宣称生产可用。
- WORK、DESIGN、Univer Office Surface、DOCX HTML 和 PDF 降级路径均未修改。

### 测试命令和测试结果

#### 聚焦测试

```bat
set TEMP=D:\CodexTemp\xiaogui-coding-p1-evidence\final-tmp
set TMP=D:\CodexTemp\xiaogui-coding-p1-evidence\final-tmp
set NODE_OPTIONS=--max-old-space-size=4096
node_modules\.bin\vitest.cmd run packages/shared/xiaogui-coding-extension-pack.test.ts packages/shared/xiaogui-agent-runtime.test.ts src/worker/xiaogui-coding-extensions/extension-pack.test.ts src/worker/xiaogui-coding-extensions/context-extension.test.ts src/main/xiaogui/task-hub/coding-extension-seam-bridge.test.ts src/main/xiaogui/coding-extensions/context-module.test.ts src/renderer/src/features/composer/coding-context-status.test.ts src/renderer/src/features/composer/use-composer-file-search.test.tsx src/renderer/src/features/composer/use-composer-send.test.tsx src/main/xiaogui/coding-extensions/permission-module.test.ts src/renderer/src/features/extension-ui/coding-permission-dialog.test.tsx src/main/xiaogui/task-hub/execution-orchestrator.test.ts src/main/xiaogui/agent-runtime/kimi-adapter.test.ts src/main/xiaogui/agent-runtime/runtime-host.test.ts src/main/direct-extension-ui.test.ts src/renderer/src/stores/__tests__/extension-ui-store.test.ts src/renderer/src/lib/extension-ui-channel.test.ts --maxWorkers=1 --reporter=dot
```

结果：`17 test files passed`，`101 tests passed`，退出码 `0`。覆盖权威项目根、发送前读取、全文私有注入、快照容量/主动到期、一次性会话绑定、越界拒绝、精确文件目标、私有动作摘要、安全展示元数据、权限 FIFO、超时清理、规则重启恢复和 Kimi ACP 精确路径。原始日志：`D:\CodexTemp\xiaogui-coding-p1-evidence\focused-tests.log`。

最终工程复核只补跑 5 个直接相关文件，没有重复上述 101 项或全量测试：

```bat
node_modules\.bin\vitest.cmd run src/main/xiaogui/coding-extensions/safe-display-metadata.test.ts src/main/xiaogui/coding-extensions/permission-module.test.ts src/main/__tests__/worker-manager-extension-ui.test.ts src/renderer/src/lib/extension-ui-channel.test.ts src/worker/xiaogui-coding-extensions/context-extension.test.ts
```

结果：`5 test files passed`，`29 tests passed`，退出码 `0`。新增覆盖敏感摘要绕过、Worker 来源冒充、Renderer 完整契约校验，以及正文只进入临时 user-context、不进入 systemPrompt。原始日志：`D:\CodexTemp\xiaogui-coding-p1-evidence\boundary-tests.log`。

最终审查只针对新增的 POSIX 绝对路径边界补跑两个直接相关文件：

```bat
node_modules\.bin\vitest.cmd run src/main/xiaogui/coding-extensions/safe-display-metadata.test.ts src/main/xiaogui/coding-extensions/permission-module.test.ts
```

结果：`2 test files passed`，`21 tests passed`，退出码 `0`；覆盖单段路径以及 `> ; | &` 等 shell 分隔符后的绝对路径。原始日志：`D:\CodexTemp\xiaogui-coding-p1-evidence\sanitizer-final.log`。最终 Standards/Spec 复核结果均为 `APPROVE`，且确认未扩展至 P2、P3 或 WORK。

#### 类型检查、构建与差异检查

```powershell
npm run typecheck
npm run build
git diff --check
```

结果：最终边界修复后的类型检查和完整构建退出码均为 `0`；主进程、Preload、Renderer、Office Viewer、Office Gateway 均构建成功。构建仅保留既有动态导入/大 chunk 提示。最终构建日志：`D:\CodexTemp\xiaogui-coding-p1-evidence\build-final.log`。差异检查在最终暂存前执行。

#### 真实 Electron 冒烟

- 只执行一条桌面冒烟：`node D:\CodexTemp\xiaogui-coding-p1-evidence\p1-electron-turn-smoke.mjs`，退出码 `0`；没有另增 E2E 测试文件。
- 本机临时 OpenAI-compatible 模型桩收到且只收到一次真实 Electron Main → Worker → Pi Extension 发出的 Agent 请求；请求中包含 `src/answer.ts` 的当前正文和受控上下文标记，并确认正文位于 user-role context、systemPrompt 不含正文。
- Main IPC 公开快照不含源文本和项目绝对根；结构化证据只保存布尔检查、相对路径、SHA-256 和字节数，不保存请求正文。
- 真实 Renderer 先拒绝一份 `origin: worker` 的伪造 Coding 权限请求，再显示 Main 直发的权限对话框；界面精确展示 `src/answer.ts` 和三个冻结决定，并实际点击完成“允许一次”。
- 结构化证据：`D:\CodexTemp\xiaogui-coding-p1-evidence\p1-electron-smoke.json`。
- 可见证据：`D:\CodexTemp\xiaogui-coding-p1-evidence\p1-permission-dialog.png`。

### 已知风险

1. 快照在正式发送前才生成并立即消费；若进程在两步之间异常中断，未消费快照仍会在 10 分钟后主动删除，并受 64 条/8 MiB 总量硬上限保护。
2. 单次上下文总量上限 1 MiB、最多 20 个来源；大文件会明确标记截断，不能视为已读取全文。
3. 当前快照正文使用 UTF-8 文本回退；包含 NUL 的二进制会拒绝，但其他非 UTF-8 文本可能出现替换字符，后续 LSP/编码探测接入前不得声称语义完整。
4. Permission Task Rule 持久化在本机 TaskHub SQLite，仅绑定 Attempt、精确路径和私有动作摘要；没有新增账号或多人身份语义。
5. 当前生产 Kimi 仍未开放终端，云端 Adapter 也未接入外传事件，因此 `COMMAND` / `DATA_EGRESS` 的真实生产触发仍是后续运行时工作包边界。
6. 唯一 Electron 冒烟使用本机模型桩验证传输与 UI 接缝，不代表任一真实云模型的生成质量或语义能力。

### 下一阶段计划

本阶段双审和提交推送完成后停止，等待人工验收。人工验收通过后才进入 P2：只读计划阶段、计划卡修改/批准、Attempt 内 Todo、真实工作树 Diff 与验证证据；不提前施工 P3。

## 2026-08-31｜CODING-P1 P0 六个受控扩展契约与三接缝 Spike

### 阶段状态

- 状态：P0 契约、接缝 Spike、聚焦验证和双轴只读审查完成，等待人工验收
- 独立工作树：`D:\CodexWorktrees\xiaogui-coding-extension-pack-v1`
- 当前分支：`agent/coding-p1-pi-extension-pack-v1`
- 冻结基线：`planning-agent/agent/next-phase-prompt-office-v1@0f7d74bbe1e8e41aa3294f0d7f0cc9a919f2c937`
- 隔离边界：未修改正在施工 WORK 的工作树或分支；未合并阶段线、未发布、未制作 Portable

### 本阶段目标

1. 冻结 `XiaoguiCodingExtensionPackV1` 的六个受控 Coding Module manifest。
2. 冻结 Pi Extension、TaskHub、Renderer Extension UI 三条接缝使用的版本化窄契约。
3. 用进程内 Scripted Adapter 证明 `Pi Extension → TaskHub → Renderer` 的注册事件可以确定性往返。
4. 保证 P0 不注册生产工具、不启用生产模块、不改变现有 CODING、WORK 或 TaskHub 状态机。

### 实际修改文件

- `packages/shared/index.ts`
- `packages/shared/xiaogui-coding-extension-pack.ts`
- `packages/shared/xiaogui-coding-extension-pack.test.ts`
- `src/worker/xiaogui-coding-extensions/extension-pack.ts`
- `src/worker/xiaogui-coding-extensions/extension-pack.test.ts`
- `src/main/xiaogui/task-hub/coding-extension-seam-bridge.ts`
- `src/main/xiaogui/task-hub/coding-extension-seam-bridge.test.ts`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 新增 `CodingExtensionManifestV1`，冻结代码上下文与符号、权限、计划、Diff 审阅、Git 检查点、角色配置六个 Module 的编号、中文名称、能力与三条必需接缝。
2. 六个 Module 均固定为仅允许 `CODING`、`defaultEnabled: false`；P0 Pi Factory 只发出 `MODULE_REGISTERED`，不注册 hook 或工具。
3. 新增上下文、权限意图、计划草稿、审阅证据、检查点与角色配置六组共享 V1 契约，以及注册事件、TaskHub 回执、Renderer 投影和往返回执。
4. 注册事件运行时校验采用冻结 manifest 和精确字段集合；伪造能力、未知字段及夹带绝对路径会在进入 TaskHub 前失败关闭。
5. 新增单一 `dispatch` 接缝桥：TaskHub 必须先接受事件，Renderer 才能收到只含扩展编号、中文名称、序号和就绪状态的窄投影。
6. 用六个隐藏 Pi Module、Scripted TaskHub Port 和 Scripted Renderer Port 完成一次进程内往返，证明事件顺序、投影和回执一致。
7. 完成 Standards 与规格符合性两路只读审查；代码实现无 blocker，阶段收口要求已落实到本记录、独立提交和独立分支推送。

### 未完成内容

- P1 的 `@` 文件/符号上下文、LSP 降级、命令/写入/路径/外传权限对话框尚未施工。
- 六个 Module 尚未装配进生产 `worker-runtime`，也没有任何生产工具、Renderer 控件或 TaskHub 持久化行为。
- P2 的计划卡、Todo、真实工作树 Diff 和验证审阅尚未施工。
- P3 的检查点恢复、角色编辑及真实 Electron 联合旅程尚未施工。
- P0 没有可见生产 UI，因而本阶段以进程内三接缝 Scripted 往返作为冒烟证据；没有伪装成生产 Electron 功能已接通。
- 未运行全量测试、未合并阶段线、未覆盖 WORK 主线、未发布或制作 Portable。

### 与规格文档存在的偏差

- 无产品或架构决策偏差：实现继续复用 Pi Extension、Renderer Extension UI 和 TaskHub 三条冻结接缝，没有复制 Claude Code 源码，也没有引入第二套 Agent Loop、权限系统或任务状态机。
- P0 只证明契约和进程内 Scripted 往返，没有提前装配生产 runtime 或呈现 Renderer UI；这符合“先契约和 Spike，再替换生产功能”的阶段边界。
- 本阶段未修改 WORK、DESIGN、Univer Office Surface、DOCX HTML 或 PDF 降级路径。

### 测试命令和测试结果

#### TDD 与聚焦测试

新增契约、Pi 注册器、三接缝往返和绝对路径夹带防护均先观察到目标失败，再补最小实现至通过。

```powershell
.\node_modules\.bin\vitest.cmd run packages/shared/xiaogui-coding-extension-pack.test.ts src/worker/xiaogui-coding-extensions/extension-pack.test.ts src/main/xiaogui/task-hub/coding-extension-seam-bridge.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts src/main/direct-extension-ui.test.ts --reporter=dot
```

结果：`5 test files passed`，`15 tests passed`，退出码 `0`。其中包含现有 Scripted Runtime composition 和 Direct Extension UI 接缝回归。

#### 类型检查、构建和差异检查

```powershell
npm run typecheck
npm run build
git diff --cached --check
```

结果：三项退出码均为 `0`。主进程、Preload、Renderer、Office Viewer 和 Office Gateway 构建成功；仅有既有 chunk 体积提示，没有新增构建失败。

#### 基线债务复核

```powershell
.\node_modules\.bin\vitest.cmd run src/worker/xiaogui-prompt/session-extension.test.ts
```

结果：该既有 WORK 测试在本独立分支和未改动的基线 WORK 工作树均为 `2 failed / 4 passed`，失败原因是旧断言仍期望 `enabledCapabilities: ['work.file-organize']`，而当前基线返回空数组。P0 未修改 Prompt/WORK 文件，不在本包放宽或改写该测试。

### 已知风险

1. 当前三接缝桥是契约 Spike，没有持久化、重启恢复或生产 Renderer 生命周期，不能视为 P1-P3 已完成。
2. `CodingRoleProfileV1.systemPrompt` 已被冻结为契约字段；未来落地时必须作为本机私有配置处理，不得进入公开 TaskHub/Renderer 事件。
3. 六个 Module 后续接入生产时必须继续保持 TaskHub 为 Attempt、权限、工作树、验证和恢复的唯一权威。
4. 基线存在一项与本包无关的 WORK Prompt 测试债务，后续应由 WORK 主线单独修正，不能在 Coding 分支混改。
5. 构建复用 D 盘既有 `node_modules` Junction，未执行 `npm install` 或 `npm ci`；依赖内容由当前冻结基线提供。

### 下一阶段计划

本阶段结束后停止施工并等待人工或审查 Agent 验收。只有 P0 验收通过后，才在同一独立 Coding 分支进入 P1：

1. 实现项目范围内的 `@` 文件/符号上下文和明确 LSP 降级；
2. 接入命令、写入、路径与数据外传权限意图；
3. 复用现有 Extension UI 做“允许一次 / 允许本次任务中的相同规则 / 拒绝”；
4. 验证拒绝、超时、越界及重启恢复后，再提交独立 P1 验收点。

## 2026-08-31｜WORK 普通文档直达选择器与模板库右栏迁移

### 阶段状态

- 状态：代码修改、红绿回归、类型检查和真实 Electron 窗口冒烟完成，等待人工验收
- 当前分支：`agent/next-phase-prompt-office-v1`
- 修改基线：`97a2c8c1ce14c866cf2be70630d6f8fc4183db35`
- 合并与发布：未合并阶段线、未覆盖正式主线、未制作发布包

### 本阶段目标

1. 修复 WORK 首页在“新对话/无工作区”状态点击“整理普通文档”时，只显示“请先新建对话或打开一个工作区”而不弹文件选择框的问题。
2. 移除会与主区右上角折叠、刷新浮动控件重叠的标题栏“模板库”按钮，把本机模板库作为右侧栏栏目显示。

### 实际修改文件

- `packages/shared/right-panels.ts`
- `packages/shared/right-panels.test.ts`
- `src/renderer/src/features/side-panels/side-panel-host.tsx`
- `src/renderer/src/features/side-panels/side-panel-host.test.tsx`
- `src/renderer/src/lib/right-panel-catalog.tsx`
- `src/renderer/src/xiaogui/components/TemplateLibraryView.tsx`
- `src/renderer/src/xiaogui/components/WorkHomeView.tsx`
- `src/renderer/src/xiaogui/components/WorkHomeView.test.tsx`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 删除“只有已经存在临时草稿时才允许建立 WORK 工作区”的错误前置条件；没有工作区时，入口会自动建立内部 WORK 工作区、激活空白工作台，再由主进程打开受控 DOC/DOCX 选择器。
2. 用户取消选择时不发送提示词、不进入分析，也不再显示旧的“请先新建对话或打开一个工作区”错误。
3. 从 WORK 首页标题栏移除独立“模板库”文字按钮；最右侧“按模板生成”卡片仍可进入原有完整模板库视图。
4. 将“模板库”注册为核心右侧栏栏目，默认可见，并接入本机模板库真实内容与历史版本能力。
5. 为右侧栏增加紧凑布局：搜索、模板/回收站切换和单列模板卡片适配窄栏，不再与主区浮动按钮抢占位置。

### 未完成内容

- 尚未由用户选择一份真实 DOC/DOCX 完成“选择—分析—复核”的完整业务旅程；本阶段只证明选择器入口和模板库位置正确。
- 未改变已登记的“根据已选文件真实类型自动路由 PDF、DOC、DOCX 等能力”后续 P1；本次普通文档入口仍按既有 DOC/DOCX 接缝工作。
- 未运行全量测试、未制作 Portable、未合并阶段线或正式主线。

### 与规格文档存在的偏差

- 无新增模板资产、Univer Office Surface 或 Prompt/模式架构偏差；原文件只读、模板资产本机保存、Agent 结果先进入草稿/工作副本、人工确认后生成等冻结决定不变。
- DOCX HTML/PDF 降级路径未删除，模板领域状态机和 Univer 文档表面未修改。
- 为满足私有文档交接当前仍需先建立内部 WORK 工作区；若用户随后取消文件选择，会留下一个尚未产生会话和提示词的空内部工作区目录。这是本阶段最小修复的已知限制。

### 测试命令和测试结果

#### 红灯证据

```powershell
npm run test:unit -- src/renderer/src/xiaogui/components/WorkHomeView.test.tsx packages/shared/right-panels.test.ts src/renderer/src/features/side-panels/side-panel-host.test.tsx
```

生产代码修改前结果：`3 test files failed`。失败分别证明：无工作区时 `workspace.sandbox.create` 调用次数为 `0`、首页仍存在“模板库”按钮、右侧栏返回 `panel.unregistered`，且目录中不存在模板库栏目。

#### 修复后聚焦测试

```powershell
npm run test:unit -- src/renderer/src/xiaogui/components/WorkHomeView.test.tsx packages/shared/right-panels.test.ts src/renderer/src/features/side-panels/side-panel-host.test.tsx src/renderer/src/xiaogui/components/TemplateLibraryView.test.tsx
```

结果：`4 test files passed`，`16 tests passed`。

#### 类型检查

```powershell
npm run typecheck
```

结果：退出码 `0`。

#### 定向静态检查与差异检查

```powershell
node node_modules\eslint\bin\eslint.js packages/shared/right-panels.ts packages/shared/right-panels.test.ts src/renderer/src/features/side-panels/side-panel-host.tsx src/renderer/src/features/side-panels/side-panel-host.test.tsx src/renderer/src/lib/right-panel-catalog.tsx src/renderer/src/xiaogui/components/TemplateLibraryView.tsx src/renderer/src/xiaogui/components/WorkHomeView.tsx src/renderer/src/xiaogui/components/WorkHomeView.test.tsx
git diff --check
```

结果：两项均退出码 `0`。

#### Electron 真实窗口冒烟

```powershell
node node_modules\electron-vite\bin\electron-vite.js dev --remoteDebuggingPort 9333
```

- Main、Preload 和 Renderer 均启动成功；重启主进程后复核，排除了仅由热更新造成的旧右栏目录覆盖。
- 在“新对话/无工作区”状态点击“整理普通文档”，Windows 顶层窗口实查出现 `#32770` 原生对话框，标题为“选择要整理的普通成品 Word”；页面进入“正在打开…”且没有旧错误。关闭选择框后按钮恢复，未发送提示词。
- 真实右侧栏稳定显示“模板库”页签；点击后显示“本机模板库”、搜索框、模板/回收站及当前资产统计，主区标题栏不再显示重叠按钮。
- 可见截图证据：`D:\CodexEvidence\xiaogui\2026-08-31-work-home-picker-right-template-library\template-library-right-panel-restarted.png`（不提交仓库）。

### 已知风险

1. 用户取消普通文档选择后，已创建的空内部 WORK 工作区目录不会自动删除；它没有会话、提示词或所选文档内容，但长期多次取消可能产生少量空目录。
2. 模板库当前作为核心右侧栏栏目，在其他一级模式切换后仍可见；其行为仍是本机模板资产管理，不会改变 DESIGN、CODING 的任务状态机或 Agent 能力。
3. 开发环境存在与本阶段无关的可选 `better-sqlite3` 原生绑定警告；本阶段模板库通过既有降级路径正常显示，未修改 SQLite 装配。

### 下一阶段计划

停止施工并等待用户在当前已打开的小规窗口验收：

1. 直接点“整理普通文档”是否立即出现文件选择框；
2. 取消后是否可继续操作且没有旧错误；
3. 右侧“模板库”位置和紧凑布局是否符合预期。

验收通过前不进入文件类型自动路由、模板分析质量或其他功能阶段。

## 2026-08-31｜WORK 模型语义驱动的局部模板范围

### 阶段状态

- 状态：代码修改、聚焦测试、类型检查、完整构建和真实 Office Surface 浏览器冒烟完成，等待人工验收
- 当前分支：`agent/next-phase-prompt-office-v1`
- 修改基线：`98782a1`
- 合并与发布：未合并阶段线、未覆盖正式主线、未制作发布包

### 本阶段目标

修复模板整理把含有少量项目专属信息的整段文字整体标黄、整体变量化的问题。语义判断交给当前接入模型：模型在理解全文后直接引用需要变化、移除或人工判断的最小连续原文；程序不再用关键词或正则脚本替模型分类，只机械验证引用确实存在、重复文字指向明确、范围互不重叠，并把通过验证的精确范围交给字段图、Univer 和物化器。

### 实际修改文件

- `packages/shared/worker-host-tools.ts`
- `packages/shared/xiaogui-prompt-capabilities.ts`
- `packages/shared/xiaogui-work-docx-template-intake.ts`
- `src/worker/xiaogui-work-docx-template-intake-tool.ts`
- `src/worker/xiaogui-work-docx-template-intake-tool.test.ts`
- `src/main/xiaogui/work-docx-template-intake-worker-tool.ts`
- `src/main/xiaogui/work-docx-template-intake-service.ts`
- `src/main/xiaogui/work-docx-template-intake-service.test.ts`
- `src/main/xiaogui/template-intelligence/template-field-graph-builder-v2.ts`
- `src/main/xiaogui/template-intelligence/template-field-graph-builder-v2.test.ts`
- `src/main/xiaogui/office-surface/docx-univer-projection.test.ts`
- `src/main/xiaogui/work-docx-template-materializer.ts`
- `src/main/xiaogui/work-docx-template-materializer.test.ts`
- `src/main/__tests__/pi-prompt-catalog-effective.test.ts`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 模板分析 Prompt 升级为 `template-intake-analysis@1.1.0`：模型可先自由理解全文，只输出真正需要处理的原文片段；未输出内容默认保留，不再要求逐段分类。
2. 模型建议支持 `SELECTION` 和 `WHOLE_FRAGMENT`。通常由模型逐字返回 `selectedText`；只有整块确实需要处理时才允许整块建议。
3. Worker 对模型建议执行机械校验：原文不存在、重复文字未指定出现次序、范围重叠、跨片段局部选择或非法组合都会拒绝，并继续沿用“最多修复一次、之后安全降级”。模型不需要自行计算字符偏移。
4. 主进程候选契约新增 UTF-16 局部范围；同一段可以同时包含多个互不重叠的变量、排除项或待判断项，未被模型选择的前后文字原样保留。
5. 删除了主进程中按“签字、电话、旧项目”等中文关键词替模型进行文本风险分类的规则脚本。非文本对象的 OOXML 结构安全检查仍保留。
6. 字段图和 Univer 投影使用精确范围，同一句相同文字出现两次时可以只标黄模型指定的那一次；高风险文本也能定位到对应片段。
7. 物化器支持同一段内多个局部动作合并执行，例如只把项目名变成字段、只删除日期，而不改动段落其余格式和文字。

### 未完成内容

- 尚未让用户用真实业务文档和当前实际接入模型完成一次端到端人工验收；模型的语义质量仍取决于所选模型能力和文档质量。
- DOCX HTML 兼容降级视图仍保留；本阶段保证 Univer 主视图的精确范围，未扩展旧降级视图的每一种复杂对象局部标注能力。
- 图片、浮动对象、文本框等非纯文本内容仍依照既有结构检测和人工复核，不由本阶段的文本片段协议替代。
- 未运行全量测试、未制作 Portable、未合并阶段线或正式主线。

### 与规格文档存在的偏差

- 无新增产品架构偏差。仍遵循原文件只读、Agent 结果先进入草稿/工作副本、人工确认后才生成、Univer 单一主视图和保留 DOCX HTML/PDF 降级路径等冻结决定。
- 用户所说的“通过 skill 分析”在本阶段落为小规内部版本化分析 Prompt 与隐藏模板工具能力，而不是新增一个对用户公开的页面或规则引擎；语义决定由接入模型完成。
- 为避免模型输出不可靠偏移，偏移量由程序根据模型逐字引用的原文机械求得。这是数据完整性校验，不参与语义分类。

### 测试命令和测试结果

#### 红灯证据

修改生产实现前，新增用例分别复现：Prompt 仍为 `1.0.0`、同段项目名与日期被返回为整段候选，以及同一锚点的多个局部物化动作触发 `TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT`。这些用例在修复前均失败。

#### 修复后聚焦测试

```powershell
npm run test:unit -- src/worker/xiaogui-work-docx-template-intake-tool.test.ts src/main/xiaogui/work-docx-template-intake-service.test.ts src/main/xiaogui/template-intelligence/template-field-graph-builder-v2.test.ts src/main/xiaogui/work-docx-template-materializer.test.ts src/main/xiaogui/office-surface/docx-univer-projection.test.ts src/main/__tests__/pi-prompt-catalog-effective.test.ts
```

结果：`6 test files passed`，`33 tests passed`，退出码 `0`。覆盖空建议默认保留、重复文本出现次序、选择范围重叠拒绝、同段多变量、精确标黄和局部物化。

#### 类型检查与完整构建

```powershell
npm run typecheck
npm run build
```

结果：两项退出码均为 `0`。主进程、Renderer、Office Viewer 和 Office Gateway 构建成功；只有既有动态导入与 chunk 体积提示。

#### Office Surface 真实浏览器冒烟

```powershell
$env:XIAOGUI_OFFICE_BROWSER_PROFILE='D:\CodexTemp\xiaogui-partial-range-browser-20260831'
npm run smoke:office-browser
```

结果：`ok: true`。验证精确字段范围和黄色标记、正文/表格/页眉/页脚图片解码、Univer 真实挂载、字段更新、保存后重载及零页面/图片控制台错误。

#### Electron 环境门

```powershell
$env:XIAOGUI_OFFICE_SMOKE_USER_DATA='D:\CodexTemp\xiaogui-partial-range-smoke-20260831'
npm run smoke:office
```

结果：退出码 `1`，命中这台主机既有的 `Electron app ready timeout`。该脚本在 Office Viewer 载入前即超时，因此不能作为本阶段功能失败或通过的证据；真实 Office Surface 改由上述浏览器冒烟验证，没有伪装成功。

### 已知风险

1. 不同模型对“最小可变片段”的判断可能不同；程序只保证引用和落位正确，不把模型语义意见当成最终事实，仍须人工复核。
2. 同样文字在一个片段内重复时，模型必须给出第几次出现；否则建议会被拒绝并触发一次修复或安全降级。
3. 模型若漏掉可变内容，该处会按默认规则保留。后续可通过用户自然语言补充或在 Univer 中主动选择，而不应重新引入脚本猜测。
4. Electron 隐藏冒烟的主机就绪超时仍待单独诊断；本阶段没有扩大到 Electron 启动链修复。

### 下一阶段计划

等待人工验收本阶段。验收时使用一份同时含“固定前文 + 项目名 + 日期 + 固定后文”的真实 DOC/DOCX，重点确认只有项目名和日期被标黄、前后正文不变，并尝试在同一段补充一个人工选择。验收通过后再决定是否根据真实模型表现微调分析 Prompt；不得在未观察真实样本前新增关键词脚本或扩大规则体系。

## 2026-08-31｜WORK 普通文档路由与会话续发修复

### 阶段状态

- 状态：代码修改、聚焦测试、完整构建和真实 Electron 窗口冒烟完成，等待人工验收
- 当前分支：`agent/next-phase-prompt-office-v1`
- 修改基线：`0f7d74b`
- 合并与发布：未合并阶段线、未覆盖正式主线、未制作发布包

### 本阶段目标

修复用户单机试用中相互关联的两个 P0/P1 问题：

1. “整理普通文档”选择文件后必须稳定进入普通文档模板整理工具，不能误走通用资料扫描；
2. 候选报告生成后必须显示“开始复核”，点击直接打开复核界面，同时输入框仍允许继续发送自然语言；
3. Worker 退出或应用重新加载会话后，不得因为 Pi 会话头中的旧工作目录触发 `XIAOGUI_PROMPT_CONTEXT_SESSION_MISMATCH`；
4. 避免一次约 9 MiB 的旧 DOC 被错误路由为对当前目录的大范围扫描，造成超大工具结果、上下文压缩和看似卡顿的分段输出。

### 实际修改文件

- `packages/shared/xiaogui-prompt-capabilities.ts`
- `packages/shared/xiaogui-prompt-capabilities.test.ts`
- `src/main/worker-manager.ts`
- `src/main/__tests__/worker-manager-session-isolation.test.ts`
- `src/main/ipc/handlers/session.ts`
- `src/main/ipc/handlers/session-preview-invalidation.test.ts`
- `src/main/xiaogui/index.ts`
- `src/main/xiaogui/index.test.ts`
- `src/main/xiaogui/ipc-handlers.ts`
- `src/main/xiaogui/work-docx-template-intake-composition.ts`
- `src/main/xiaogui/work-materials-worker-tool.ts`
- `src/main/xiaogui/work-materials-worker-tool.test.ts`
- `src/renderer/src/xiaogui/components/WorkHomeView.tsx`
- `src/renderer/src/xiaogui/components/WorkHomeView.test.tsx`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. “整理普通文档”快捷入口的自动提示明确包含“整理成可复用模板”，Capability 推断会选择 `work.template-intake`，不再只暴露通用资料工具。
2. 模板整理装配记录当前尚未消费的已选文档；存在该交接时，通用资料工具的无路径调用会明确拒绝并要求改用模板整理工具，防止模型扫描整个当前目录。用户明确提供路径时，通用资料读取行为保持不变。
3. WorkerManager 新增仅主进程持有的可信会话工作区提示。会话重载时按“存活 Worker → 沙盒绑定 → 可信提示 → Pi 旧会话头”解析工作目录，不再把进程启动目录误当成用户会话目录。
4. 新建、打开、待绑定、Fork/Clone、删除和直接打开复核等接缝统一使用该解析结果；执行尝试和会话身份仍保持原有失败关闭规则。
5. 候选报告的按钮仍只由真实 `xiaogui_work_docx_template_intake` 成功工具事件生成，不从模型自然语言伪造。真实历史报告显示“开始复核”，点击直接打开 Univer 文档复核界面。
6. 真实旧会话在 Worker 已退出、Pi 会话头仍含旧 cwd 的条件下继续发送文字，模型正常回复“文字发送已恢复”，未再出现 `XIAOGUI_PROMPT_CONTEXT_SESSION_MISMATCH`。

### 未完成内容

- 本阶段没有改写模型供应商的增量流协议。此前“一卡一卡”的主要可复现原因是错误路由后扫描了大量目录内容并触发上下文压缩；修复后的新文档流程仍需用户用真实 DOC/DOCX 再观察供应商侧流式体感。
- 老式 `.doc` 仍需要既有 DOC→DOCX 转换能力；本阶段修复的是入口路由和会话续发，不扩大旧 DOC 格式还原范围。
- 没有替用户在原生选择器中选取新的真实业务文件，因此“新选择一个 DOC/DOCX → 新报告 → 复核”的最终业务内容质量仍由人工试用验收。
- 未运行全量测试、未制作 Portable、未合并阶段线或正式主线。

### 与规格文档存在的偏差

- 无新增架构偏差。仍遵循“真实工具事件驱动结构化控件”“Agent 修改只进入草稿/工作副本”“不删除 DOCX HTML/PDF 降级路径”的冻结决定。
- 本阶段只在存在尚未消费的模板整理文档时阻止通用资料工具的无路径扫描；这不是恢复已由用户撤销的通用 WORK 目录边界。显式相对路径和绝对路径仍可使用。
- 未修改 Pi 上游基础 `SYSTEM.md`；只修正小规 Capability/工具路由和主进程可信会话绑定。

### 测试命令和测试结果

#### 聚焦测试

```powershell
$env:XIAOGUI_TEST_TEMP='D:\CodexTemp\xiaogui-test-temp'
npm run test:unit -- packages/shared/xiaogui-prompt-capabilities.test.ts src/renderer/src/xiaogui/components/WorkHomeView.test.tsx src/main/xiaogui/work-materials-worker-tool.test.ts src/main/xiaogui/index.test.ts src/main/xiaogui/work-docx-template-intake-service.test.ts src/main/__tests__/worker-manager-session-isolation.test.ts src/main/ipc/handlers/session-preview-invalidation.test.ts src/main/xiaogui/ipc-handlers-scope-lookup.test.ts
```

结果：`8 test files passed`，`70 tests passed`，退出码 `0`。其中包含“Worker 退出后忽略旧 Pi cwd 并沿可信用户工作区 Fork”的回归测试。

#### 类型检查与完整构建

```powershell
npm run typecheck
npm run build
```

结果：两项退出码均为 `0`。主进程、Renderer、Office Viewer 和 Office Gateway 全部构建成功；只有既有动态导入与 chunk 体积提示。

#### Electron 真实窗口冒烟

- 以 `D:\AppData\Roaming1` 为隔离用户数据启动当前开发分支，CDP 端口 `9333`。
- 打开一个曾经会因旧工作目录报错的历史会话，发送“只回复‘文字发送已恢复’”；用户消息成功入会话，约 10 秒后收到模型回复“文字发送已恢复”，控制台无新的 Session Context mismatch。
- 打开含真实模板整理成功工具事件的历史报告，界面显示“开始复核”；点击后直接打开“模板草稿复核”及 Univer 文档工作表面，没有把“复核”写入输入框。

### 已知风险

1. Pi 会话文件头的 cwd 仍可能是进程启动目录；当前以主进程可信绑定覆盖它。若未来会话从未经过新建、打开或项目绑定入口，仍会回退到旧头信息并按原规则失败关闭。
2. 用户点击“整理普通文档”后若取消选择，不会留下模板交接标识，也不会触发通用扫描，行为保持安全取消。
3. 约 9 MiB 的 DOC 文件本身不是本次 1,668 文件扫描的原因；若文档内部含大量媒体或转换后极大，后续解析仍可能受既有资源上限约束并明确警告。
4. Univer 仍是 OOXML 原结构导入单机试验，不代表 Word 像素级保真或正式 DOCX Exchange。

### 下一阶段计划

等待人工验收本阶段。建议按以下顺序复测：

1. 点击“整理普通文档”并选择一个 DOCX，确认不再扫描整个目录；
2. 报告出现后直接点“开始复核”；
3. 关闭复核或返回对话后继续发送一句自然语言，确认不再“发送失败”；
4. 观察一次正常规模文档的增量输出体感，再决定是否另立供应商流式传输专项。

## 2026-08-31｜WORK 全类型资料读取与路径边界调整

### 阶段状态

- 状态：代码修改、聚焦验证、完整构建和真实窗口冒烟完成，等待人工验收
- 当前分支：`agent/next-phase-prompt-office-v1`
- 修改基线：`7e97304`
- 合并与发布：未合并阶段线、未覆盖正式主线、未制作发布包

### 本阶段目标

根据用户验收反馈，修正“整理资料”仍只是有界目录清单、Agent 只能读取少数格式的问题：

1. 用户点击“整理资料”后仍先打开原生文件夹选择器；
2. Agent 获得通用资料读取工具，对目录中的所有文件建立总账；
3. 普通文本和常见办公文档尽量提取正文，不支持语义读取的二进制仍进入总账并明确标为“仅元数据”；
4. 按用户明确决定，通用 WORK 资料读取不再受“只能访问已选文件夹”的路径边界限制，并允许把绝对路径提供给模型、聊天回复和工具结果；
5. 不把任意二进制“进入总账”伪装成已经理解其正文。

### 实际修改文件

- `packages/shared/worker-host-tools.ts`
- `packages/shared/xiaogui-prompt-capabilities.ts`
- `packages/shared/xiaogui-prompt-capabilities.test.ts`
- `packages/shared/xiaogui-prompt-matrix.ts`
- `packages/shared/xiaogui-prompt-matrix.test.ts`
- `packages/shared/xiaogui-work-materials.ts`
- `src/main/xiaogui/index.ts`
- `src/main/xiaogui/index.test.ts`
- `src/main/xiaogui/work-docx-template-intake-parser.ts`
- `src/main/xiaogui/work-materials-composition.ts`
- `src/main/xiaogui/work-materials-service.ts`
- `src/main/xiaogui/work-materials-service.test.ts`
- `src/main/xiaogui/work-materials-worker-tool.ts`
- `src/main/xiaogui/worker-host-tool-router.ts`
- `src/main/xiaogui/worker-host-tool-router.test.ts`
- `src/renderer/src/xiaogui/components/WorkHomeView.tsx`
- `src/renderer/src/xiaogui/components/WorkHomeView.test.tsx`
- `src/worker/handlers/worker-handlers-turn.test.ts`
- `src/worker/worker-host-tool-channel.ts`
- `src/worker/xiaogui-prompt/behavior-fixtures.test.ts`
- `src/worker/xiaogui-prompt/builder.test.ts`
- `src/worker/xiaogui-tool-guidelines-baseline.test.ts`
- `src/worker/xiaogui-work-materials-tool.ts`
- `src/worker/xiaogui-work-materials-tool.test.ts`
- `src/worker/xiaogui-worker-tools.ts`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 新增版本化 Worker→Main 能力 `xiaogui.work.materials.v1` 和隐藏工具 `xiaogui_work_read_materials`，只在 WORK 对应能力下暴露。
2. 工具可接收当前目录、相对路径或任意绝对路径；目录递归扫描，文件类型不再使用 DOCX/PDF 白名单过滤。
3. 文本类文件直接读取；DOCX、PPTX、XLSX、ODT、ODP、ODS、PDF、RTF、EPUB 复用 `officeparser/slim` 提取文本；其他格式仍返回绝对路径、扩展名、大小和“仅元数据”状态。
4. 所有读取失败、过大、截断、不支持语义解析、符号链接和解析异常都会作为逐文件警告返回，不静默漏项或伪装成功。
5. “整理资料”不再先在 Renderer 生成 200 项、4 层的清单，而是选择目录后直接让 Agent 调用通用资料工具；三个入口顺序继续保持“整理资料、整理普通文档、按模板生成”。
6. Prompt Capability、Tool Guidelines 和行为基线已同步实际工具能力，避免模型再次声称只有单文件/PDF 能力。
7. `officeparser/slim` 从主进程静态加载改为按需动态加载：主进程主包由约 5.10 MB 降到约 1.54 MB，解析器进入独立约 3.56 MB chunk，减少应用冷启动时无关办公解析代码加载。
8. 未修改 Pi 上游基础 `SYSTEM.md`；本阶段只更新小规叠加的 Capability、工具说明和模式行为层。

### 未完成内容

- “全部类型”表示所有文件都会进入总账，不表示小规已经拥有 CAD、视频、音频、压缩包、数据库或任意专有二进制的语义解析器；这些格式首期为元数据级。
- 仍保留资源安全上限：最多 2,500 个文件、1,000 个目录节点、16 层、单文件 20 MiB、单文件正文 100,000 字符、总正文 500,000 字符；超限会明确警告。
- 新建会话首条消息仍承担 Worker、Pi 会话壳、工具注册和模型连接冷启动。真实窗口本轮显示“思考了 8 秒”；后台预热尚未实施。
- 真实窗口中发现：在新会话首条消息被用户中止后，直接在同一会话重试可能出现 `XIAOGUI_PROMPT_CONTEXT_SESSION_MISMATCH`。新建会话可正常工作；该问题登记为下一独立修复项。
- 未运行全量测试、未制作 Portable、未合并阶段线或正式主线。

### 与规格文档存在的偏差

- 用户明确撤销了通用 WORK 资料能力中的两项旧约束：“只能访问用户选择的文件夹”和“不向模型/会话/公开工具结果暴露绝对路径”。本阶段按该新决定实施，并在长期总控中记录为对旧约束的局部取代。
- 该取代只适用于通用 WORK 资料读取，不改动模板资产、Univer 工作副本、模板库、Office 临时令牌和原文件不可变等已有专用契约。
- 未改变《Prompt 架构、模式边界与轻量智能推荐规格》的模式分层；只把 `work.file-organize` 的 Capability 与真实工具能力对齐。

### 测试命令和测试结果

#### 聚焦测试

```powershell
$env:XIAOGUI_TEST_TEMP='D:\CodexTemp\xiaogui-test-temp'
npm run test:unit -- <12 个 WORK 资料、Prompt、Worker、Router、首页和模板解析相关测试文件>
```

结果：`12 test files passed`，`69 tests passed`，退出码 `0`。

#### 类型检查、构建与差异检查

```powershell
npm run typecheck
npm run build
git diff --check
```

结果：三项退出码均为 `0`。完整主构建、Renderer、Office Viewer 和 Office Gateway 构建成功；只有既有 chunk 体积与动态导入提示，没有新增构建失败。

#### Electron 真实窗口冒烟

- 使用 D 盘隔离目录 `D:\CodexTemp\xiaogui-work-materials-stage\mixed-folder`，内含 JSON 文本与 PNG 图片。
- 在全新 WORK 会话要求读取该绝对路径；模型实际调用 `xiaogui_work_read_materials`，首轮界面显示“思考了 8 秒”。
- JSON 返回 `CONTENT_EXTRACTED`、绝对路径和正文摘要；PNG 返回 `METADATA_ONLY`、绝对路径、类型、大小及 `FORMAT_NOT_SEMANTICALLY_SUPPORTED`，没有假装理解图片内容。
- 成功证据：`D:\CodexTemp\xiaogui-work-materials-stage\materials-tool-success.png`；首页证据：`D:\CodexTemp\xiaogui-work-materials-stage\work-home-all-materials.png`。证据不提交仓库。

### 已知风险

1. 用户已允许把绝对路径放入模型输入、聊天和工具结果，路径中可能包含人员名、项目名或内部目录结构；这是已接受的新产品边界，不再由产品自动隐藏。
2. 任意路径读取扩大了模型可请求的本机资料范围；当前仍需要模型主动调用工具，且受文件数量、深度、体积和字符预算限制，但不再有选定目录边界。
3. 不支持格式只有元数据，用户若要求内容级理解仍需后续专用解析器或转换能力。
4. 首句冷启动尚未优化；建议下一阶段做“主界面可见后异步预热 Worker/Pi 会话壳”，不得阻塞界面、不得提前调用模型或消耗额度。
5. 开发环境仍有与本阶段无关的可选 `better-sqlite3` 原生绑定警告，不影响本次通用资料工具成功运行。

### 下一阶段计划

等待人工验收本阶段。验收通过后优先单独处理：

1. 主界面显示后的轻量后台预热，并对比预热前后首句耗时；
2. 新会话首条消息被中止后重试的 Session Context 不匹配；
3. 再按真实业务需要逐项补充 CAD、表格高级结构、图片 OCR、压缩包等专用解析器，不把“全类型总账”误写为“全格式正文理解”。

## 2026-08-31｜WORK 三个快捷入口受控选择修复

### 阶段状态

- 状态：代码修改、聚焦测试和真实窗口接缝验证完成，等待人工验收
- 当前分支：`agent/next-phase-prompt-office-v1`
- 修改基线：`157447b`
- 合并与发布：未合并阶段线、未覆盖正式主线、未制作发布包

### 本阶段目标

把 WORK 首页三个快捷项从“只向输入框填写一句提示词”改为可测试的受控入口，并保持最终顺序：

```text
整理资料 → 整理普通文档 → 按模板生成
```

目标交互为：

1. `整理资料`：打开原生文件夹选择器，取得受控的相对目录清单后自动进入会话；
2. `整理普通文档`：打开原生 DOC/DOCX 选择器，源文件路径只留在主进程，随后自动启动既有只读模板分析；
3. `按模板生成`：打开本机历史模板库，选择模板或版本后自动进入既有生成会话。

### 实际修改文件

- `packages/shared/ipc-channels.ts`
- `src/main/xiaogui/ipc-handlers.ts`
- `src/main/xiaogui/work-docx-template-intake-composition.ts`
- `src/main/xiaogui/work-docx-template-intake-service.ts`
- `src/main/xiaogui/work-docx-template-intake-service.test.ts`
- `src/renderer/src/features/composer/composer.tsx`
- `src/renderer/src/lib/composer-quick-submit.ts`
- `src/renderer/src/lib/composer-quick-submit.test.ts`
- `src/renderer/src/xiaogui/components/WorkHomeView.tsx`
- `src/renderer/src/xiaogui/components/WorkHomeView.test.tsx`
- `src/renderer/src/xiaogui/components/TemplateLibraryView.tsx`
- `src/renderer/src/xiaogui/components/TemplateLibraryView.test.tsx`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 三个快捷项不再调用旧的 `setComposerPrefill`：文件夹和文档先完成原生选择，历史模板先进入模板库。
2. 文件夹入口复用已有 `workspace.fs.listDir` 安全边界，递归生成相对目录清单：最多 200 项、40 个目录、4 层，并跳过 `.git` 与 `node_modules` 深入遍历。
3. 文件夹的绝对根路径不写入自动发送的提示词；Agent 后续只按已激活工作区中的相对路径读取资料。
4. 新增主进程专用的普通文档选择通道。Renderer 只收到显示文件名；源路径以项目不透明编号临时暂存 15 分钟，并由下一次模板整理 `START` 一次性消费。
5. 模板整理服务允许消费只有源路径的直接选择交接；原有带 SHA-256 的旧模板生成交接仍继续校验摘要，行为不变。
6. 本机模板库的“使用最新版”和“使用此版本”改为选择后自动发送无路径请求；提示词只包含模板名称和版本号，不包含内部编号或资产路径。
7. 新增 Composer 内部快速提交事件，程序化填入后直接走现有 `sendCurrent` 正式发送链，不复制第二套会话发送逻辑。
8. 真实 Electron 窗口已确认三个按钮顺序正确，并分别验证：
   - `整理资料` 打开标题为“选择项目目录”的 Windows 原生对话框；
   - `整理普通文档` 打开标题为“选择要整理的普通成品 Word”的 Windows 原生对话框；
   - `按模板生成` 进入“本机模板库”页面。

### 未完成内容

- 本轮没有改造左下角通用“添加文件”附件通道；其绝对路径序列化问题仍是独立待办。三个首页快捷入口已经绕开该旧通道。
- 自动识别任意上传文件并在 PDF、DOC、DOCX 等能力间统一路由仍属于后续 P1，不由本轮 DOC/DOCX 专用入口代替。
- 本机尚未配置模板库目录，因此真实窗口只验证到历史模板选择页面；模板版本选择后的自动发送由组件测试覆盖，仍需用户用自己的模板库完成最终验收。
- 为避免擅自把真实业务文档交给模型，自动化没有替用户选中真实 DOC/DOCX；选择后的完整分析结果留给人工验收。
- 未运行全量测试、未制作 Portable、未合并或发布。

### 与规格文档存在的偏差

- 保持自然语言为主入口；三个快捷项只承担用户已经确认的必要选择和启动动作，没有新增独立业务状态机。
- 普通文档仍复用模板资产化规格中的只读分析、人工复核、原文件不可变和既有降级路径；没有修改 Univer、DOCX HTML 或 PDF 降级实现。
- Prompt 架构、模式边界和轻量推荐契约没有变化；快速入口发送的仍是普通 WORK 用户消息。
- 本轮没有解决通用附件路径令牌化，已明确登记为差距，没有伪装为完成。

### 测试命令和测试结果

#### 红灯证据

```powershell
node node_modules\vitest\vitest.mjs run src\renderer\src\xiaogui\components\WorkHomeView.test.tsx src\renderer\src\xiaogui\components\TemplateLibraryView.test.tsx --reporter=verbose --pool=threads
```

生产实现前结果：`2 test files failed`；失败原因为受控快速提交模块尚不存在，证明新交互断言先于实现生效。

#### 修复后聚焦测试

```powershell
$env:XIAOGUI_TEST_TEMP_ROOT='D:\CodexTemp'
node node_modules\vitest\vitest.mjs run src\renderer\src\lib\composer-quick-submit.test.ts src\renderer\src\xiaogui\components\WorkHomeView.test.tsx src\renderer\src\xiaogui\components\TemplateLibraryView.test.tsx src\main\xiaogui\work-docx-template-intake-service.test.ts --reporter=verbose --pool=threads
```

结果：`4 test files passed`，`13 tests passed`，退出码 `0`。

#### 类型检查

```powershell
npm run typecheck
```

结果：Web 与 Node 两段 TypeScript 检查均通过，退出码 `0`。

#### Electron 构建与真实窗口验证

```powershell
node node_modules\electron-vite\bin\electron-vite.js dev --remoteDebuggingPort 9333
```

- Main、Preload 构建成功，Renderer 服务启动成功。
- 首次热更新保留了旧主进程白名单，真实窗口捕获到 `IPC channel not allowed`；重启开发应用后新 Main/Preload 生效，错误不再出现。
- 通过 `agent-browser` 连接 9333 CDP 检查真实 Electron 页面；当前环境未提供 Browser plugin，因此没有使用该插件。
- Windows 顶层窗口实查到“选择项目目录”和“选择要整理的普通成品 Word”两个 `#32770` 原生对话框。
- 历史模板按钮实查进入“本机模板库”。
- 可见截图：`D:\CodexTemp\xiaogui-work-quick-actions-evidence\work-quick-actions.png`（不提交仓库）。

### 已知风险

1. 文件夹清单是有界清单；超过 200 项、40 个目录或 4 层时不会继续展开，后续需要增加明确的“清单未完全展开”提示。
2. 同一项目在 15 分钟内由多个窗口同时选择不同文档时，当前项目级临时交接以最后一次选择为准；单窗口正常使用不受影响。
3. 快速入口仍依赖当前 WORK 模型正确调用既有模板整理工具；源文件接缝已建立，但模型和真实业务文档质量需人工验收。
4. 开发环境仍存在与本阶段无关的可选 `better-sqlite3` 索引原生绑定警告，不影响三个入口或模板私有存储的既有降级行为。

### 下一阶段计划

等待用户在当前已打开的小规窗口完成三条旅程验收。若发现问题，只修本阶段入口接缝；验收通过前不进入统一附件令牌化、PDF/DOC 自动路由或其他功能阶段。

## 2026-08-31｜WORK 首页快捷项顺序调整

### 阶段状态

- 状态：人工验收未通过；仅完成顺序，三项业务入口当时无法选择文件或历史模板。后续修复见上方“WORK 三个快捷入口受控选择修复”阶段
- 当前分支：`agent/next-phase-prompt-office-v1`
- 修改基线：`72ee27a`
- 合并与发布：未合并阶段线、未覆盖正式主线、未制作发布包

### 本阶段目标

根据用户最终确认，把 WORK 首页三个快捷项的显示顺序固定为：

```text
整理资料 → 整理普通文档 → 按模板生成
```

本阶段只调整显示顺序，不把尚未完成的文件夹选择、文档选择和模板库联动伪装为已完成。

### 实际修改文件

- `src/renderer/src/xiaogui/components/WorkHomeView.tsx`
- `src/renderer/src/xiaogui/components/WorkHomeView.test.tsx`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 将“整理普通文档”移动到中间位置。
2. 将“按模板生成”移动到最右位置。
3. 新增按 DOM 实际顺序核对三个快捷项的回归断言，防止后续再次换位。
4. 在正在运行的小规 Electron 窗口中确认真实顺序正确；点击中间项后，输入框填入“整理普通文档”的对应提示词，未出现控制台错误。

### 未完成内容

- 三个快捷项目前仍沿用“填写提示词”的旧实现；用户要求的原生文件夹选择、原生文件选择和历史模板选择尚未在本阶段施工。
- 通用附件发送时的绝对路径展示与会话接缝问题不属于本次纯顺序调整，仍需独立修复。
- 未运行全量测试、未制作 Portable、未合并或发布。

### 与规格文档存在的偏差

- 本次顺序调整未改变模板资产、Univer Office Surface、Prompt 分层或模式边界等冻结决策。
- 现有“快捷项只填写提示词”的实现与用户新确认的直接选择器交互存在已知差距；本阶段明确保留并登记，没有宣称已经完成三条业务旅程。

### 测试命令和测试结果

#### 红灯证据

```powershell
node node_modules\vitest\vitest.mjs run src\renderer\src\xiaogui\components\WorkHomeView.test.tsx --reporter=verbose --pool=threads
```

修改生产顺序前结果：`1 failed | 3 passed`；失败差异明确显示旧顺序为“整理资料、按模板生成、整理普通文档”。

#### 修复后聚焦测试

同一命令修复后结果：`1 test file passed`，`4 tests passed`。

#### Electron 可见检查

- 环境：`http://localhost:5173/`，窗口标题“小规 Agent”，通过现有 Playwright 连接 `9333` CDP；未安装新依赖。
- 页面结果：三个按钮的实际无障碍名称依次为“整理资料、整理普通文档、按模板生成”。
- 交互结果：点击“整理普通文档”后，编辑区出现对应提示词；捕获到的相关 console error/page error 为 `0`。
- 框架错误遮罩数量：`0`。
- 截图证据：`D:\CodexTemp\xiaogui-work-shortcuts-order-20260831.png`（不提交仓库）。

### 已知风险

1. 本次只证明显示顺序与快捷项原有填词行为正确，不代表三个快捷项的最终业务交互已经实现。
2. 真实目录整理仍缺少受控的目录清单能力；不能让模型依赖任意终端命令替代产品能力。
3. 历史模板选择应复用本机模板库并保持路径、内部编号不进入公开会话，后续契约需先冻结。

### 下一阶段计划（历史，已被 2026-09-02 Skill/插件优先决策取代）

以下内容记录当时计划，不再是当前施工指令。当前工作必须先执行根 `AGENTS.md` 与 `doc/adr/ADR-PI-NATIVE-SKILL-PLUGIN-FIRST.md` 的 Pi/Skill/插件复用门。

当时计划为：等待人工验收本阶段；验收通过后，按当时确认的交互分别冻结并实现：

1. “整理资料”直接打开文件夹选择器并通过受控目录清单交给 Agent；
2. “整理普通文档”直接打开文件选择器，按真实类型自动路由并开始分析；
3. “按模板生成”直接打开历史模板选择界面，选择后进入生成流程；
4. 通用附件改用不暴露绝对路径的私有令牌通道，并单独修复发送接缝。

## 2026-08-31｜历史 P1：WORK 文档类型识别与能力路由（已被 2026-09-02 Skill/插件优先决策取代）

### 登记状态

- 优先级：P1
- 状态：历史登记；已由 `doc/adr/ADR-PI-NATIVE-SKILL-PLUGIN-FIRST.md` 取代，不得据此启动中央路由或统一令牌框架施工
- 关联现象：点击“整理普通文档”后，在尚未完成统一文件选择的情况下，模型反问用户是否选择 PDF，并错误声称当前只能选择 PDF
- 影响判断：上一阶段已经修复“三个预设入口无法发送”，但完整的 WORK 文档入口旅程尚未通过产品验收

### 预期产品行为

1. 用户已经上传或选择文件时，由主进程结合扩展名、MIME 与文件头识别类型，不再反问用户文件是不是 PDF。
2. PDF 自动进入 PDF 阅读/分析能力；DOC/DOCX 自动进入普通成品文档整理能力。
3. 用户尚未选择文件时，打开统一文档选择器；选择后再按真实类型路由。
4. 仅在格式不支持、文件损坏、加密或类型确实无法判断时向用户询问。
5. Effective Prompt Manifest、Capability 注册表、实际 Tool 列表和界面文案必须一致，不得让模型虚构“只加载了 PDF 选择器”等能力事实。

### 后续施工边界

- 检查附件元数据与文件头识别、统一选择器、Capability/Tool 暴露和 Prompt Manifest 一致性。
- 不借本问题修改模板领域状态机、Univer 文档工作表面、DESIGN、CODING 或 TaskHub。
- 先做契约与真实工具清单 Spike，再实施最小修复；完成后按独立阶段提交测试证据并等待人工验收。

### 后续验收要点

- 已选 PDF：不询问格式，直接进入 PDF 路由。
- 已选 DOC/DOCX：不询问格式，直接进入模板整理路由。
- 未选文件：打开统一选择器，选择后自动路由。
- 不支持或无法判断：明确说明原因并再询问用户。
- 三个预设入口的模型答复不得与本机实际工具能力矛盾。

## 2026-08-30｜WORK 三个预设入口发送失败热修

### 阶段状态

- 状态：代码修改与自测完成，等待人工验收
- 当前分支：`agent/next-phase-prompt-office-v1`
- 修改基线：`5bda1ca`
- 合并与发布：未合并阶段线、未覆盖正式主线、未制作发布包

### 本阶段目标

修复 WORK 首页三个预设入口在新临时对话中填入提示词后，发送流程因历史会话列表中的旧记录触发 `cwd_not_trusted` 而整体中断的问题。

本阶段只修复共用的“新会话首条消息发送”接缝，不改变三个预设提示词、WORK 能力边界、模板状态机、Univer 文档表面或 Prompt 分层架构。

### 实际修改文件

- `src/main/ipc/handlers/session.ts`
- `src/main/ipc/handlers/session-preview-authorization.test.ts`
- `src/renderer/src/lib/new-session.ts`
- `src/renderer/src/lib/new-session.test.ts`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 会话列表改为逐条授权：某条旧会话、损坏会话或不可信会话校验失败时，仅隐藏该行，不再使整个会话列表失败。
2. 旧记录被隔离时只记录错误类别，不记录本机绝对路径。
3. 新会话创建后的侧栏刷新改为非阻断操作：刷新失败时沿用当前本地列表并加入新会话，不再阻断首条消息发送。
4. 新增两条回归用例，分别覆盖：
   - 单条不可信历史记录不影响其余会话列表；
   - `session.list` 失败不影响新会话首条消息继续发送。
5. 在真实 Electron 窗口逐一验证三个预设入口：
   - `整理资料`：提示词成功发送并收到模型回复；
   - `按模板生成`：提示词成功发送并收到模型回复；
   - `整理普通文档`：提示词成功发送并收到模型回复。

### 未完成内容

- 未验证三个入口后续的完整文件选择、模板分析、复核和正式生成旅程；这些不是本次“发送失败”热修范围。
- 未迁移或自动修复磁盘上的旧会话头信息；不可信旧记录目前采取安全隐藏。
- 未修复模型对本机工具能力的错误描述，例如模板入口回复中可能声称“当前只加载了 PDF 选择器”。该问题需作为下一独立阶段处理。
- 未运行全量测试、未制作 Portable、未合并阶段线或正式主线。

### 与规格文档存在的偏差

- 本阶段没有改变《模板资产化产品改造规格》的字段图、异常驱动复核、原文件不可变和人工确认规则。
- 本阶段没有改变《Univer Office Surface 开发实施规格》的 DocumentSurface、OOXML 真值、降级路径和依赖边界。
- 本阶段没有改变《Prompt 架构、模式边界与轻量智能推荐规格》的 WORK/ASK/PLAN/EXECUTE、Capability、Tool 和模式推荐规则。
- 实际代码与规格目标无新增偏差；“模板入口的模型工具能力描述不准确”是既有未完成项，已列入风险，不在本热修中静默扩展。

### 测试命令和测试结果

#### 红灯证据

```powershell
npm exec vitest -- run src/renderer/src/lib/new-session.test.ts src/main/ipc/handlers/session-preview-authorization.test.ts --reporter=verbose
```

修改前结果：`2 failed | 11 passed`。两项失败均复现 `cwd_not_trusted` 阻断发送/列表的原始问题。

#### 修复后聚焦测试

同一命令修复后结果：`2 test files passed`，`13 tests passed`。

#### 类型检查

```powershell
npm run typecheck
```

结果：退出码 `0`。

#### Electron 构建与真实窗口冒烟

```powershell
node node_modules\electron-vite\bin\electron-vite.js dev --remoteDebuggingPort 9333
```

结果：Main 和 Preload 构建成功，Renderer 开发服务启动成功。真实窗口依次发送三个预设提示词，Worker 均收到 `prompt`，界面均显示模型回复，未出现 `Send failed`。截图证据保存在 D 盘临时验证目录，不提交仓库。

### 已知风险

1. 不可信旧会话记录仍在磁盘中，只是被列表安全隔离；以后若需要恢复这些记录，应另立迁移工作包。
2. 模板类预设入口的模型回复与实际 Tool 暴露可能不一致，可能降低用户对功能的判断；需单独核对 Effective Prompt Manifest、Capability 和实际 Tool 列表。
3. 本次只证明预设提示词能够成功发送并获得回复，不代表后续模板全流程已经验收。
4. 开发环境仍存在与本阶段无关的可选 SQLite 索引原生绑定警告，不影响本次发送链路。

### 下一阶段计划

等待人工验收本阶段。通过后再单独建立“WORK 预设提示词与实际工具能力一致性”阶段，先用真实 Prompt Manifest 和 Tool 列表做 Spike，再决定是否修改提示词或运行时能力装配；未经批准不进入下一阶段。
