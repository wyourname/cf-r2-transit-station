interface Env {
  BUCKET: R2Bucket;
  KV: KVNamespace;
  ADMIN_PASSWORD?: string;
}

const MAX_STORAGE_BYTES = 9 * 1024 * 1024 * 1024; // 9GB
const MAX_FILE_SIZE_BYTES = 300 * 1024 * 1024; // 300MB
const DEFAULT_EXPIRE_HOURS = 24;

interface FileMetadata {
  size: number;
  downloadsRemaining: number; // -1 for unlimited
  deleteOnDownload: boolean;
  expiresAt: number; // Unix timestamp in milliseconds
  password?: string;
  note?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Admin API
    if (path.startsWith("/admin/")) {
      return handleAdminRequest(request, env, ctx);
    }

    // Upload Endpoint: PUT /niupanel/upload
    if (request.method === "PUT" && path === "/niupanel/upload") {
      return handleUpload(request, env, url.searchParams);
    } 
    
    // Download Endpoint: GET /share/<token>
    if (request.method === "GET" && path.startsWith("/share/")) {
      const token = path.slice(7); // Remove "/share/"
      if (!token) {
        return new Response("Token required", { status: 400 });
      }
      return handleDownload(request, env, ctx, token);
    }

    // Delete Endpoint: DELETE /niupanel/file/<token> (Legacy/Optional helper)
    if (request.method === "DELETE" && path.startsWith("/niupanel/file/")) {
       const token = path.slice(15); // Remove "/niupanel/file/"
       if (!token) return new Response("Token required", { status: 400 });
       const fileKey = `${token}.npack`;
       return handleDelete(env, fileKey);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCleanup(env));
  },
};

// --- Admin Handlers ---

async function handleAdminRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = request.headers.get("X-Admin-Auth");
  if (!env.ADMIN_PASSWORD || auth !== env.ADMIN_PASSWORD) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  // Robust path handling
  let subPath = url.pathname.replace(/^\/admin/, "");
  if (!subPath.startsWith("/")) subPath = "/" + subPath;

  // 1. List Files: GET /admin/files
  if (request.method === "GET" && (subPath === "/files" || subPath === "/files/")) {
      return handleAdminListFiles(request, env);
  }

  // 2. Add/Upload File: POST /admin/files
  if (request.method === "POST" && (subPath === "/files" || subPath === "/files/")) {
      return handleUpload(request, env, url.searchParams);
  }

  // 3. Purge All: DELETE /admin/purge
  if (request.method === "DELETE" && subPath === "/purge") {
      return purgeAllFiles(env);
  }

  // 4. Get Stats: GET /admin/stats
  if (request.method === "GET" && (subPath === "/stats" || subPath === "/stats/")) {
      return handleAdminGetStats(env);
  }

  // File Specific Operations: /admin/files/<token>
  const fileMatch = subPath.match(/^\/files\/([^\/]+)$/);
  if (fileMatch) {
      const token = fileMatch[1];

      // 4. Get File Info: GET /admin/files/<token>
      if (request.method === "GET") {
          return handleAdminGetFile(env, token);
      }

      // 5. Update File: PUT/PATCH /admin/files/<token>
      if (request.method === "PUT" || request.method === "PATCH") {
          return handleAdminUpdateFile(request, env, token);
      }

      // 6. Delete File: DELETE /admin/files/<token>
      if (request.method === "DELETE") {
           const fileKey = `${token}.npack`;
           return handleDelete(env, fileKey);
      }
  }

  return new Response("Admin Endpoint Not Found", { status: 404 });
}

async function handleAdminListFiles(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor") || undefined;
    const limitParam = parseInt(url.searchParams.get("limit") || "50");
    const limit = isNaN(limitParam) ? 50 : Math.min(1000, Math.max(1, limitParam));

    const kvList: KVNamespaceListResult<unknown> = await env.KV.list({ prefix: "meta:", cursor, limit });
    
    const files = [];
    for (const key of kvList.keys) {
        const metadataStr = await env.KV.get(key.name);
        if (metadataStr) {
            try {
                const metadata = JSON.parse(metadataStr);
                const fileKey = key.name.replace("meta:", "");
                const token = fileKey.replace(".npack", "");
                files.push({
                    token,
                    fileKey,
                    ...metadata
                });
            } catch (e) {
                // Ignore malformed entries
            }
        }
    }

    return new Response(JSON.stringify({
        files,
        cursor: kvList.list_complete ? null : kvList.cursor
    }), {
        headers: { "Content-Type": "application/json" }
    });
}

