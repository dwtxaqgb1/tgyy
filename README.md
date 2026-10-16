
# 天光云影 云影空蒙 配置云同步 Worker

基于 Cloudflare Workers + KV 的个人 IPTV 配置管理工具。为「天光云影」和「云影空蒙」两款 App 提供云同步配置，附带频道合并、文件上传、密码保护等功能。

---

## ✨ 功能

### 天光云影同步配置
- 直播源名字 / 地址 / UA / EPG 节目单
- 混合模式（禁用 / 直播源优先 / 混合优先）
- 频道分组解析 + 隐藏设置
- 播放源有效性检测（弹窗提示）

### 云影空蒙同步配置
- 订阅源名称 / 地址 / EPG / UA

### 频道合并
- 支持最多 5 个 URL 源或本地文件源
- 解析各源频道分组，自由勾选顺序合并
- 地址替换规则（把公网地址替换为内网地址）
- 生成后可公开访问的 M3U 链接

### 文件上传
- 支持 m3u / txt 文件，单个最大 1MB，最多 3 个

### 安全
- 访问密码保护（6-12 位）
- Cookie 保持登录状态
- 支持的路径：`/all_configs.json`、`/yykm.json` 公开访问（供 App 拉取）

---

## 🚀 部署

### 前置条件
- Cloudflare 账号
- 已创建 KV 命名空间

### 步骤

1. **Cloudflare Dashboard** → **Workers & Pages** → **创建 Worker**

2. 打开 Worker 的**代码编辑器**，全选删除，粘贴 `worker.js` 的内容 → **Save and Deploy**

3. **绑定 KV**：
   - Worker 设置 → **Settings** → **Variables and Secrets**
   - **KV Namespace Bindings** → **Add binding**
   - Variable name：`CONFIG_KV`
   - KV namespace：选择你的命名空间

4. **访问 Worker 域名**（形如 `https://xxx.workers.dev`）
   - 首次访问会要求设置访问密码（6-12 位）
   - 设置后进入管理界面

---

## 📖 使用说明

### 天光云影配置

打开首页 → **天光云影同步配置**：

| 字段 | 说明 |
|---|---|
| 名字 | 直播源名称，留空则自动生成 `iptvYYYY-MM-DD HH:MM:SS` |
| 地址 | M3U 播放列表地址 |
| UA | 播放器 User-Agent，用于请求播放源时伪装身份 |
| EPG | 节目单地址（可选） |
| 模式 | 混合模式：禁用 / 直播源优先 / 混合优先 |

底部显示**云同步地址**，复制后填入 App 的云同步配置：
