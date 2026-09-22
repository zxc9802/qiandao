type CameraScanner = { start: () => Promise<void>; destroy: () => void };

export async function startCamera(scanner: CameraScanner, signal: AbortSignal, timeoutMs = 12000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    if (signal.aborted) throw new DOMException('相机开启已取消', 'AbortError');
    const deadline = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new DOMException('相机开启已取消', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new DOMException('相机开启超时', 'CameraTimeoutError')), timeoutMs);
    });
    await Promise.race([scanner.start(), deadline]);
  } catch (error) {
    scanner.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export function cameraErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'CameraTimeoutError') return '相机开启超时，浏览器尚未完成授权或加载画面。请检查系统和网站的相机权限后重试；也可使用相册识别或手机号核验。';
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return '相机访问被阻止。请在手机设置中允许浏览器使用相机，并在当前网站的权限中允许相机后重试。';
    if (error.name === 'NotReadableError' || error.name === 'AbortError') return '相机暂时无法使用。请关闭其他正在使用相机的应用或网页后重试。';
    if (error.message.startsWith('手机') || error.message.startsWith('当前浏览器')) return error.message;
  }
  return '浏览器未能打开相机。请检查系统和网站的相机权限，或使用相册识别、手机号核验。';
}
