import { attachmentDataUrl, pickPasteImageFiles } from '../logic.js';

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_COUNT = 10;

export function createAttachmentController(context, options = {}) {
  const {
    autoBind = true,
    addBar = () => {},
    createElement = null,
    haptic = () => {},
    onChange = () => {},
    scheduleInsetResettle = () => {},
  } = options;
  const dom = context.dom;
  const deps = context.dependencies;
  let pending = [];

  function items() { return pending.slice(); }

  function payload() {
    return pending.map(({ _id, ...rest }) => rest);
  }

  function notifyChange() {
    render();
    onChange(items());
  }

  function setItems(next) {
    pending = Array.isArray(next) ? next.slice() : [];
    notifyChange();
  }

  function clear() {
    pending = [];
    notifyChange();
  }

  function readBase64(file) {
    const FileReaderCtor = deps.FileReader || globalThis.FileReader;
    return new Promise((resolve, reject) => {
      const reader = new FileReaderCtor();
      reader.onload = () => {
        const value = String(reader.result);
        const comma = value.indexOf(',');
        resolve(comma >= 0 ? value.slice(comma + 1) : value);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function makeThumb(file) {
    return new Promise(resolve => {
      if (!file.type?.startsWith('image/')) return resolve(null);
      const URLApi = deps.URL || globalThis.URL;
      const ImageCtor = deps.Image || globalThis.Image;
      const doc = deps.document || globalThis.document;
      const url = URLApi.createObjectURL(file);
      const image = new ImageCtor();
      image.onload = () => {
        let width = image.width;
        let height = image.height;
        const max = 320;
        if (width > height && width > max) {
          height = Math.round(height * max / width);
          width = max;
        } else if (height >= width && height > max) {
          width = Math.round(width * max / height);
          height = max;
        }
        const canvas = doc.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(image, 0, 0, width, height);
        URLApi.revokeObjectURL(url);
        let output = null;
        try { output = canvas.toDataURL('image/jpeg', 0.6); } catch { /* optional preview */ }
        resolve(output);
      };
      image.onerror = () => {
        URLApi.revokeObjectURL(url);
        resolve(null);
      };
      image.src = url;
    });
  }

  async function addFiles(files) {
    const list = Array.isArray(files) ? files : [...(files || [])];
    for (const file of list) {
      if (!file) continue;
      if (pending.length >= MAX_COUNT) {
        addBar(`附件数量已达上限（${MAX_COUNT}）`, 'text-danger');
        break;
      }
      if (file.size > MAX_FILE) {
        addBar(`「${file.name || '附件'}」超过 10MB，未添加`, 'text-danger');
        continue;
      }
      const total = pending.reduce((sum, attachment) => sum + attachment.size, 0);
      if (total + file.size > MAX_TOTAL) {
        addBar('附件总量将超过 20MB，未添加', 'text-danger');
        break;
      }
      try {
        const [data, thumb] = await Promise.all([readBase64(file), makeThumb(file)]);
        const now = (deps.now || Date.now)();
        const random = (deps.random || Math.random)();
        const name = file.name?.trim()
          || `paste-${now}.${(file.type || '').split('/')[1] || 'png'}`;
        pending.push({
          _id: `${now}-${random.toString(36).slice(2)}`,
          name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          data,
          thumb: thumb && thumb.length < 100000 ? thumb : undefined,
        });
        notifyChange();
      } catch {
        addBar(`「${file.name || '附件'}」读取失败`, 'text-danger');
      }
    }
  }

  function closePreview() {
    if (!dom.attachPreviewModal) return;
    dom.attachPreviewModal.classList.add('hidden');
    dom.attachPreviewImg?.removeAttribute('src');
  }

  function openPreview(attachment) {
    const url = attachmentDataUrl(attachment);
    if (!url) {
      addBar(attachment?.name ? `「${attachment.name}」不是可预览图片` : '该附件不可预览', 'text-ink-faint');
      return;
    }
    if (!dom.attachPreviewModal || !dom.attachPreviewImg) return;
    dom.attachPreviewImg.src = url;
    if (dom.attachPreviewName) dom.attachPreviewName.textContent = attachment.name || '';
    dom.attachPreviewModal.classList.remove('hidden');
    haptic('tap');
  }

  function render() {
    const tray = dom.attachTray;
    if (!tray || !createElement) return;
    tray.innerHTML = '';
    if (!pending.length) {
      tray.classList.add('hidden');
      return;
    }
    for (const attachment of pending) {
      const chip = createElement('<div class="relative flex items-center gap-1.5 bg-sunk rounded-lg pl-1.5 pr-6 py-1 text-xs max-w-[10rem] cursor-pointer active:scale-[0.98] transition-transform" title="点击预览"></div>');
      if (attachment.thumb) {
        const image = createElement('<img class="w-8 h-8 rounded object-cover shrink-0">');
        image.src = attachment.thumb;
        chip.appendChild(image);
      } else {
        chip.appendChild(createElement('<span class="shrink-0">📎</span>'));
      }
      const name = createElement('<span class="truncate"></span>');
      name.textContent = attachment.name;
      chip.appendChild(name);
      const remove = createElement('<button type="button" class="absolute right-1 top-1/2 -translate-y-1/2 text-ink-faint active:text-danger" title="移除">✕</button>');
      remove.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        pending = pending.filter(item => item._id !== attachment._id);
        notifyChange();
      };
      chip.onclick = () => openPreview(attachment);
      chip.appendChild(remove);
      tray.appendChild(chip);
    }
    tray.classList.remove('hidden');
  }

  function bind() {
    const doc = deps.document || globalThis.document;
    if (dom.btnAttach && dom.fileInput) dom.btnAttach.onclick = () => dom.fileInput.click();
    if (dom.fileInput) {
      dom.fileInput.onchange = async () => {
        const files = [...dom.fileInput.files];
        dom.fileInput.value = '';
        scheduleInsetResettle();
        await addFiles(files);
      };
    }
    dom.input?.addEventListener('paste', event => {
      const images = pickPasteImageFiles(event.clipboardData);
      if (!images.length) return;
      event.preventDefault();
      void addFiles(images);
    });
    if (dom.attachPreviewClose) {
      dom.attachPreviewClose.onclick = event => {
        event.stopPropagation();
        closePreview();
      };
    }
    if (dom.attachPreviewModal) {
      dom.attachPreviewModal.onclick = event => {
        if (event.target === dom.attachPreviewModal || event.target === dom.attachPreviewName) closePreview();
      };
    }
    doc?.addEventListener('keydown', event => {
      if (event.key === 'Escape' && dom.attachPreviewModal && !dom.attachPreviewModal.classList.contains('hidden')) {
        closePreview();
      }
    });
  }

  if (autoBind) bind();
  return { addFiles, clear, closePreview, items, openPreview, payload, render, setItems };
}
