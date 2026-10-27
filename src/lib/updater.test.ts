import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createUpdaterController,
  isTrustedSender,
  normalizeNotes,
} = require('../../electron/updater.js');
const { stopServerProcess } = require('../../electron/server-lifecycle.js');

/** 创建可控 updater，测试无需 Electron 或网络。@param supported 是否安装版 */
function setup(supported = true) {
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async (): Promise<unknown> => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
  });
  const stopServer = vi.fn(async (): Promise<void> => undefined);
  const onInstallError = vi.fn();
  const broadcast = vi.fn();
  const controller = createUpdaterController({
    autoUpdater: updater,
    supported,
    currentVersion: '2.19.8',
    broadcast,
    logger: { error: vi.fn() },
    stopServer,
    beforeInstall: vi.fn(),
    onInstallError,
  });
  return { updater, controller, stopServer, onInstallError, broadcast };
}

/** 发布新版本事件。@param updater 模拟更新器 */
function available(updater: EventEmitter) {
  updater.emit('update-available', { version: '2.19.9', releaseNotes: '修复播放问题' });
}

describe('桌面更新状态机', () => {
  it('开发/解包环境不检查，也不接受下载或安装', async () => {
    const { controller, updater } = setup(false);
    expect(controller.getState().status).toBe('unsupported');
    expect(await controller.check()).toEqual({ ok: false });
    expect(await controller.download()).toEqual({ ok: false });
    expect(await controller.install()).toEqual({ ok: false });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('禁用退出自动安装、预发布和降级', () => {
    const { updater } = setup();
    expect(updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      allowDowngrade: false,
    });
  });

  it('启动检查静默，错误事件与 promise rejection 不重复广播', async () => {
    const { controller, updater, broadcast } = setup();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('error', new Error('secret/path'));
      throw new Error('secret/path');
    });
    expect(await controller.check(false)).toEqual({ ok: false });
    expect(controller.getState()).toMatchObject({ status: 'error', manual: false });
    expect(controller.getState().message).not.toContain('secret/path');
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('合并重复检查，允许手动请求提升提示级别', async () => {
    const { controller, updater } = setup();
    let finish!: () => void;
    updater.checkForUpdates.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const pending = controller.check(false);
    await controller.check(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(controller.getState().manual).toBe(true);
    updater.emit('update-not-available');
    finish();
    await pending;
    expect(controller.getState().status).toBe('not-available');
  });

  it('下载状态立即生效，重复点击不会启动第二次下载', async () => {
    const { controller, updater } = setup();
    available(updater);
    const pending = controller.download();
    expect(await controller.download()).toEqual({ ok: false });
    await controller.check();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    updater.emit('download-progress', { percent: 125, bytesPerSecond: -10 });
    expect(controller.getState()).toMatchObject({ percent: 100, bytesPerSecond: 0 });
    updater.emit('update-downloaded', { version: '2.19.9' });
    await pending;
    expect(controller.getState().status).toBe('downloaded');
  });

  it('仅下载完成才可安装，并且先等待服务 exit', async () => {
    const { controller, updater, stopServer } = setup();
    expect(await controller.install()).toEqual({ ok: false });
    updater.emit('update-downloaded', { version: '2.19.9' });
    let finish!: () => void;
    stopServer.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const pending = controller.install();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(await controller.install()).toEqual({ ok: false });
    finish();
    await pending;
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('服务退出失败时取消安装，不退出仍在运行的应用', async () => {
    const { controller, updater, stopServer, onInstallError } = setup();
    updater.emit('update-downloaded', { version: '2.19.9' });
    stopServer.mockRejectedValue(new Error('timeout'));
    expect(await controller.install()).toEqual({ ok: false });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(onInstallError).not.toHaveBeenCalled();
    expect(controller.getState().status).toBe('error');
  });

  it('服务停止后安装器启动错误通知主进程退出恢复', async () => {
    const { controller, updater, onInstallError } = setup();
    updater.emit('update-downloaded', { version: '2.19.9' });
    updater.quitAndInstall.mockImplementation(() =>
      updater.emit('error', new Error('spawn failed'))
    );
    expect(await controller.install()).toEqual({ ok: false });
    expect(onInstallError).toHaveBeenCalledOnce();
  });

  it('检查结果只暴露普通对象；不传播 updater 内部实例', async () => {
    const { controller, updater } = setup();
    updater.checkForUpdates.mockImplementation(async () => {
      available(updater);
      return { cancellationToken: new EventEmitter(), downloadPromise: Promise.resolve() };
    });
    expect(await controller.check()).toEqual({ ok: true });
    expect(structuredClone(controller.getState())).toMatchObject({
      status: 'available',
      version: '2.19.9',
    });
  });

  it('说明支持字符串、数组和空值，不执行 HTML', () => {
    expect(normalizeNotes([{ version: '2.19.9', note: '<b>说明</b>' }])).toContain('<b>说明</b>');
    expect(normalizeNotes(null)).toBe('');
    expect(normalizeNotes('a'.repeat(30000))).toHaveLength(20000);
  });
});

describe('更新 IPC 发送者验证', () => {
  it('仅允许主窗口同源顶层 frame', () => {
    const frame = { url: 'http://127.0.0.1:8080/watch?id=1' };
    const contents = { mainFrame: frame };
    const window = { isDestroyed: () => false, webContents: contents };
    const event = { sender: contents, senderFrame: frame };
    expect(isTrustedSender(event, window, 'http://127.0.0.1:8080')).toBe(true);
    expect(isTrustedSender({ ...event, sender: {} }, window, 'http://127.0.0.1:8080')).toBe(false);
    expect(
      isTrustedSender({ ...event, senderFrame: { ...frame } }, window, 'http://127.0.0.1:8080')
    ).toBe(false);
    frame.url = 'https://example.com';
    expect(isTrustedSender(event, window, 'http://127.0.0.1:8080')).toBe(false);
    expect(isTrustedSender(event, null, 'http://127.0.0.1:8080')).toBe(false);
  });
});

describe('安装前停止 standalone', () => {
  it('必须等到退出事件，不把 kill 调用当作退出完成', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    let finished = false;
    const pending = stopServerProcess(child).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    child.emit('exit', 0);
    await pending;
    expect(finished).toBe(true);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('超时拒绝并清理监听器', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        kill: () => true,
      });
      const pending = expect(stopServerProcess(child, 100)).rejects.toThrow('超时');
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(child.listenerCount('exit')).toBe(0);
      expect(child.listenerCount('error')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('已退出时直接返回；kill 失败不继续安装', async () => {
    await expect(stopServerProcess(null)).resolves.toBeUndefined();
    await expect(stopServerProcess({ exitCode: 0 })).resolves.toBeUndefined();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: () => false,
    });
    await expect(stopServerProcess(child)).rejects.toThrow('无法停止');
  });
});
