# LibreOffice 运行时装配位置

此目录在 Git 中保留本说明；二进制只装配到已忽略的 `runtime/` 子目录。执行
`npm run prepare:libreoffice` 后，脚本会从 Document Foundation 官方地址下载
LibreOffice 26.2.5、校验 SHA-256，并使用 D 盘缓存准备 Windows x64 私有运行时。
对应源码固定为 https://download.documentfoundation.org/libreoffice/src/26.2.5/ 。

正式制作 Windows 内部试用包时才需要执行；日常开发和结构化降级复核不需要下载。
