# Cloudflare R2 Transit Station (文件中转站)

这是一个基于 Cloudflare Workers、R2 和 KV 构建的轻量级文件中转站。支持文件上传、下载、阅后即焚、下载次数限制、自动过期清理以及全局容量控制。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wyourname/cf-r2-transit-station)

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

## 🚀 快速部署

### 方案一：一键部署 (推荐)
点击上方的 **"Deploy to Cloudflare"** 按钮，按照提示：
1.  授权连接你的 GitHub 账号。
2.  按钮会自动为你 Fork 仓库并在 Cloudflare 中创建项目。
3.  它会引导你创建 KV Namespace 和 R2 Bucket 并在部署时自动绑定。

### 方案二：手动 GitHub 集成部署
如果你已经手动连接了仓库，请务必执行以下操作以防止配置被自动清除：

1.  **准备资源**: 创建好 KV Namespace (`TRANSIT_KV`) 和 R2 Bucket (`transit-bucket`)。
2.  **修改代码**: 在你 Fork 的 GitHub 仓库中，编辑 `wrangler.jsonc` 文件：
    *   填入你真实的 `kv_namespaces` 的 `id`。
    *   填入你真实的 `r2_buckets` 的 `bucket_name`。
3.  **保存提交**: 提交代码后，Cloudflare 会自动完成部署，且以后不会再清空你的配置。

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

#### 删除文件 (无需鉴权)
*   **接口**: `DELETE /niupanel/file/<token>`
*   **说明**: 只要知道 Token 即可删除文件。

### 2. 管理员接口 (Admin API)

所有管理员接口需携带 Header: `X-Admin-Auth: <你的ADMIN_PASSWORD>`。

#### 列出文件
*   **接口**: `GET /admin/files`
*   **参数**: `cursor` (分页), `limit` (默认 50)。
*   **响应**:
    ```json
    {
      "files": [
        {
          "token": "example",
          "fileKey": "example.npack",
          "size": 1024,
          "downloadsRemaining": -1,
          "deleteOnDownload": false,
          "expiresAt": 1735800000000,
          "password": "optional_pass"
        }
      ],
      "cursor": "next_page_cursor_or_null"
    }
    ```

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
*   **响应**:
    ```json
    {
      "token": "example",
      "fileKey": "example.npack",
      "size": 1024,
      "downloadsRemaining": -1,
      "deleteOnDownload": false,
      "expiresAt": 1735800000000,
      "password": "optional_pass"
    }
    ```

#### 管理员上传
*   **接口**: `POST /admin/files`
*   **参数**: 同公开上传接口 (`token`, `expire` 等)。

#### 更新文件元数据
*   **接口**: `PATCH /admin/files/<token>` (或 `PUT`)
*   **说明**: 仅用于更新文件属性（过期时间、下载限制等）。
*   **Body** (JSON):
    ```json
    {
      "downloadsRemaining": 100,
      "deleteOnDownload": false,
      "expiresAt": 1735800000000,
      "password": "newpassword"
    }
    ```

> **提示**: 如果需要更新**文件内容本身**，请直接调用 **管理员上传接口** 并使用相同的 `token`，系统会自动覆盖原有文件及元数据。

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