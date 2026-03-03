import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from './index';

// Type definition for environment provided by cloudflare:test
interface Env {
    BUCKET: R2Bucket;
    KV: KVNamespace;
    ADMIN_PASSWORD?: string;
    MAX_STORAGE_GB?: string;
    MAX_FILE_SIZE_MB?: string;
    DEFAULT_EXPIRE_HOURS?: string;
}

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('cf-r2-transit-station API', () => {

    beforeEach(async () => {
        // Clean up KV and Bucket before each test
        // In vitest-pool-workers, we are using local memory storage
        const { keys } = await env.KV.list();
        for (const key of keys) {
            await env.KV.delete(key.name);
        }

        const r2List = await env.BUCKET.list();
        for (const object of r2List.objects) {
            await env.BUCKET.delete(object.key);
        }
    });

    describe('Admin API', () => {

        it('should reject requests without admin auth header', async () => {
            const request = new IncomingRequest('http://example.com/admin/stats', {
                method: 'GET',
            });
            const ctx = createExecutionContext();
            const response = await worker.fetch(request, env as Env, ctx);
            await waitOnExecutionContext(ctx);

            expect(response.status).toBe(403);
            expect(await response.text()).toBe('Admin access not configured');
        });

        it('should reject requests with invalid admin auth header', async () => {
            // In cloudflare:test we can override env or rely on vitest.config.mts vars
            const testEnv = { ...env, ADMIN_PASSWORD: "secret_admin" } as unknown as Env;

            const request = new IncomingRequest('http://example.com/admin/stats', {
                method: 'GET',
                headers: { 'X-Admin-Auth': 'wrong_password' }
            });
            const ctx = createExecutionContext();
            const response = await worker.fetch(request, testEnv, ctx);
            await waitOnExecutionContext(ctx);

            expect(response.status).toBe(401);
            expect(await response.text()).toBe('Unauthorized');
        });

        it('should return empty stats structure when authorized', async () => {
            const testEnv = { ...env, ADMIN_PASSWORD: "secret_admin" } as unknown as Env;

            const request = new IncomingRequest('http://example.com/admin/stats', {
                method: 'GET',
                headers: { 'X-Admin-Auth': 'secret_admin' }
            });
            const ctx = createExecutionContext();
            const response = await worker.fetch(request, testEnv, ctx);
            await waitOnExecutionContext(ctx);

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data).toHaveProperty('currentUsageBytes', 0);
            expect(data).toHaveProperty('usagePercent', '0.00%');
        });
    });

    describe('Public API', () => {
        it('should upload a file and return correct token', async () => {
            const request = new IncomingRequest('http://example.com/niupanel/upload?token=test1234', {
                method: 'PUT',
                headers: { 'Content-Length': '12' },
                body: 'Hello World!'
            });

            const ctx = createExecutionContext();
            const response = await worker.fetch(request, env as Env, ctx);
            await waitOnExecutionContext(ctx);

            expect(response.status).toBe(200);
            expect(await response.text()).toContain('test1234');
        });

        it('should fail to upload without content-length', async () => {
            const request = new IncomingRequest('http://example.com/niupanel/upload?token=test1234', {
                method: 'PUT'
            });

            const ctx = createExecutionContext();
            const response = await worker.fetch(request, env as Env, ctx);
            await waitOnExecutionContext(ctx);

            expect(response.status).toBe(411);
        });

        it('should download a previously uploaded file', async () => {
            // 1. Upload
            const uploadReq = new IncomingRequest('http://example.com/niupanel/upload?token=download-test', {
                method: 'PUT',
                headers: { 'Content-Length': '12' },
                body: 'Hello World!'
            });

            let ctx = createExecutionContext();
            await worker.fetch(uploadReq, env as Env, ctx);
            await waitOnExecutionContext(ctx);

            // 2. Download
            const request = new IncomingRequest('http://example.com/share/download-test', {
                method: 'GET'
            });
            ctx = createExecutionContext();
            const response = await worker.fetch(request, env as Env, ctx);
            await waitOnExecutionContext(ctx);

            expect(response.status).toBe(200);
            expect(await response.text()).toBe('Hello World!');
            expect(response.headers.get('Content-Disposition')).toContain('download-test.npack');
        });

        it('should enforce download limits and delete on download', async () => {
            // 1. Upload with limit=1 / burn=true
            const uploadReq = new IncomingRequest('http://example.com/niupanel/upload?token=burn-test&burn=true', {
                method: 'PUT',
                headers: { 'Content-Length': '12' },
                body: 'Hello World!'
            });

            let ctx = createExecutionContext();
            await worker.fetch(uploadReq, env as Env, ctx);
            await waitOnExecutionContext(ctx);

            // 2. Download first time (should succeed)
            let request = new IncomingRequest('http://example.com/share/burn-test', {
                method: 'GET'
            });
            ctx = createExecutionContext();
            let response = await worker.fetch(request, env as Env, ctx);
            await waitOnExecutionContext(ctx);

            expect(response.status).toBe(200);
            expect(await response.text()).toBe('Hello World!');

            // 3. Download second time (should fail as it was burned)
            request = new IncomingRequest('http://example.com/share/burn-test', {
                method: 'GET'
            });
            ctx = createExecutionContext();
            response = await worker.fetch(request, env as Env, ctx);
            await waitOnExecutionContext(ctx);

            expect(response.status).toBe(404);
        });
    });

});
