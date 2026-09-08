# Windows DOC 转换资源

`convert-doc.ps1` 是小规自有的 Microsoft Word COM 适配脚本，不包含或分发 Word 本体。部署前提为 Windows 且本机已安装、可正常启动 Word。本轮实际验证版本为 `16.0.20326.20132`，不据此宣称所有 Word 版本均已验收。

Main 的 `WordPrivateConverterV1` 每次创建独立目录，只写入已过原 DOC 安全门的私有 `source.doc`；脚本禁用宏、只读打开并另存 `converted.docx`，不接收模型或 Renderer 提供的任意脚本内容。

脚本新建 Word 实例并以自建空白窗口取得 PID，确认不属于启动前的 Word 进程后记录 PID、创建时间和程序路径。正常结束仅关闭本次创建的文档及实例；超时/取消后通过 Cleanup 检查三项身份，仅终止该进程。身份无法确认或清理失败时不杀其他 Word，Adapter 保留私有现场并报错。COM 创建阶段若在取得实例身份前卡住，不按名称清理 Word，可能需要人工处理该未确认实例。

Windows 安装包通过 extraResources 放入 `resources/word-converter`；开发时直接读取仓库同名目录。原 LibreOffice 资源仍按既定打包流程保留，DOC 转换失败不会转向它。