async function handleAdminGetFile(env: Env, token: string): Promise<Response> {
    const fileKey = `${token}.npack`;
    const metadataStr = await env.KV.get(`meta:${fileKey}`);
    
    if (!metadataStr) {
        return new Response(JSON.stringify({ error: "File not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }

    const metadata = JSON.parse(metadataStr);
    return new Response(JSON.stringify({
        token,
        fileKey,
        ...metadata
    }), {
        headers: { "Content-Type": "application/json" }
    });
}

async function handleAdminUpdateFile(request: Request, env: Env, token: string): Promise<Response> {
    const fileKey = `${token}.npack`;
    const metadataStr = await env.KV.get(`meta:${fileKey}`);
    
    if (!metadataStr) {
        return new Response(JSON.stringify({ error: "File not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }

    let metadata: FileMetadata = JSON.parse(metadataStr);
    try {
        const updates = await request.json() as any;

        if (typeof updates.downloadsRemaining === 'number') metadata.downloadsRemaining = updates.downloadsRemaining;
        if (typeof updates.deleteOnDownload === 'boolean') metadata.deleteOnDownload = updates.deleteOnDownload;
        if (typeof updates.expiresAt === 'number') metadata.expiresAt = updates.expiresAt;
        if (updates.password !== undefined) metadata.password = updates.password;
        if (updates.note !== undefined) metadata.note = updates.note;

        await env.KV.put(`meta:${fileKey}`, JSON.stringify(metadata));

        return new Response(JSON.stringify({
            token,
            fileKey,
            ...metadata
        }), {
             headers: { "Content-Type": "application/json" }
        });

    } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
}

async function purgeAllFiles(env: Env): Promise<Response> {

    let cursor: string | undefined = undefined;

    let deletedCount = 0;



    do {

        const kvList: KVNamespaceListResult<unknown> = await env.KV.list({ prefix: "meta:", cursor });

        cursor = kvList.list_complete ? undefined : kvList.cursor;



        for (const key of kvList.keys) {

            const fileKey = key.name.replace("meta:", "");

            await env.BUCKET.delete(fileKey);

            await env.KV.delete(key.name);

            deletedCount++;

        }

    } while (cursor);



    await env.KV.put("stats:total_usage", "0");

    return new Response(JSON.stringify({ message: `Purged ${deletedCount} files and reset stats.` }), { status: 200, headers: { "Content-Type": "application/json" } });

}



async function handleAdminGetStats(env: Env): Promise<Response> {

    const currentUsageStr = await env.KV.get("stats:total_usage");

    const currentUsage = Number(currentUsageStr || 0);

    

    return new Response(JSON.stringify({

        currentUsageBytes: currentUsage,

        maxUsageBytes: MAX_STORAGE_BYTES,

        usagePercent: ((currentUsage / MAX_STORAGE_BYTES) * 100).toFixed(2) + "%",

        maxFileSizeContent: MAX_FILE_SIZE_BYTES

    }), {

        headers: { "Content-Type": "application/json" }

    });

}


// --- Existing Handlers ---

async function handleUpload(request: Request, env: Env, params: URLSearchParams): Promise<Response> {
  const token = params.get("token");
  if (!token) {
    return new Response("Missing 'token' query parameter", { status: 400 });
  }

  const fileKey = `${token}.npack`;
  const contentLength = Number(request.headers.get("content-length"));
  
  if (!contentLength) {
    return new Response("Length Required", { status: 411 });
  }

  if (contentLength > MAX_FILE_SIZE_BYTES) {
    return new Response(`File too large. Max allowed: 300MB`, { status: 413 });
  }

  // Check global storage usage
  const currentUsageStr = await env.KV.get("stats:total_usage");
  const currentUsage = Number(currentUsageStr || 0);

  if (currentUsage + contentLength > MAX_STORAGE_BYTES) {
    return new Response("Storage limit exceeded (9GB max)", { status: 507 });
  }

  // Parse options
  const deleteOnDownload = params.get("burn") === "true";
  const maxDownloadsParam = params.get("limit");
  const expireHoursParam = params.get("expire");
  const password = params.get("password") || undefined;
  const note = params.get("note") || undefined;

  let downloadsRemaining = -1;
  if (maxDownloadsParam) {
    downloadsRemaining = parseInt(maxDownloadsParam, 10);
  } else if (deleteOnDownload) {
    downloadsRemaining = 1;
  }

  const expireHours = expireHoursParam ? parseInt(expireHoursParam, 10) : DEFAULT_EXPIRE_HOURS;
  const expiresAt = Date.now() + expireHours * 3600 * 1000;

  // Save to R2
  await env.BUCKET.put(fileKey, request.body);

  // Save Metadata to KV
  const metadata: FileMetadata = {
    size: contentLength,
    downloadsRemaining,
    deleteOnDownload,
    expiresAt,
    password,
    note,
  };
  await env.KV.put(`meta:${fileKey}`, JSON.stringify(metadata));

  // Update Stats
  await env.KV.put("stats:total_usage", (currentUsage + contentLength).toString());

  return new Response(`File uploaded. Token: ${token}, Key: ${fileKey}, Expires in: ${expireHours} hours`, { status: 200 });
}

async function handleDownload(request: Request, env: Env, ctx: ExecutionContext, token: string): Promise<Response> {
  const fileKey = `${token}.npack`;
  const metadataStr = await env.KV.get(`meta:${fileKey}`);
  
  if (!metadataStr) {
    return new Response("File not found or expired", { status: 404 });
  }

  const metadata: FileMetadata = JSON.parse(metadataStr);

  // Check expiration
  if (Date.now() > metadata.expiresAt) {
    ctx.waitUntil(deleteFile(env, fileKey, metadata.size)); // Trigger async deletion
    return new Response("File expired", { status: 410 });
  }

  // Check password
  if (metadata.password) {
    const providedPassword = request.headers.get("X-Share-Password");
    if (providedPassword !== metadata.password) {
      return new Response("Unauthorized: Password required", { status: 401 });
    }
  }

  // Check download limits
  if (metadata.downloadsRemaining === 0) {
    ctx.waitUntil(deleteFile(env, fileKey, metadata.size));
    return new Response("Download limit reached", { status: 410 });
  }

  // Get file from R2
  const object = await env.BUCKET.get(fileKey);
  if (!object) {
    // Inconsistency: Metadata exists but file doesn't. Clean up metadata.
    ctx.waitUntil(env.KV.delete(`meta:${fileKey}`));
    return new Response("File not found in storage", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // Force filename to be <token>.npack
  headers.set("Content-Disposition", `attachment; filename="${fileKey}"`);

  // Handle download counting and deletion
  // We use waitUntil to not block the response
  ctx.waitUntil((async () => {
    let shouldDelete = false;
    let newMetadata = { ...metadata };

    if (newMetadata.downloadsRemaining > 0) {
        newMetadata.downloadsRemaining--;
        if (newMetadata.downloadsRemaining === 0) {
            shouldDelete = true;
        }
    }

    if (newMetadata.deleteOnDownload) {
        shouldDelete = true;
    }

    if (shouldDelete) {
        await deleteFile(env, fileKey, newMetadata.size);
    } else {
        // Update metadata with new count
        await env.KV.put(`meta:${fileKey}`, JSON.stringify(newMetadata));
    }
  })());

  return new Response(object.body, {
    headers,
  });
}

async function handleDelete(env: Env, key: string): Promise<Response> {
    const metadataStr = await env.KV.get(`meta:${key}`);
    if (metadataStr) {
        const metadata: FileMetadata = JSON.parse(metadataStr);
        await deleteFile(env, key, metadata.size);
        return new Response("Deleted", { status: 200 });
    } else {
        // Just try to delete from bucket to be safe
        await env.BUCKET.delete(key);
        return new Response("File not found, but cleanup attempted", { status: 404 });
    }
}

async function handleCleanup(env: Env) {
  let cursor: string | undefined = undefined;
  
  do {
    const kvList: KVNamespaceListResult<unknown>  = await env.KV.list({ prefix: "meta:", cursor });
    cursor = kvList.list_complete ? undefined : kvList.cursor;

    for (const key of kvList.keys) {
      const fileKey = key.name.replace("meta:", "");
      const metadataStr = await env.KV.get(key.name);
      
      if (!metadataStr) continue;

      try {
        const metadata: FileMetadata = JSON.parse(metadataStr);
        if (Date.now() > metadata.expiresAt) {
          await deleteFile(env, fileKey, metadata.size);
          console.log(`Cleaned up expired file: ${fileKey}`);
        }
      } catch (e) {
        console.error(`Error parsing metadata for ${fileKey}`, e);
      }
    }
  } while (cursor);
}

async function deleteFile(env: Env, key: string, size: number) {
  await env.BUCKET.delete(key);
  await env.KV.delete(`meta:${key}`);
  
  // Decrement usage
  const currentUsageStr = await env.KV.get("stats:total_usage");
  const currentUsage = Number(currentUsageStr || 0);
  const newUsage = Math.max(0, currentUsage - size);
  await env.KV.put("stats:total_usage", newUsage.toString());
}