export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) headers.set('Content-Type', 'application/json');

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers,
      signal: options.signal || controller.signal
    });

    const text = await res.text();
    let data: any = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const message =
        data.error ||
        data.message ||
        (res.status === 401 ? '登录已失效，请重新登录' : `请求失败：${res.status}`);
      throw new Error(message);
    }

    return data as T;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error('请求超时，请检查网络、域名解析或反向代理。');
    }
    if (err instanceof TypeError) {
      throw new Error('连接面板失败，请检查网络或反向代理配置。');
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
}
