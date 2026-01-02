# Cloudflare R2 Transit Station (文件中转站)

这是一个基于 Cloudflare Workers、R2 和 KV 构建的轻量级文件中转站。支持文件上传、下载、阅后即焚、下载次数限制、自动过期清理以及全局容量控制。

现在支持完整的管理员 API，方便集成到前端面板或通过脚本管理。

## ✨ 功能特性

*   **临时存储**: 利用 R2 对象存储，便宜且高速。
*   **短 Token 下载**: 上传时指定 Token，下载链接简洁友好 (e.g., `/share/my-token`)。
*   **下载限制**:
    *   **阅后即焚**: 支持下载一次后自动删除。
    *   **次数限制**: 支持设置最大下载次数。
*   **自动过期**: 支持设置文件有效期（小时），Worker 定时任务自动清理过期文件。
*   **容量控制**:
    *   **单文件限制**: 最大 300MB。
    *   **全局限制**: 总存储超过 9GB 时拒绝新上传。
*   **管理功能**: 全面的 Admin API，支持列出、增删改查文件及元数据、统计容量。

## 🚀 快速部署 (GitHub 集成)

### 第一步：准备 Cloudflare 资源
在部署代码前，请先创建必要的存储资源：

1.  **创建 KV Namespace**: 
    *   进入 [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) -> "KV"。
    *   点击 "Create a namespace"，命名为 `TRANSIT_KV`。
2.  **创建 R2 Bucket**: 
    *   进入 [R2](https://dash.cloudflare.com/?to=/:account/r2) -> "Create bucket"。
    *   命名为 `transit-bucket`。

### 第二步：Fork 与连接仓库
1.  **Fork 本仓库**: 点击右上角的 "Fork" 按钮将此项目复制到你的 GitHub 账号。
2.  **登录 Cloudflare Dashboard**: 进入 [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)。
3.  **创建应用**: 点击 "Create application" -> "Connect to Git"。
4.  **选择仓库**: 选择你刚刚 Fork 的 `cf-r2-transit-station` 仓库。
5.  **配置构建**: 保持默认设置，点击 "Save and Deploy"。

### 第三步：配置资源绑定 (关键)
部署完成后，Worker 此时还无法工作，需要将第一步创建的资源绑定到该 Worker：

1.  进入你刚才创建的 Worker 详情页，点击 **"Settings" (设置)** -> **"Variables" (变量)**。
2.  **KV Namespace Bindings**: 点击 "Add binding"。
    *   Variable name: `KV`
    *   KV Namespace: 选择 `TRANSIT_KV`。
3.  **R2 Bucket Bindings**: 点击 "Add binding"。
    *   Variable name: `BUCKET`
    *   R2 Bucket: 选择 `transit-bucket`。
4.  **Environment Variables**: 点击 "Add variable"。
    *   Variable name: `ADMIN_PASSWORD`
    *   Value: 设置你的管理员密码。
5.  **重新部署**: 绑定完成后，转到 **"Deployments"** 标签页，点击最新的一次部署旁边的三个点，选择 **"Retry deployment"**（或者随便修改下代码提交一次 GitHub 触发自动更新）。

## 🛠 API 使用说明

所有接口的基础 URL 为你的 Worker 地址 (例如 `https://your-worker.your-subdomain.workers.dev`)。

### 1. 公开接口

#### 上传文件
*   **接口**: `PUT /niupanel/upload`
*   **参数** (URL Query):
    *   `token` (Required): 自定义短 Token。
    *   `expire` (Optional): 过期时间（小时），默认 24。
    *   `burn` (Optional): 是否阅后即焚 (`true` / `false`)。
    *   `limit` (Optional): 限制下载次数。
    *   `password` (Optional): 下载密码。
*   **Body**: 文件二进制内容。

#### 下载文件
*   **接口**: `GET /share/<token>`
*   **Headers**: `X-Share-Password` (如果设置了密码)。

### 2. 管理员接口 (Admin API)

所有管理员接口需携带 Header: `X-Admin-Auth: <你的ADMIN_PASSWORD>`。

#### 列出文件
*   **接口**: `GET /admin/files`
*   **参数**: `cursor` (分页), `limit` (默认 50)。
*   **响应**: 返回文件列表及元数据。

#### 获取存储统计
*   **接口**: `GET /admin/stats`
*   **响应**:
    ```json
    {
      "currentUsageBytes": 102400,
      "maxUsageBytes": 9663676416,
      "usagePercent": "0.00%",
      "maxFileSizeContent": 314572800
    }
    ```

#### 获取文件详情
*   **接口**: `GET /admin/files/<token>`

#### 管理员上传
*   **接口**: `POST /admin/files`
*   **参数**: 同公开上传接口 (`token`, `expire` 等)。

#### 更新文件元数据
*   **接口**: `PATCH /admin/files/<token>` (或 `PUT`)
*   **Body** (JSON):
    ```json
    {
      "downloadsRemaining": 100,
      "deleteOnDownload": false,
      "expiresAt": 1735800000000,
      "password": "newpassword"
    }
    ```

#### 删除文件
*   **接口**: `DELETE /admin/files/<token>`

#### 清空所有数据
*   **接口**: `DELETE /admin/purge`

## 📦 本地开发 / CLI 部署

如果你更喜欢使用命令行 (Wrangler):

1.  **安装依赖**: `npm install`
2.  **创建资源**:
    ```bash
    npx wrangler r2 bucket create transit-bucket
    npx wrangler kv namespace create TRANSIT_KV
    ```
3.  **配置 `wrangler.jsonc`**:
    *   将 `kv_namespaces` 中的 `id` 替换为上面创建的 KV ID。
4.  **本地运行**: `npm run dev`
5.  **部署**: `npm run deploy`
    *   记得使用 `npx wrangler secret put ADMIN_PASSWORD` 设置生产环境密码。

## 🤝 贡献
欢迎提交 Issue 和 Pull Request！