import { Hono } from 'hono'
import * as v from 'valibot'

interface Env {
  BUCKET: R2Bucket;
  KV: KVNamespace;
  ADMIN_PASSWORD?: string;
  MAX_STORAGE_GB?: string;
  MAX_FILE_SIZE_MB?: string;
  DEFAULT_EXPIRE_HOURS?: string;
}

const app = new Hono<{ Bindings: Env }>()

// Helper to get environment variables with defaults
const getConfig = (env: Env) => {
  const MAX_STORAGE_BYTES = parseInt(env.MAX_STORAGE_GB || "9", 10) * 1024 * 1024 * 1024; // Default 9GB
  const MAX_FILE_SIZE_BYTES = parseInt(env.MAX_FILE_SIZE_MB || "300", 10) * 1024 * 1024; // Default 300MB
  const DEFAULT_EXPIRE_HOURS = parseInt(env.DEFAULT_EXPIRE_HOURS || "24", 10);
  return { MAX_STORAGE_BYTES, MAX_FILE_SIZE_BYTES, DEFAULT_EXPIRE_HOURS };
}

interface FileMetadata {
  size: number;
  downloadsRemaining: number; // -1 for unlimited
  deleteOnDownload: boolean;
  expiresAt: number; // Unix timestamp in milliseconds
  password?: string;
  note?: string;
}

// Schemas
const UploadQuerySchema = v.object({
  token: v.string(),
  expire: v.optional(v.string()),
  burn: v.optional(v.string()),
  limit: v.optional(v.string()),
  password: v.optional(v.string()),
  note: v.optional(v.string()),
});

const UpdateMetadataSchema = v.partial(v.object({
  downloadsRemaining: v.number(),
  deleteOnDownload: v.boolean(),
  expiresAt: v.number(),
  password: v.string(),
  note: v.string()
}));

// Add global error handler
app.onError((err, c) => {
  console.error(`${err}`);
  return c.text('Internal Server Error', 500);
})

// --- Admin Handlers ---

const adminApp = new Hono<{ Bindings: Env }>()

// Admin Auth Middleware
adminApp.use('*', async (c, next) => {
  const adminPassword = c.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return c.text('Admin access not configured', 403);
  }
  const authHeader = c.req.header("X-Admin-Auth");
  if (authHeader !== adminPassword) {
    return c.text('Unauthorized', 401);
  }
  await next();
});

