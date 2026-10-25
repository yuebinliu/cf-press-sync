/**
 * R2存储操作
 */

export async function getFromR2(bucket, path) {
    try {
        const object = await bucket.get(path);
        if (!object) return null;
        const contentType = object.httpMetadata?.contentType || 'application/octet-stream';
        const body = await object.arrayBuffer();
        return { body, contentType };
    } catch (error) {
        console.error(`R2读取失败: ${path}`, error);
        return null;
    }
}

export async function uploadToR2(bucket, path, content, contentType = 'text/html') {
    try {
        await bucket.put(path, content, {
            httpMetadata: { contentType, cacheControl: 'public, max-age=3600' }
        });
        return true;
    } catch (error) {
        console.error(`R2上传失败: ${path}`, error);
        return false;
    }
}

export async function deleteFromR2(bucket, path) {
    try {
        await bucket.delete(path);
        return true;
    } catch (error) {
        console.error(`R2删除失败: ${path}`, error);
        return false;
    }
}