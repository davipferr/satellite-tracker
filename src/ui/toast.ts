/** Corner notification for loading progress, warnings and errors. */

export type ToastKind = 'loading' | 'warning' | 'error';

export function createToast(el: HTMLElement) {
  const msg = el.querySelector<HTMLElement>('.msg')!;
  const close = el.querySelector<HTMLButtonElement>('button')!;
  let timer: number | undefined;

  const hide = () => {
    clearTimeout(timer);
    el.hidden = true;
  };
  close.addEventListener('click', hide);

  return {
    /** Loading and error toasts stay until replaced or dismissed unless `autoHideMs` is given. */
    show(kind: ToastKind, text: string, autoHideMs?: number) {
      clearTimeout(timer);
      el.dataset.kind = kind;
      msg.textContent = text;
      close.hidden = kind === 'loading';
      el.hidden = false;
      if (autoHideMs) timer = window.setTimeout(hide, autoHideMs);
    },
    hide,
  };
}
