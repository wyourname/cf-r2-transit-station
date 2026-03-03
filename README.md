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

## 🚀 极简部署指南 (小白必看)

本项目非常容易部署！哪怕你没有任何编程经验，跟着下面的三步走：

### 方案一：使用 GitHub 账号部署（最推荐）

> ⚠️ **重要提醒**：在点击下方按钮前，你**必须**先去 Cloudflare 控制面板手动创建好两个免费资源，否则部署会失败！
> 1. 去 **存储和数据库 -> R2对象存储 ->概述**：创建一个名为 `transit-bucket` 的存储桶。
> 2. 去 **存储和数据库 -> Workers KV -> Create Instance**：创建一个名为 `TRANSIT_KV` 的命名空间。

1. **准备好上面两项资源后，点击下方按钮**（如果打不开，请挂梯子）：
   [![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wyourname/cf-r2-transit-station)
2. **授权你的 GitHub**：页面会提示让你登录 GitHub 账号，这会在你的账号下自动 Fork（复制）一份这个代码库。
3. **绑定资源并部署**：在 Cloudflare 自动弹出的项目中，绑定页面下方`cf-r2-transit-station-github +绑定`  点击R2存储桶-添加绑定-变量名称`BUCKET` 选择`transit-bucket` 存储桶 同理 `TRANSIT_KV` 变量名称是`KV` 也是这样操作绑定到本项目，最后设置机密与变量 key是`ADMIN_PASSWORD` value是你要设置的密码，并完成首次部署！

---

### ⚙️ 个性化设置（修改密码和容量限制）

无论你怎么部署的，部署完成后，你需要进入 **Cloudflare 控制台 (Dash)** 去修改你的专属密码和限制：

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 在左侧菜单点击 **Workers 和 Pages**，找到你刚刚部署的项目（名字通常带有 `transit-station`）。
3. 点击进入项目 -> 选择上方的 **设置 (Settings)** -> 选择侧边的 **变量和机密 (Variables and Secrets)**。
4. 在 **明文变量 (Plain text vars)** 这里，点击 **添加**。你可以随意添加以下配置来定制你的中转站（没添加的就用默认值）：

| 变量名称 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `ADMIN_PASSWORD` | *(必填)* | **你的超级管理员密码**。前端面板和管理员 API 都要用它。 |
| `MAX_STORAGE_GB` | `9` | 中转站的全局最大容量（默认9GB，白嫖额度最高10G）。 |
| `MAX_FILE_SIZE_MB` | `300` | 允许单次上传的**最大单个文件**大小（兆）。 |
| `DEFAULT_EXPIRE_HOURS` | `24` | 别人上传文件后，默认保留多少小时后自动删除。 |

**修改完成后，记得点击右上角的 "部署 (Deploy)" 让新设置生效哦！**

---

### 方案二：如果你是手动部署的开发者

如果你已经手动 Fork 到了本地并打算用 `Wrangler CLI`：

1. **准备资源**: 使用命令创建 `npx wrangler kv namespace create TRANSIT_KV` 和 `npx wrangler r2 bucket create transit-bucket` 并在 `wrangler.jsonc` 中填入你的 ID。
2. **修改代码**: 在 `wrangler.jsonc` 底部，找到 `// "vars"` 注释将其打开，并填入你需要的 `ADMIN_PASSWORD` 以及其他限制配置。
3. **提交运行**: `npm run deploy` 一键上线！

## 🛠 API 使用说明

所有接口的基础 URL 为你的 Worker 地址 (例如 `https://your-worker.your-subdomain.workers.dev`)。

### 1. 全部接口

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
