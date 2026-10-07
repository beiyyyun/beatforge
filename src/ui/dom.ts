/** DOM 工具函数 */

/** 创建元素 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('data-') || k === 'role') node.setAttribute(k, v);
    else if (k === 'value' && node instanceof HTMLInputElement) node.value = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    node.append(c);
  }
  return node;
}

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const node = root.querySelector(sel);
  if (!node) throw new Error(`元素未找到: ${sel}`);
  return node as T;
}

export function $$<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll(sel)) as T[];
}

/** 清空并填充 */
export function render<T extends HTMLElement>(target: T, content: Node | string) {
  target.replaceChildren(content);
}

/** 数值范围限制 */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 创建滑块 */
export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  onInput: (value: number) => void;
  /** 双击复位值 */
  resetValue?: number;
}

export function slider(opts: SliderOptions): HTMLElement {
  const wrap = el('div', { class: 'ctrl' });
  const head = el('div', { class: 'ctrl-head' });
  const label = el('span', { class: 'ctrl-label' }, opts.label);
  const value = el('span', { class: 'ctrl-value' }, formatValue(opts.value, opts.unit));
  head.append(label, value);

  const input = el('input', {
    type: 'range',
    class: 'ctrl-range',
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step),
    value: String(opts.value),
  }) as HTMLInputElement;

  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    value.textContent = formatValue(v, opts.unit);
    opts.onInput(v);
  });

  if (opts.resetValue !== undefined) {
    input.addEventListener('dblclick', () => {
      input.value = String(opts.resetValue);
      const v = parseFloat(input.value);
      value.textContent = formatValue(v, opts.unit);
      opts.onInput(v);
    });
    input.title = `双击复位到 ${formatValue(opts.resetValue, opts.unit)}`;
  }

  wrap.append(head, input);
  return wrap;
}

function formatValue(v: number, unit?: string): string {
  if (unit === '%') return `${Math.round(v * 100)}%`;
  if (unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
  if (unit === 'ms') return `${Math.round(v * 1000)}`;
  if (unit === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
  if (Math.abs(v) < 10) return v.toFixed(2);
  return String(Math.round(v));
}

/** 下拉选择 */
export function dropdown(
  label: string,
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const wrap = el('div', { class: 'ctrl' });
  wrap.append(el('div', { class: 'ctrl-head' }, el('span', { class: 'ctrl-label' }, label)));
  const sel = el('select', { class: 'ctrl-select' }) as HTMLSelectElement;
  for (const o of options) {
    const opt = el('option', { value: o.value }, o.label) as HTMLOptionElement;
    if (o.value === value) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  wrap.append(sel);
  return wrap;
}

/** 复选框 */
export function checkbox(
  label: string,
  checked: boolean,
  onChange: (v: boolean) => void,
): HTMLElement {
  const wrap = el('label', { class: 'ctrl-check' });
  const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.append(input, el('span', {}, label));
  return wrap;
}

/** 分段按钮组 */
export function segmented<T extends string>(
  items: Array<{ value: T; label: string; title?: string }>,
  value: T,
  onChange: (v: T) => void,
): HTMLElement {
  const wrap = el('div', { class: 'seg' });
  for (const item of items) {
    const btn = el(
      'button',
      {
        class: `seg-btn${item.value === value ? ' is-active' : ''}`,
        type: 'button',
        ...(item.title ? { title: item.title } : {}),
      },
      item.label,
    );
    btn.addEventListener('click', () => onChange(item.value));
    wrap.append(btn);
  }
  return wrap;
}

/** 模态对话框 */
export function modal(
  title: string,
  body: Node,
  actions: Array<{ label: string; primary?: boolean; onClick: (close: () => void) => void }>,
): () => void {
  const overlay = el('div', { class: 'modal-overlay' });
  const box = el('div', { class: 'modal' });
  const head = el('div', { class: 'modal-head' }, el('h3', {}, title));
  const bodyWrap = el('div', { class: 'modal-body' }, body);
  const foot = el('div', { class: 'modal-foot' });

  const close = () => {
    overlay.classList.add('is-closing');
    setTimeout(() => overlay.remove(), 160);
  };

  for (const a of actions) {
    const btn = el(
      'button',
      { class: `btn${a.primary ? ' btn-primary' : ''}`, type: 'button' },
      a.label,
    );
    btn.addEventListener('click', () => a.onClick(close));
    foot.append(btn);
  }

  box.append(head, bodyWrap, foot);
  overlay.append(box);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  document.body.append(overlay);
  return close;
}

/** 轻提示 */
let toastTimer: number | null = null;
export function toast(message: string, duration = 2200) {
  const existing = document.querySelector('.toast');
  existing?.remove();
  if (toastTimer) clearTimeout(toastTimer);

  const node = el('div', { class: 'toast' }, message);
  document.body.append(node);
  toastTimer = window.setTimeout(() => {
    node.classList.add('is-closing');
    setTimeout(() => node.remove(), 200);
  }, duration);
}

/** 格式化拍号位置：步 → "小节.拍" */
export function stepToBars(step: number, gridSteps: number): string {
  const stepsPerBar = gridSteps * 4;
  const bar = Math.floor(step / stepsPerBar) + 1;
  const beat = Math.floor((step % stepsPerBar) / gridSteps) + 1;
  return `${bar}.${beat}`;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}