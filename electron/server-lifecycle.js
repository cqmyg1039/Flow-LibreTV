'use strict';

/** 停止 standalone 子进程，必须观察到 exit 后才允许安装。@param {ChildProcess | null} child 服务进程 @param {number} timeoutMs 超时时间 */
function stopServerProcess(child, timeoutMs = 10000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => onError(new Error('本地服务退出超时，已取消安装。')), timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
    try {
      if (!child.kill()) onError(new Error('无法停止本地服务，已取消安装。'));
    } catch (error) {
      onError(error);
    }
  });
}

module.exports = { stopServerProcess };
