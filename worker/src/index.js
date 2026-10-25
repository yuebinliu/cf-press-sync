import { handleRequest } from './routes';

export default {
    async fetch(request, env, ctx) {
        const startTime = Date.now();
        try {
            const response = await handleRequest(request, env);
            response.headers.set('X-Response-Time', `${Date.now() - startTime}ms`);
            response.headers.set('X-Powered-By', 'CF-Static-Export-Pro');
            return response;
        } catch (error) {
            console.error('Worker error:', error);
            return new Response('Internal Server Error', {
                status: 500,
                headers: { 'Content-Type': 'text/plain' }
            });
        }
    }
};