adminApp.get('/files', async (c) => {
  const cursor = c.req.query("cursor") || undefined;
  const limitParam = parseInt(c.req.query("limit") || "50", 10);
  const limit = isNaN(limitParam) ? 50 : Math.min(1000, Math.max(1, limitParam));

  const kvList = await c.env.KV.list({ prefix: "meta:", cursor, limit });

  const files = [];
  for (const key of kvList.keys) {
    const metadataStr = await c.env.KV.get(key.name);
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

  return c.json({
    files,
    cursor: kvList.list_complete ? null : kvList.cursor
  });
});

adminApp.get('/stats', async (c) => {
  const config = getConfig(c.env);
  const currentUsageStr = await c.env.KV.get("stats:total_usage");
  const currentUsage = Number(currentUsageStr || 0);

  return c.json({
    currentUsageBytes: currentUsage,
    maxUsageBytes: config.MAX_STORAGE_BYTES,
    usagePercent: ((currentUsage / config.MAX_STORAGE_BYTES) * 100).toFixed(2) + "%",
    maxFileSizeContent: config.MAX_FILE_SIZE_BYTES
  });
});

adminApp.get('/files/:token', async (c) => {
  const token = c.req.param('token');
  const fileKey = `${token}.npack`;
  const metadataStr = await c.env.KV.get(`meta:${fileKey}`);

  if (!metadataStr) {
    return c.json({ error: "File not found" }, 404);
  }

  const metadata = JSON.parse(metadataStr);
  return c.json({
    token,
    fileKey,
    ...metadata
  });
});

adminApp.post('/files', async (c) => {
  return handleUpload(c);
});

// Update File Metadata (PUT/PATCH)
const handleUpdateMetadata = async (c: any) => {
  const token = c.req.param('token');
  const fileKey = `${token}.npack`;
  const metadataStr = await c.env.KV.get(`meta:${fileKey}`);

  if (!metadataStr) {
    return c.json({ error: "File not found" }, 404);
  }

  let metadata: FileMetadata = JSON.parse(metadataStr);

  try {
    const body = await c.req.json();
    const updates = v.parse(UpdateMetadataSchema, body);

    metadata = { ...metadata, ...updates };

    // Update in KV, maintaining potentially existing expiration TTL or setting a new one
    const ttl = Math.max(60, Math.floor((metadata.expiresAt - Date.now()) / 1000));
    await c.env.KV.put(`meta:${fileKey}`, JSON.stringify(metadata), { expirationTtl: ttl > 60 ? ttl : undefined });

    return c.json({
      token,
      fileKey,
      ...metadata
    });

  } catch (e) {
    if (e instanceof v.ValiError) {
      return c.json({ error: "Invalid JSON body", issues: e.issues }, 400);
    }
    return c.json({ error: "Invalid JSON body" }, 400);
  }
};

adminApp.put('/files/:token', handleUpdateMetadata);
adminApp.patch('/files/:token', handleUpdateMetadata);


adminApp.delete('/files/:token', async (c) => {
  const token = c.req.param('token');
  const fileKey = `${token}.npack`;
  return handleDelete(c.env, fileKey);
});

adminApp.delete('/purge', async (c) => {
  let cursor: string | undefined = undefined;
  let deletedCount = 0;

  do {
    const kvList: KVNamespaceListResult<unknown> = await c.env.KV.list({ prefix: "meta:", cursor });
    cursor = kvList.list_complete ? undefined : kvList.cursor;

    for (const key of kvList.keys) {
      const fileKey = key.name.replace("meta:", "");
      await c.env.BUCKET.delete(fileKey);
      await c.env.KV.delete(key.name);
      deletedCount++;
    }
  } while (cursor);

  await c.env.KV.put("stats:total_usage", "0");
  return c.json({ message: `Purged ${deletedCount} files and reset stats.` }, 200);
});

app.route('/admin', adminApp);

// --- Public Endpoints ---

// Upload Endpoint
app.put('/niupanel/upload', async (c) => {
  return handleUpload(c);
});

// Download Endpoint
app.get('/share/:token', async (c) => {
  const token = c.req.param('token');
  const fileKey = `${token}.npack`;
  const metadataStr = await c.env.KV.get(`meta:${fileKey}`);

  if (!metadataStr) {
    return c.text("File not found or expired", 404);
  }

  const metadata: FileMetadata = JSON.parse(metadataStr);

  // Check expiration (Fallback in case KV TTL didn't trigger immediately)
  if (Date.now() > metadata.expiresAt) {
    c.executionCtx.waitUntil(deleteFile(c.env, fileKey, metadata.size));
    return c.text("File expired", 410);
  }

  // Check password
  if (metadata.password) {
    const providedPassword = c.req.header("X-Share-Password");
    if (providedPassword !== metadata.password) {
      return c.text("Unauthorized: Password required", 401);
    }
  }

  // Check download limits
  if (metadata.downloadsRemaining === 0) {
    c.executionCtx.waitUntil(deleteFile(c.env, fileKey, metadata.size));
    return c.text("Download limit reached", 410);
  }

  // Get file from R2
  const object = await c.env.BUCKET.get(fileKey);
  if (!object) {
    c.executionCtx.waitUntil(c.env.KV.delete(`meta:${fileKey}`));
    return c.text("File not found in storage", 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Content-Disposition", `attachment; filename="${fileKey}"`);

  c.executionCtx.waitUntil((async () => {
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
      await deleteFile(c.env, fileKey, newMetadata.size);
    } else {
      const ttl = Math.max(60, Math.floor((newMetadata.expiresAt - Date.now()) / 1000));
      await c.env.KV.put(`meta:${fileKey}`, JSON.stringify(newMetadata), { expirationTtl: ttl > 60 ? ttl : undefined });
    }
  })());

  return new Response(object.body, { headers });
});

// Delete Endpoint (Legacy/Optional helper)
app.delete('/niupanel/file/:token', async (c) => {
  const token = c.req.param('token');
  const fileKey = `${token}.npack`;
  return handleDelete(c.env, fileKey);
});


// --- Helper Functions ---

async function handleUpload(c: any) {
  const config = getConfig(c.env);
  const query = c.req.query();

  let params;
  try {
    params = v.parse(UploadQuerySchema, query);
  } catch (e) {
    return c.text(`Invalid query parameters: ${(e as any).message}`, 400);
  }

  const token = params.token;
  const fileKey = `${token}.npack`;
  const contentLength = Number(c.req.header("content-length"));

  if (!contentLength) {
    return c.text("Length Required", 411);
  }

  if (contentLength > config.MAX_FILE_SIZE_BYTES) {
    return c.text(`File too large. Max allowed: ${config.MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`, 413);
  }

  const currentUsageStr = await c.env.KV.get("stats:total_usage");
  const currentUsage = Number(currentUsageStr || 0);

  if (currentUsage + contentLength > config.MAX_STORAGE_BYTES) {
    return c.text(`Storage limit exceeded (${config.MAX_STORAGE_BYTES / 1024 / 1024 / 1024}GB max)`, 507);
  }

  // Parse options
  const deleteOnDownload = params.burn === "true";
  const password = params.password || undefined;
  const note = params.note || undefined;

  let downloadsRemaining = -1;
  if (params.limit) {
    downloadsRemaining = parseInt(params.limit, 10);
  } else if (deleteOnDownload) {
    downloadsRemaining = 1;
  }

  const expireHours = params.expire ? parseInt(params.expire, 10) : config.DEFAULT_EXPIRE_HOURS;
  const expiresAt = Date.now() + expireHours * 3600 * 1000;

  // Use KV expiration logic natively. Ensure at least 60 seconds TTL for KV.
  const ttlSeconds = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000));

  await c.env.BUCKET.put(fileKey, c.req.raw.body);

  const metadata: FileMetadata = {
    size: contentLength,
    downloadsRemaining,
    deleteOnDownload,
    expiresAt,
    password,
    note,
  };

  await c.env.KV.put(`meta:${fileKey}`, JSON.stringify(metadata), { expirationTtl: ttlSeconds });

  await c.env.KV.put("stats:total_usage", (currentUsage + contentLength).toString());

  return c.text(`File uploaded. Token: ${token}, Key: ${fileKey}, Expires in: ${expireHours} hours`, 200);
}

