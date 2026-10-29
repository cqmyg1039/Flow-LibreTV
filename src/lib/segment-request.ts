import type { CachedFragment } from './video-cache';

interface SharedRequest {
  controller: AbortController;
  promise: Promise<CachedFragment>;
  consumers: number;
}

const requests = new Map<string, SharedRequest>();

/** 每个消费者独享响应副本，防止播放器转移 ArrayBuffer 后破坏预取写入。
 * 等待共享下载；每个消费者独立取消，仅最后一个离开时中断底层网络。 */
function consume(request: SharedRequest, signal: AbortSignal): Promise<CachedFragment> {
  request.consumers += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      request.consumers -= 1;
      if (!request.consumers) request.controller.abort();
      action();
    };
    const cancel = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    signal.addEventListener('abort', cancel, { once: true });
    request.promise.then((value) => finish(() => resolve({ data: value.data.slice(0), costMs: value.costMs })), (error: unknown) => finish(() => reject(error)));
    if (signal.aborted) cancel();
  });
}

/** 以规范化分片 key 合并在途下载；producer 沿用各调用方的网络超时和重试策略。 */
export function shareSegmentRequest(
  key: string, signal: AbortSignal,
  producer: (signal: AbortSignal) => Promise<CachedFragment>,
): Promise<CachedFragment> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  let request = requests.get(key);
  if (!request || request.controller.signal.aborted) {
    const controller = new AbortController();
    request = { controller, consumers: 0, promise: Promise.resolve().then(() => producer(controller.signal)) };
    const created = request;
    requests.set(key, created);
    const cleanup = () => { if (requests.get(key) === created) requests.delete(key); };
    void created.promise.then(cleanup, cleanup);
  }
  return consume(request, signal);
}

/** 后台下载设置超时；入参为地址和共享信号，取消会同时终止响应体读取。 */
export async function fetchSegment(url: string, signal: AbortSignal): Promise<CachedFragment> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(cancel, 20_000);
  const start = performance.now();
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: '*/*' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { data: await response.arrayBuffer(), costMs: Math.max(1, performance.now() - start) };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}