async function handleDelete(env: Env, key: string): Promise<Response> {
  const metadataStr = await env.KV.get(`meta:${key}`);
  if (metadataStr) {
    const metadata: FileMetadata = JSON.parse(metadataStr);
    await deleteFile(env, key, metadata.size);
    return new Response("Deleted", { status: 200 });
  } else {
    await env.BUCKET.delete(key);
    return new Response("File not found, but cleanup attempted", { status: 404 });
  }
}

async function recalibrateStorage(env: Env) {
  let totalBytes = 0;
  let cursor: string | undefined = undefined;

  console.log("Starting daily R2 storage recalibration...");

  try {
    do {
      const objects = await env.BUCKET.list({ cursor });
      for (const object of objects.objects) {
        totalBytes += object.size;
      }
      cursor = objects.truncated ? objects.cursor : undefined;
    } while (cursor);

    await env.KV.put("stats:total_usage", totalBytes.toString());
    console.log(`Recalibration complete. Total R2 usage synced to KV: ${totalBytes} bytes.`);
  } catch (error) {
    console.error("Storage recalibration failed:", error);
  }
}

async function deleteFile(env: Env, key: string, size: number) {
  await env.BUCKET.delete(key);
  await env.KV.delete(`meta:${key}`);

  const currentUsageStr = await env.KV.get("stats:total_usage");
  const currentUsage = Number(currentUsageStr || 0);
  const newUsage = Math.max(0, currentUsage - size);
  await env.KV.put("stats:total_usage", newUsage.toString());
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Run real-time compensation sync daily to fix any KV Race Conditions
    ctx.waitUntil(recalibrateStorage(env));
  }
};